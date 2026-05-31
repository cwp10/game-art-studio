const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openImagesFolder: () => ipcRenderer.invoke("open-images-folder"),
});
