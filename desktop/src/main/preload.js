const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backend", {
  getStatus: () => ipcRenderer.invoke("backend:get-status"),
  restart: () => ipcRenderer.invoke("backend:restart"),
  pickImage: () => ipcRenderer.invoke("backend:pick-image"),
  startInpaint: (payload) => ipcRenderer.invoke("backend:start-inpaint", payload),
  getJob: (jobId) => ipcRenderer.invoke("backend:get-job", jobId),
  cancelJob: (jobId) => ipcRenderer.invoke("backend:cancel-job", jobId),
  writeMaskDataUrl: (dataUrl) => ipcRenderer.invoke("backend:write-mask", dataUrl),
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
