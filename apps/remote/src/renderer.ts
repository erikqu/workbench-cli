import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { DEFAULT_PROFILE, type Credentials, type Pane, type Profile, type Snapshot, type Workspace } from './shared';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const api = window.workbench;
const form = $<HTMLFormElement>('connection-form');
const dialog = $<HTMLDialogElement>('connection-dialog');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
let profile: Profile = { ...DEFAULT_PROFILE };
let credentials: Credentials = {};
let snapshot: Snapshot = { workspaces: [], updatedAt: 0 };
let connected = false;
let connecting = false;
let refreshInFlight = false;
let intentionalDisconnect = false;
let workspaceId = '';
let activePaneId = '';
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let selectionVersion = 0;
const terminals = new Map<string, { terminal: Terminal; fit: FitAddon; element: HTMLDivElement; live: boolean }>();

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}
function status(value: boolean, message: string) {
  connected = value;
  $('connection-state').textContent = value ? 'Connected · SSH' : message;
  $('footer-status').textContent = value ? `Connected to ${profile.host.split('.')[0]}` : message;
  $('status-dot').classList.toggle('online', value);
  $('footer-dot').classList.toggle('online', value);
  $('connection-action').textContent = value ? 'Disconnect' : 'Connect machine ↗';
  $<HTMLButtonElement>('refresh').disabled = !value;
  for (const item of terminals.values()) item.terminal.options.disableStdin = !value || !item.live;
}
function populateForm() {
  for (const [key, value] of Object.entries(profile)) field(key).value = String(value);
  field('password').value = '';
  field('passphrase').value = '';
  authFields();
}
function openSettings() { populateForm(); $('form-error').hidden = true; dialog.showModal(); }
function authFields() {
  const auth = field('auth').value;
  $('key-fields').hidden = auth !== 'key';
  $('password-field').hidden = auth !== 'password';
  $('auth-help').textContent = auth === 'agent' ? 'Uses the keys loaded in your Mac’s SSH agent.' : auth === 'key' ? 'Your private key stays on this Mac.' : 'Your password is used only for this connection.';
}
field('auth').addEventListener('change', authFields);
$('choose-key').onclick = async () => { try { const file = await api.chooseKey(); if (file) field('keyPath').value = file; } catch (error) { showFormError(error); } };
for (const id of ['machine', 'settings', 'empty-connect']) $(id).onclick = openSettings;
$('close-dialog').onclick = () => { if (!connecting) dialog.close(); };
dialog.addEventListener('cancel', event => { if (connecting) event.preventDefault(); });
dialog.addEventListener('close', () => { field('password').value = ''; field('passphrase').value = ''; });
function showFormError(error: unknown) { $('form-error').textContent = errorMessage(error); $('form-error').hidden = false; }
function disposeTerminals() {
  selectionVersion++;
  for (const item of terminals.values()) { item.terminal.dispose(); item.element.remove(); }
  terminals.clear();
}
async function connect(isRetry = false) {
  if (connecting) return;
  clearTimeout(retryTimer);
  connecting = true;
  intentionalDisconnect = false;
  $('form-error').hidden = true;
  $<HTMLButtonElement>('submit-connect').disabled = true;
  $('submit-connect').textContent = isRetry ? 'Reconnecting…' : 'Connecting…';
  status(false, isRetry ? `Reconnecting (${retries}/5)…` : 'Connecting…');
  try {
    disposeTerminals();
    snapshot = await api.connect(profile, credentials);
    retries = 0;
    dialog.close();
    status(true, 'Connected');
    $('machine-name').textContent = profile.host.split('.')[0];
    notice(snapshot.warning);
    renderWorkspaces();
    const workspace = snapshot.workspaces.find(w => w.id === workspaceId) || snapshot.workspaces[0];
    if (workspace) await selectWorkspace(workspace);
    else showEmpty('No workspaces yet.', 'Start Workbench on your remote machine, then refresh to see its sessions.');
  } catch (error) {
    status(false, 'Disconnected');
    if (isRetry) { notice(errorMessage(error), true); scheduleReconnect(); }
    else { showFormError(error); if (!dialog.open) dialog.showModal(); }
  } finally {
    connecting = false;
    $<HTMLButtonElement>('submit-connect').disabled = false;
    $('submit-connect').textContent = 'Connect ↗';
  }
}
form.onsubmit = event => {
  event.preventDefault();
  profile = { host: field('host').value.trim(), port: Number(field('port').value), username: field('username').value.trim(),
    auth: field('auth').value as Profile['auth'], keyPath: field('keyPath').value, directory: field('directory').value.trim() };
  credentials = { password: field('password').value, passphrase: field('passphrase').value };
  retries = 0;
  void connect();
};
$('connection-action').onclick = async () => {
  if (!connected) { openSettings(); return; }
  intentionalDisconnect = true;
  clearTimeout(retryTimer);
  credentials = {};
  await api.disconnect();
  status(false, 'Disconnected');
  notice('Disconnected. Your sessions are still running on the remote machine.');
};
function scheduleReconnect() {
  if (intentionalDisconnect || retries >= 5) {
    if (!intentionalDisconnect) notice('Unable to reconnect. Check your network and Tailscale, then use Connect machine to try again.', true);
    return;
  }
  clearTimeout(retryTimer);
  const delay = Math.min(30000, 2000 * 2 ** retries);
  retries++;
  retryTimer = setTimeout(() => { void connect(true); }, delay);
}
function renderWorkspaces() {
  const container = $('workspaces');
  container.replaceChildren();
  const query = $<HTMLInputElement>('search').value.toLowerCase();
  const items = snapshot.workspaces.filter(w => `${w.name} ${w.cwd}`.toLowerCase().includes(query));
  for (const workspace of items) {
    const button = document.createElement('button');
    button.className = 'workspace-card' + (workspace.id === workspaceId ? ' active' : '');
    button.setAttribute('aria-current', String(workspace.id === workspaceId));
    const icon = document.createElement('span'); icon.className = 'workspace-icon'; icon.textContent = '⌑';
    const content = document.createElement('span'); content.className = 'workspace-info';
    const title = document.createElement('strong'); title.textContent = workspace.name;
    const sub = document.createElement('small');
    const live = workspace.panes.filter(p => p.live).length;
    sub.textContent = `${live} live ${live === 1 ? 'session' : 'sessions'}`;
    content.append(title, sub);
    const dot = document.createElement('i'); dot.className = 'workspace-dot' + (live ? ' online' : '');
    button.append(icon, content, dot);
    button.title = workspace.cwd;
    button.onclick = () => { void selectWorkspace(workspace); };
    container.append(button);
  }
  if (!items.length) { const p = document.createElement('p'); p.className = 'sidebar-empty'; p.textContent = query ? 'No matching workspaces.' : 'No saved workspaces found.'; container.append(p); }
}
function renderTabs(workspace: Workspace) {
  const container = $('tabs'); container.replaceChildren();
  for (const pane of workspace.panes) {
    const button = document.createElement('button');
    button.className = 'tab' + (activePaneId === pane.id ? ' active' : '');
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(activePaneId === pane.id));
    button.disabled = !pane.live;
    button.title = pane.live ? pane.name : 'Saved session is not running. Open it in Workbench on the remote machine.';
    const icon = document.createElement('span'); icon.className = 'tab-icon'; icon.textContent = pane.kind === 'agent' ? '✳' : '>_';
    const label = document.createElement('span'); label.textContent = pane.name + (pane.live ? '' : ' · offline');
    button.append(icon, label);
    button.onclick = () => { void selectPane(pane, workspace); };
    container.append(button);
  }
}
async function selectWorkspace(workspace: Workspace) {
  workspaceId = workspace.id;
  $('workspace-title').textContent = workspace.name;
  $('workspace-path').textContent = workspace.cwd || 'Live panes not present in the saved layout';
  renderWorkspaces();
  const pane = workspace.panes.find(p => p.id === activePaneId && p.live) || workspace.panes.find(p => p.live);
  if (pane) await selectPane(pane, workspace);
  else {
    selectionVersion++;
    activePaneId = '';
    renderTabs(workspace);
    for (const item of terminals.values()) item.element.hidden = true;
    showEmpty('This workspace is resting.', 'Its layout is saved. Open it in Workbench on the remote machine to start its sessions.');
  }
}
function showEmpty(title: string, description: string) {
  $('empty').hidden = false;
  $('empty').querySelector('h2')!.textContent = title;
  $('empty').querySelector('p')!.textContent = description;
  $('empty-connect').hidden = connected;
}
async function selectPane(pane: Pane, workspace: Workspace) {
  if (!connected) { notice('Reconnect to your machine to open this session.', true); return; }
  const version = ++selectionVersion;
  activePaneId = pane.id;
  renderTabs(workspace);
  $('empty').hidden = true;
  for (const [id, item] of terminals) item.element.hidden = id !== pane.id;
  let item = terminals.get(pane.id);
  if (item && !item.live) { item.terminal.dispose(); item.element.remove(); terminals.delete(pane.id); item = undefined; }
  if (item) { item.fit.fit(); item.terminal.focus(); return; }
  const element = document.createElement('div'); element.className = 'terminal'; $('terminal-area').append(element);
  const terminal = new Terminal({ cursorBlink: true, fontFamily: '"SF Mono", Menlo, Monaco, monospace', fontSize: 13, lineHeight: 1.25, scrollback: 10000,
    theme: { background: '#141716', foreground: '#dce2db', cursor: '#bee79a', selectionBackground: '#42533a', black: '#303530', red: '#e99386', green: '#bee79a', yellow: '#e6cf94', blue: '#99bcdf', magenta: '#c6a9dd', cyan: '#a0d6ce', white: '#e1e5df' } });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element); fit.fit();
  item = { terminal, fit, element, live: true };
  terminals.set(pane.id, item);
  terminal.onData(data => { if (connected && item!.live) api.input(pane.id, data); });
  terminal.onResize(({ cols, rows }) => { if (connected) api.resize(pane.id, cols, rows); });
  terminal.attachCustomKeyEventHandler(event => !(event.metaKey && ['c', 'v', 'k', 'r', ',', '=', '-', '0'].includes(event.key.toLowerCase())));
  try {
    await api.attach(pane.id, pane.tmux, terminal.cols, terminal.rows);
    if (terminals.get(pane.id) !== item) return;
    if (version === selectionVersion) { fit.fit(); terminal.focus(); }
  } catch (error) {
    if (terminals.get(pane.id) !== item) return;
    item.live = false;
    terminal.options.disableStdin = true;
    notice(errorMessage(error), true);
  }
}
async function refresh() {
  if (!connected || connecting || refreshInFlight) return;
  refreshInFlight = true;
  try {
    snapshot = await api.refresh();
    renderWorkspaces();
    const workspace = snapshot.workspaces.find(w => w.id === workspaceId);
    if (workspace) renderTabs(workspace);
    notice(snapshot.warning);
    $('footer-right').textContent = `Synced ${new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) { notice(errorMessage(error), true); }
  finally { refreshInFlight = false; }
}
$('refresh').onclick = () => { void refresh(); };
$<HTMLInputElement>('search').oninput = renderWorkspaces;
api.onEvent(event => {
  if (event.type === 'data') {
    const item = terminals.get(event.id);
    if (item) item.terminal.write(new Uint8Array(event.data), () => api.ack(event.id, event.data.length));
    else api.ack(event.id, event.data.length);
  } else if (event.type === 'exit') {
    const item = terminals.get(event.id);
    if (item) { item.live = false; item.terminal.options.disableStdin = true; item.terminal.writeln('\r\n\x1b[90m[Detached. Select this tab to attach again.]\x1b[0m'); }
  } else {
    status(event.connected, event.message);
    if (!event.connected && !connecting && !intentionalDisconnect) { notice(event.message, true); scheduleReconnect(); }
  }
});
new ResizeObserver(() => { const item = terminals.get(activePaneId); if (item && !item.element.hidden) item.fit.fit(); }).observe($('terminal-area'));
document.addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey) return;
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); $<HTMLInputElement>('search').focus(); }
  if (event.key === ',') { event.preventDefault(); if (!dialog.open) openSettings(); }
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); void refresh(); }
});
setInterval(() => { void refresh(); }, 10000);
window.addEventListener('online', () => { if (!connected && !connecting && retries > 0 && !intentionalDisconnect) { retries = 0; scheduleReconnect(); } });
api.profile().then(value => { profile = { ...DEFAULT_PROFILE, ...value }; $('machine-name').textContent = profile.host.split('.')[0]; populateForm(); }).catch(error => notice(errorMessage(error), true));
status(false, 'Disconnected');
