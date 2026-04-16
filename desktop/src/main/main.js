const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { BackendManager } = require("./backendManager");

let mainWindow = null;
const backend = new BackendManager({ host: "127.0.0.1", port: 8000 });
let updateAvailableInfo = null;
let updateDownloadedInfo = null;
let updateDownloadInFlight = false;
let updateInstallAccepted = false;
let activeProject = null;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function normalizePath(inputPath) {
  return path.resolve(inputPath || "");
}

function projectIdForFolder(folderPath) {
  return crypto.createHash("sha1").update(normalizePath(folderPath).toLowerCase()).digest("hex").slice(0, 16);
}

function projectsRootDir() {
  const root = path.join(app.getPath("userData"), "projects");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function projectDirForId(projectId) {
  const dir = path.join(projectsRootDir(), projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "masks"), { recursive: true });
  return dir;
}

function projectFilePath(projectId) {
  return path.join(projectDirForId(projectId), "project.json");
}

function listImagesInFolder(folderPath) {
  const folder = normalizePath(folderPath);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return [];
  }

  return fs.readdirSync(folder)
    .map((name) => path.join(folder, name))
    .filter((fullPath) => {
      if (!fs.existsSync(fullPath)) {
        return false;
      }
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        return false;
      }
      const ext = path.extname(fullPath).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function readProject(projectId) {
  const filePath = projectFilePath(projectId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeProject(projectData) {
  const next = {
    ...projectData,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(projectFilePath(next.id), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function serializeProject(projectData) {
  if (!projectData) {
    return null;
  }
  return {
    id: projectData.id,
    folderPath: projectData.folderPath,
    images: projectData.images,
    activeImagePath: projectData.activeImagePath,
    masks: projectData.masks || {},
    jobHistory: projectData.jobHistory || {},
    queueItems: projectData.queueItems || [],
    settings: projectData.settings || {},
    createdAt: projectData.createdAt,
    updatedAt: projectData.updatedAt,
  };
}

function openOrCreateProject(folderPath) {
  const normalizedFolder = normalizePath(folderPath);
  if (!fs.existsSync(normalizedFolder) || !fs.statSync(normalizedFolder).isDirectory()) {
    throw new Error(`Project folder not found: ${normalizedFolder}`);
  }

  const projectId = projectIdForFolder(normalizedFolder);
  const existing = readProject(projectId);
  const images = listImagesInFolder(normalizedFolder);

  const next = {
    id: projectId,
    folderPath: normalizedFolder,
    images,
    activeImagePath: existing?.activeImagePath && images.includes(existing.activeImagePath)
      ? existing.activeImagePath
      : (images[0] || null),
    masks: existing?.masks || {},
    jobHistory: existing?.jobHistory || {},
    queueItems: Array.isArray(existing?.queueItems) ? existing.queueItems : [],
    settings: existing?.settings || {},
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  activeProject = writeProject(next);
  return serializeProject(activeProject);
}

function assertActiveProject() {
  if (!activeProject) {
    throw new Error("No active project. Open a project folder first.");
  }
}

function emitUpdaterEvent(channel, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function runUpdateDownload() {
  if (!app.isPackaged || !updateAvailableInfo || updateDownloadInFlight || updateDownloadedInfo) {
    return;
  }

  updateDownloadInFlight = true;
  autoUpdater.downloadUpdate().catch((error) => {
    console.error("[updater:error]", error?.message || error);
    emitUpdaterEvent("updater:error", { message: String(error?.message || error) });
  }).finally(() => {
    updateDownloadInFlight = false;
  });
}

function configureAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("error", (error) => {
    console.error("[updater:error]", error?.message || error);
    emitUpdaterEvent("updater:error", { message: String(error?.message || error) });
  });

  autoUpdater.on("update-available", (info) => {
    updateAvailableInfo = info;
    emitUpdaterEvent("updater:update-available", {
      version: info?.version || null,
      releaseName: info?.releaseName || null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    emitUpdaterEvent("updater:download-progress", {
      percent: Number(progress?.percent || 0),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateDownloadedInfo = info;
    emitUpdaterEvent("updater:update-downloaded", {
      version: info?.version || null,
      releaseName: info?.releaseName || null,
    });

    if (updateInstallAccepted) {
      autoUpdater.quitAndInstall();
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      console.error("[updater:error]", error?.message || error);
      emitUpdaterEvent("updater:error", { message: String(error?.message || error) });
    });
  }, 1000);
}

function resolveOutputImagePath(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    return sourcePath;
  }

  if (!stat.isDirectory()) {
    return null;
  }

  const imageFiles = fs.readdirSync(sourcePath)
    .map((name) => path.join(sourcePath, name))
    .filter((candidate) => {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        return false;
      }
      const ext = path.extname(candidate).toLowerCase();
      return [".png", ".jpg", ".jpeg"].includes(ext);
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return imageFiles[0] || null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: "Photo Watermark Remover",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function wireBackendEvents() {
  backend.on("status", (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend:status", status);
    }
  });

  backend.on("log", (entry) => {
    const level = entry?.level || "info";
    const message = entry?.message || "";
    // Print backend manager diagnostics into the Electron terminal for debugging.
    console.log(`[backend:${level}] ${message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend:log", entry);
    }
  });
}

async function bootBackendOrShowError() {
  try {
    await backend.start();
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Backend Startup Failed",
      message: "The local Python backend failed to start.",
      detail: String(error?.message || error),
      buttons: ["Quit", "Retry"],
      defaultId: 1,
      cancelId: 0,
    }).then(async (result) => {
      if (result.response === 1) {
        await bootBackendOrShowError();
        return;
      }
      app.quit();
    });
  }
}

app.whenReady().then(async () => {
  createWindow();
  wireBackendEvents();
  configureAutoUpdater();
  await bootBackendOrShowError();

  // Trigger model warmup after backend is ready
  backend.warmup().catch((err) => {
    console.error("[warmup] background error:", err?.message || err);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.handle("backend:get-status", async () => backend.getStatus());
ipcMain.handle("backend:restart", async () => backend.restart());
ipcMain.handle("backend:get-devices", async () => backend.detectDevices());
ipcMain.handle("backend:pick-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Image",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg"] },
    ],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});
ipcMain.handle("project:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open Project Folder",
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
});
ipcMain.handle("project:open-folder", async (_event, folderPath) => {
  if (!folderPath) {
    throw new Error("Project folder path is required.");
  }
  return openOrCreateProject(folderPath);
});
ipcMain.handle("project:get-active", async () => serializeProject(activeProject));
ipcMain.handle("project:select-image", async (_event, imagePath) => {
  assertActiveProject();
  if (!imagePath || !activeProject.images.includes(imagePath)) {
    throw new Error("Image does not belong to active project.");
  }
  activeProject.activeImagePath = imagePath;
  activeProject = writeProject(activeProject);
  return serializeProject(activeProject);
});
ipcMain.handle("project:get-mask-path", async (_event, imagePath) => {
  assertActiveProject();
  const maskPath = activeProject.masks?.[imagePath] || null;
  if (maskPath && fs.existsSync(maskPath)) {
    return maskPath;
  }
  return null;
});
ipcMain.handle("project:save-mask", async (_event, imagePath, dataUrl) => {
  assertActiveProject();
  if (!imagePath || !activeProject.images.includes(imagePath)) {
    throw new Error("Image does not belong to active project.");
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Invalid mask payload. Expected PNG data URL.");
  }

  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const fileId = crypto.createHash("sha1").update(imagePath.toLowerCase()).digest("hex").slice(0, 16);
  const outPath = path.join(projectDirForId(activeProject.id), "masks", `${fileId}.png`);
  fs.writeFileSync(outPath, Buffer.from(base64, "base64"));

  activeProject.masks = activeProject.masks || {};
  activeProject.masks[imagePath] = outPath;
  activeProject = writeProject(activeProject);
  return outPath;
});
ipcMain.handle("project:update-job-history", async (_event, payload) => {
  assertActiveProject();
  const imagePath = payload?.imagePath;
  if (!imagePath || !activeProject.images.includes(imagePath)) {
    return serializeProject(activeProject);
  }

  activeProject.jobHistory = activeProject.jobHistory || {};
  activeProject.jobHistory[imagePath] = {
    status: payload?.status || "unknown",
    outputPath: payload?.outputPath || null,
    jobId: payload?.jobId || null,
    updatedAt: Date.now(),
  };
  activeProject = writeProject(activeProject);
  return serializeProject(activeProject);
});
ipcMain.handle("project:get-queue", async () => {
  assertActiveProject();
  return Array.isArray(activeProject.queueItems) ? activeProject.queueItems : [];
});
ipcMain.handle("project:set-queue", async (_event, queueItems) => {
  assertActiveProject();
  const nextItems = Array.isArray(queueItems) ? queueItems : [];

  activeProject.queueItems = nextItems.filter((item) => {
    const imagePath = item?.imagePath;
    const maskPath = item?.maskPath;
    if (!imagePath || !activeProject.images.includes(imagePath)) {
      return false;
    }
    if (!maskPath || !fs.existsSync(maskPath)) {
      return false;
    }
    return true;
  }).map((item) => ({
    id: String(item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    imagePath: item.imagePath,
    maskPath: item.maskPath,
    device: item.device || "cpu",
    status: item.status || "pending",
    progress: item.progress || { stage: "pending", percent: 0, error: null },
    backendJobId: item.backendJobId || null,
    outputPath: item.outputPath || null,
    error: item.error || null,
    createdAt: Number(item.createdAt || Date.now()),
  }));

  activeProject = writeProject(activeProject);
  return activeProject.queueItems;
});
ipcMain.handle("project:update-settings", async (_event, settingsPatch) => {
  assertActiveProject();
  const patch = settingsPatch && typeof settingsPatch === "object" ? settingsPatch : {};
  const nextSettings = {
    ...(activeProject.settings || {}),
    ...patch,
  };
  if (patch.autoMask && typeof patch.autoMask === "object") {
    nextSettings.autoMask = {
      ...((activeProject.settings && activeProject.settings.autoMask) || {}),
      ...patch.autoMask,
    };
  }

  activeProject.settings = nextSettings;
  activeProject = writeProject(activeProject);
  return serializeProject(activeProject);
});
ipcMain.handle("backend:start-inpaint", async (_event, payload) => backend.startInpaint(payload));
ipcMain.handle("backend:suggest-mask", async (_event, payload) => backend.suggestMask(payload));
ipcMain.handle("backend:detect-mask", async (_event, payload) => backend.detectMask(payload));
ipcMain.handle("backend:auto-remove", async (_event, payload) => backend.autoRemove(payload));
ipcMain.handle("backend:get-job", async (_event, jobId) => backend.getJob(jobId));
ipcMain.handle("backend:get-jobs", async () => backend.getJobs());
ipcMain.handle("backend:cancel-job", async (_event, jobId) => backend.cancelJob(jobId));
ipcMain.handle("backend:write-mask", async (_event, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Invalid mask payload. Expected PNG data URL.");
  }

  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const outputDir = path.join(os.tmpdir(), "photo-watermark-remover");
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `mask-${crypto.randomUUID()}.png`;
  const outPath = path.join(outputDir, fileName);
  fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
  return outPath;
});
ipcMain.handle("backend:save-output", async (_event, sourcePath, format) => {
  const resolvedPath = resolveOutputImagePath(sourcePath);
  if (!resolvedPath) {
    throw new Error("Output file not found.");
  }

  const normalizedFormat = format === "jpg" ? "jpg" : "png";
  const sourceDir = path.dirname(resolvedPath);
  const sourceBase = path.basename(resolvedPath, path.extname(resolvedPath));
  const defaultPath = path.join(sourceDir, `${sourceBase}.${normalizedFormat}`);

  const save = await dialog.showSaveDialog(mainWindow, {
    title: "Save Output Image",
    defaultPath,
    filters: [
      { name: "PNG", extensions: ["png"] },
      { name: "JPEG", extensions: ["jpg", "jpeg"] },
    ],
  });

  if (save.canceled || !save.filePath) {
    return null;
  }

  const ext = path.extname(save.filePath).toLowerCase();
  const finalFormat = [".jpg", ".jpeg"].includes(ext) ? "jpg" : normalizedFormat;
  const withExt = ext ? save.filePath : `${save.filePath}.${finalFormat}`;

  const sourceExt = path.extname(resolvedPath).toLowerCase();
  const sourceFormat = [".jpg", ".jpeg"].includes(sourceExt) ? "jpg" : sourceExt === ".png" ? "png" : null;

  if (sourceFormat && sourceFormat === finalFormat) {
    fs.copyFileSync(resolvedPath, withExt);
    return withExt;
  }

  const img = nativeImage.createFromPath(resolvedPath);
  if (img.isEmpty()) {
    throw new Error("Failed to load output image for saving.");
  }

  const outputBuffer = finalFormat === "jpg" ? img.toJPEG(92) : img.toPNG();
  fs.writeFileSync(withExt, outputBuffer);
  return withExt;
});
ipcMain.handle("backend:open-output-folder", async (_event, targetPath) => {
  if (!targetPath) {
    throw new Error("No output path provided.");
  }

  const resolvedPath = resolveOutputImagePath(targetPath);
  const existingPath = resolvedPath || (fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath));

  shell.showItemInFolder(existingPath);
  return true;
});

ipcMain.handle("updater:accept-install", async () => {
  updateInstallAccepted = true;

  if (updateDownloadedInfo) {
    autoUpdater.quitAndInstall();
    return { state: "installing" };
  }

  runUpdateDownload();
  return { state: updateDownloadInFlight ? "downloading" : "idle" };
});

ipcMain.handle("updater:defer-install", async () => {
  updateInstallAccepted = false;
  return { state: "deferred" };
});

app.on("before-quit", async (event) => {
  event.preventDefault();
  try {
    await backend.stop();
  } finally {
    app.exit(0);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
