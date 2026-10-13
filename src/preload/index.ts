import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { METHODS, type AppEvent, type Method } from '../shared/types';
contextBridge.exposeInMainWorld('lecturedesk', {
  call: (method: Method, args?: unknown) => {
    if (!METHODS.includes(method)) return Promise.reject(new Error('Unsupported operation'));
    return ipcRenderer.invoke('lecturedesk:call', method, args);
  },
  on: (listener: (event: AppEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AppEvent) => listener(payload);
    ipcRenderer.on('lecturedesk:event', wrapped);
    return () => ipcRenderer.removeListener('lecturedesk:event', wrapped);
  },
  filePath: (file: File) => webUtils.getPathForFile(file),
});
