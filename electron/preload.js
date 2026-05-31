const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
});
