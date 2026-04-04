const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const { BackendManager } = require("./backendManager");

let mainWindow = null;
const backend = new BackendManager({ host: "127.0.0.1", port: 8000 });

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
  await bootBackendOrShowError();

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
ipcMain.handle("backend:start-inpaint", async (_event, payload) => backend.startInpaint(payload));
ipcMain.handle("backend:get-job", async (_event, jobId) => backend.getJob(jobId));
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
