import { canonicalKey, type HostConfiguration } from '../shared/protocol';
import { createRelay } from '../relay/server';
import { Companion } from '../host/companion';
import { LocalStore } from './store';

export async function startPrivateHost(store: LocalStore, config: HostConfiguration, port = 9419, stopPrivateHost?: () => Promise<void>) {
  await store.machine(config.hostToken); // Refuse a mismatched or missing identity store.
  const relay = createRelay({ store, appleAudience: 'com.erikqu.workbenchremote', localPairingAuth: true, privateHost: true, cancelPairing: id => store.cancelPairing(id), stopPrivateHost, privateHostVersion: process.env.WORKBENCH_PHONE_VERSION });
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  const companion = new Companion({ ...config, relay: origin });
  const grants = store.grants.bind(store);
  store.grants = async machineId => {
    const devices = await grants(machineId);
    companion.config.approvedKeys = Object.fromEntries(devices.map(d => [d.id, canonicalKey(d.publicKey)]));
    return devices;
  };
  await store.grants(config.machineId);
  companion.start();
  return { origin, companion, relay, async close() { companion.close(); await relay.close(); store.grants = grants; } };
}
