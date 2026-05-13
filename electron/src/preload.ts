import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('grove', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('grove:pick-folder'),
});
