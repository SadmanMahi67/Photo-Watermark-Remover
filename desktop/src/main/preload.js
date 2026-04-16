const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backend", {
  getStatus: () => ipcRenderer.invoke("backend:get-status"),
  restart: () => ipcRenderer.invoke("backend:restart"),
  getDevices: () => ipcRenderer.invoke("backend:get-devices"),
  pickImage: () => ipcRenderer.invoke("backend:pick-image"),
  suggestMask: (payload) => ipcRenderer.invoke("backend:suggest-mask", payload),
  startInpaint: (payload) => ipcRenderer.invoke("backend:start-inpaint", payload),
  getJob: (jobId) => ipcRenderer.invoke("backend:get-job", jobId),
  getJobs: () => ipcRenderer.invoke("backend:get-jobs"),
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

contextBridge.exposeInMainWorld("projects", {
  pickFolder: () => ipcRenderer.invoke("project:pick-folder"),
  openFolder: (folderPath) => ipcRenderer.invoke("project:open-folder", folderPath),
  getActive: () => ipcRenderer.invoke("project:get-active"),
  selectImage: (imagePath) => ipcRenderer.invoke("project:select-image", imagePath),
  getMaskPath: (imagePath) => ipcRenderer.invoke("project:get-mask-path", imagePath),
  saveMask: (imagePath, dataUrl) => ipcRenderer.invoke("project:save-mask", imagePath, dataUrl),
  updateJobHistory: (payload) => ipcRenderer.invoke("project:update-job-history", payload),
  getQueue: () => ipcRenderer.invoke("project:get-queue"),
  setQueue: (queueItems) => ipcRenderer.invoke("project:set-queue", queueItems),
  updateSettings: (settingsPatch) => ipcRenderer.invoke("project:update-settings", settingsPatch),
});

contextBridge.exposeInMainWorld("updater", {
  acceptInstall: () => ipcRenderer.invoke("updater:accept-install"),
  deferInstall: () => ipcRenderer.invoke("updater:defer-install"),
  onUpdateAvailable: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("updater:update-available", wrapped);
    return () => ipcRenderer.removeListener("updater:update-available", wrapped);
  },
  onUpdateDownloaded: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("updater:update-downloaded", wrapped);
    return () => ipcRenderer.removeListener("updater:update-downloaded", wrapped);
  },
  onDownloadProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("updater:download-progress", wrapped);
    return () => ipcRenderer.removeListener("updater:download-progress", wrapped);
  },
  onError: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("updater:error", wrapped);
    return () => ipcRenderer.removeListener("updater:error", wrapped);
  },
});
