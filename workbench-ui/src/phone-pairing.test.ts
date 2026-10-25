import { expect, test } from "bun:test";
import { type PhonePairingEvent, startPhonePairing } from "./phone-pairing";

test("pairing forwards QR and approval events, sends a code, and hides malformed private output", async () => {
  const events: PhonePairingEvent[] = [];
  const script = `console.log('private noise'); console.log(JSON.stringify({type:'qr',art:'QR',link:'private-link',expiresAt:Date.now()+300000})); console.log(JSON.stringify({type:'approval',device:'iPhone'})); process.stdin.once('data',data=>{ if(data.toString()==='123456\\n') console.log(JSON.stringify({type:'paired'})); process.exit(0); });`;
  const done = Promise.withResolvers<void>();
  const pairing = startPhonePairing(
    (event) => {
      events.push(event);
      if (event.type === "approval") {
        pairing.approve("123456");
      }
      if (event.type === "paired") {
        done.resolve();
      }
    },
    [process.execPath, "-e", script]
  );
  try {
    await done.promise;
    expect(events.map((event) => event.type)).toEqual([
      "qr",
      "approval",
      "paired",
    ]);
  } finally {
    pairing.close();
  }
});

test("closing pairing stops its process and suppresses later callbacks", async () => {
  const events: PhonePairingEvent[] = [];
  const pairing = startPhonePairing(
    (event) => events.push(event),
    [
      process.execPath,
      "-e",
      "setTimeout(()=>console.log(JSON.stringify({type:'paired'})),150);",
    ]
  );
  pairing.close();
  await Bun.sleep(200);
  expect(events).toEqual([]);
});
