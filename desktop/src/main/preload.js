const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backend", {
  getStatus: () => ipcRenderer.invoke("backend:get-status"),
  restart: () => ipcRenderer.invoke("backend:restart"),
  getDevices: () => ipcRenderer.invoke("backend:get-devices"),
  pickImage: () => ipcRenderer.invoke("backend:pick-image"),
  startInpaint: (payload) => ipcRenderer.invoke("backend:start-inpaint", payload),
  getJob: (jobId) => ipcRenderer.invoke("backend:get-job", jobId),
  cancelJob: (jobId) => ipcRenderer.invoke("backend:cancel-job", jobId),
  writeMaskDataUrl: (dataUrl) => ipcRenderer.invoke("backend:write-mask", dataUrl),
  saveOutput: (sourcePath, format) => ipcRenderer.invoke("backend:save-output", sourcePath, format),
  openOutputFolder: (targetPath) => ipcRenderer.invoke("backend:open-output-folder", targetPath),
  onStatusChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("backend:status", wrapped);
    return () => ipcRenderer.removeListener("backend:status", wrapped);
  },
  onLog: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("backend:log", wrapped);
    return () => ipcRenderer.removeListener("backend:log", wrapped);
  },
});
