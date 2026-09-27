import { contextBridge, ipcRenderer } from 'electron';
import type { RemoteAPI, RemoteEvent } from './shared';
const api: RemoteAPI = {
  profile: () => ipcRenderer.invoke('profile'),
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  connect: (profile, credentials) => ipcRenderer.invoke('connect', profile, credentials),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  refresh: () => ipcRenderer.invoke('refresh'),
  attach: (id, tmux, cols, rows) => ipcRenderer.invoke('attach', id, tmux, cols, rows),
  detach: id => ipcRenderer.invoke('detach', id),
  input: (id, data) => ipcRenderer.send('input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('resize', id, cols, rows),
  ack: (id, bytes) => ipcRenderer.send('ack', id, bytes),
  onEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, value: RemoteEvent) => callback(value);
    ipcRenderer.on('remote-event', listener);
    return () => ipcRenderer.removeListener('remote-event', listener);
  },
};
contextBridge.exposeInMainWorld('workbench', api);
