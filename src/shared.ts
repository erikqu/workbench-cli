export interface Profile {
  host: string; port: number; username: string; directory: string;
  auth: 'agent' | 'key' | 'password'; keyPath: string;
}
export interface Credentials { password?: string; passphrase?: string }
export interface Pane { id: string; name: string; tmux: string; kind: 'agent' | 'terminal'; live: boolean; harnessId?: string; activity?: 'working' | 'recent' | 'idle' }
export interface Workspace { id: string; name: string; cwd: string; panes: Pane[] }
export interface Snapshot { workspaces: Workspace[]; warning?: string; updatedAt: number }
export type RemoteEvent =
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'data'; id: string; data: Uint8Array }
  | { type: 'exit'; id: string };
export interface RemoteAPI {
  profile(): Promise<Profile>;
  chooseKey(): Promise<string | null>;
  connect(profile: Profile, credentials: Credentials): Promise<Snapshot>;
  disconnect(): Promise<void>;
  refresh(): Promise<Snapshot>;
  attach(id: string, tmux: string, cols: number, rows: number): Promise<void>;
  detach(id: string): Promise<void>;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, bytes: number): void;
  onEvent(callback: (event: RemoteEvent) => void): () => void;
}
export const DEFAULT_PROFILE: Profile = {
  host: 'supernova.tail43b99e.ts.net', port: 2222, username: 'starq',
  directory: '~/.workbench', auth: 'agent', keyPath: '',
};
declare global { interface Window { workbench: RemoteAPI } }
