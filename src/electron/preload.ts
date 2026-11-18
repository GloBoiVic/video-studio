// The only bridge from the app window to Electron: native file pickers and revealing an export in Finder.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('studioNative', {
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('pick-files'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
});
