const canvas = document.getElementById("paintCanvas");
const canvasWrap = document.getElementById("canvasWrap");
const dropZone = document.getElementById("dropZone");
const resultArea = document.getElementById("resultArea");
const outputStateText = document.getElementById("outputStateText");
const processingTimeText = document.getElementById("processingTimeText");
const deviceSelect = document.getElementById("deviceSelect");
const deviceNote = document.getElementById("deviceNote");
const outputFormatSelect = document.getElementById("outputFormatSelect");
const outputZoomOutBtn = document.getElementById("outputZoomOutBtn");
const outputZoomInBtn = document.getElementById("outputZoomInBtn");
const outputZoomResetBtn = document.getElementById("outputZoomResetBtn");
const outputZoomLabel = document.getElementById("outputZoomLabel");
const saveOutputBtn = document.getElementById("saveOutputBtn");
const openFolderBtn = document.getElementById("openFolderBtn");
const backendPill = document.getElementById("backendPill");
const statusText = document.getElementById("statusText");
const fileText = document.getElementById("fileText");
const progressBar = document.getElementById("progressBar");
const errorNote = document.getElementById("errorNote");
const updateToast = document.getElementById("updateToast");
const updateToastText = document.getElementById("updateToastText");
const updateToastMeta = document.getElementById("updateToastMeta");
const updateYesBtn = document.getElementById("updateYesBtn");
const updateLaterBtn = document.getElementById("updateLaterBtn");

const brushSizeInput = document.getElementById("brushSize");
const brushSizeLabel = document.getElementById("brushSizeLabel");
const zoomSlider = document.getElementById("zoomSlider");
const zoomLabel = document.getElementById("zoomLabel");
const openImageBtn = document.getElementById("openImageBtn");
const eraserBtn = document.getElementById("eraserBtn");
const clearMaskBtn = document.getElementById("clearMaskBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const removeBtn = document.getElementById("removeBtn");
const cancelBtn = document.getElementById("cancelBtn");
const retryBtn = document.getElementById("retryBtn");
const resetJobBtn = document.getElementById("resetJobBtn");

const ctx = canvas.getContext("2d");
const sourceCanvas = document.createElement("canvas");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");

const jobState = {
  imageSource: null,
  maskSource: null,
  status: "idle",
  progress: { stage: "idle", percent: 0, error: null },
  output: null,
  error: null,
};

let backendReady = false;
let outputPanelState = "no-output";
let currentJobId = null;
let currentJobStartedAt = null;
let lastProcessingSeconds = null;
let selectedDevice = "cpu";
let outputZoom = 1;
let updatePromptVisible = false;
let updateInstallVersion = null;
let updateInstallAccepted = false;
let currentTheme = "light";

const THEME_KEY = "pwr.theme";
const THEME_LIGHT = "light";
const THEME_DARK = "dark";

function applyTheme(theme) {
  const isDark = theme === THEME_DARK;
  document.documentElement.dataset.theme = isDark ? THEME_DARK : THEME_LIGHT;
  currentTheme = isDark ? THEME_DARK : THEME_LIGHT;
  
  const icon = document.getElementById("themeToggleIcon");
  if (icon) {
    icon.textContent = isDark ? "\u2600\uFE0F" : "\ud83c\udf19";
  }
  
  localStorage.setItem(THEME_KEY, currentTheme);
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || THEME_LIGHT;
  applyTheme(saved);
}

function hideUpdateToast() {
  if (!updateToast) {
    return;
  }
  updateToast.classList.remove("show");
  updatePromptVisible = false;
}

function showUpdateToast(message, meta = "") {
  if (!updateToast || !updateToastText || !updateYesBtn || !updateLaterBtn) {
    return;
  }

  updateToastText.textContent = message;
  if (updateToastMeta) {
    updateToastMeta.textContent = meta;
  }
  updateToast.classList.add("show");
  updatePromptVisible = true;
}

function humanStage(stage) {
  const map = {
    idle: "Idle",
    ready: "Ready",
    exporting_mask: "Preparing mask",
    starting_backend_job: "Starting AI removal",
    validating_input: "Validating input",
    loading_model: "Loading model",
    inpainting: "Removing watermark",
    writing_output: "Writing output",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    cancelling: "Cancelling",
  };
  return map[stage] || "Working";
}

const viewState = {
  image: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDrawing: false,
  isPanning: false,
  lastX: 0,
  lastY: 0,
  brushSize: Number(brushSizeInput.value),
  eraser: false,
};

function fileUrlFromPath(filePath) {
  return `file:///${filePath.replace(/\\/g, "/")}`;
}

function syncUi() {
  brushSizeLabel.textContent = `${viewState.brushSize}px`;
  zoomLabel.textContent = `${Math.round(viewState.zoom * 100)}%`;
  eraserBtn.classList.toggle("toggle-on", viewState.eraser);
  eraserBtn.textContent = viewState.eraser ? "Eraser On" : "Eraser Off";

  const stageLabel = humanStage(jobState.progress.stage);
  const percent = Math.max(0, Math.min(100, Number(jobState.progress.percent || 0)));
  statusText.textContent = `Status: ${jobState.status}`;
  if (jobState.status === "processing" || jobState.status === "cancelling") {
    statusText.textContent = `Status: ${stageLabel} ${percent}%`;
  }
  if (jobState.status === "completed") {
    statusText.textContent = "Status: Completed";
  }
  if (jobState.status === "cancelled") {
    statusText.textContent = "Status: Cancelled";
  }
  if (jobState.error) {
    statusText.textContent = `Status: Error`;
  }

  progressBar.style.width = `${percent}%`;

  fileText.textContent = jobState.imageSource || "No image selected";

  const hasImage = Boolean(jobState.imageSource);
  const hasOutput = Boolean(jobState.output);
  const running = jobState.status === "processing" || jobState.status === "cancelling";
  const canRetry = Boolean(hasImage && jobState.error);
  removeBtn.disabled = !hasImage || running || !backendReady;
  openImageBtn.disabled = running;
  eraserBtn.disabled = running || !hasImage;
  clearMaskBtn.disabled = running || !hasImage;
  resetViewBtn.disabled = running || !hasImage;
  cancelBtn.disabled = !currentJobId || !running;
  retryBtn.disabled = !canRetry || running;
  resetJobBtn.disabled = running;
  saveOutputBtn.disabled = !hasOutput || running;
  openFolderBtn.disabled = !hasOutput || running;
  outputFormatSelect.disabled = running;
  deviceSelect.disabled = running;

  if (jobState.error) {
    errorNote.style.display = "block";
    errorNote.textContent = `${jobState.error} Use Retry or Reset.`;
  } else {
    errorNote.style.display = "none";
    errorNote.textContent = "";
  }

  processingTimeText.textContent = lastProcessingSeconds !== null
    ? `Processed in ${lastProcessingSeconds.toFixed(1)}s`
    : "";
  outputZoomLabel.textContent = `${Math.round(outputZoom * 100)}%`;
}

function setOutputZoom(next) {
  outputZoom = Math.min(6, Math.max(0.25, next));
  const image = resultArea.querySelector("img");
  if (image) {
    image.style.transform = `scale(${outputZoom})`;
  }
  syncUi();
}

function populateDevices(devices) {
  const list = Array.isArray(devices) && devices.length > 0
    ? devices
    : [{ id: "cpu", label: "CPU (slower)" }];

  deviceSelect.innerHTML = "";
  for (const device of list) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.label;
    deviceSelect.appendChild(option);
  }

  const preferred = list.find((d) => d.id !== "cpu")?.id || "cpu";
  selectedDevice = list.some((d) => d.id === preferred) ? preferred : list[0].id;
  deviceSelect.value = selectedDevice;

  const hasGpu = list.some((d) => d.id === "cuda" || d.id === "mps");
  if (deviceNote) {
    deviceNote.textContent = hasGpu
      ? "GPU detected. You can switch to CPU if needed."
      : "No GPU backend detected. Falling back to CPU.";
  }
}

function setOutputState(state) {
  outputPanelState = state;

  if (state === "no-output") {
    resultArea.innerHTML = '<div class="empty-note">Run removal to preview output.</div>';
    outputStateText.textContent = "Output state: no output";
    return;
  }

  if (state === "processing") {
    resultArea.innerHTML = '<div class="empty-note">Processing image, output will appear here.</div>';
    outputStateText.textContent = "Output state: processing";
    return;
  }

  if (state === "error") {
    resultArea.innerHTML = '<div class="empty-note">Could not generate output. Please retry.</div>';
    outputStateText.textContent = "Output state: failed";
    return;
  }
}

function setBackendStatus(status) {
  backendReady = Boolean(status.ready);
  
  // Show special message during model warmup
  if (status.state === "warming") {
    backendPill.textContent = "Warming up AI...";
    backendPill.style.background = "#fef3c7";
    backendPill.style.color = "#92400e";
  } else {
    backendPill.textContent = `Backend: ${status.state}`;
    backendPill.style.background = status.ready ? "#d6f6f1" : "#fef3c7";
    backendPill.style.color = status.ready ? "#147d75" : "#92400e";
  }
  
  syncUi();
}

function hasMaskPixels() {
  if (!maskCanvas.width || !maskCanvas.height) {
    return false;
  }

  const { data } = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      return true;
    }
  }
  return false;
}

function fitImageToView() {
  if (!viewState.image) {
    return;
  }
  const widthScale = canvasWrap.clientWidth / viewState.image.width;
  const heightScale = canvasWrap.clientHeight / viewState.image.height;
  viewState.zoom = Math.max(0.25, Math.min(4, Math.min(widthScale, heightScale)));
  viewState.panX = (canvasWrap.clientWidth - viewState.image.width * viewState.zoom) / 2;
  viewState.panY = (canvasWrap.clientHeight - viewState.image.height * viewState.zoom) / 2;
  zoomSlider.value = String(Math.round(viewState.zoom * 100));
  syncUi();
}

function resizeCanvas() {
  canvas.width = canvasWrap.clientWidth;
  canvas.height = canvasWrap.clientHeight;
  render();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!viewState.image) {
    dropZone.style.display = "flex";
    return;
  }

  dropZone.style.display = "none";

  const drawW = viewState.image.width * viewState.zoom;
  const drawH = viewState.image.height * viewState.zoom;
  const drawX = viewState.panX;
  const drawY = viewState.panY;

  ctx.drawImage(sourceCanvas, drawX, drawY, drawW, drawH);

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = maskCanvas.width;
  overlayCanvas.height = maskCanvas.height;
  const overlayCtx = overlayCanvas.getContext("2d");
  overlayCtx.drawImage(maskCanvas, 0, 0);
  overlayCtx.globalCompositeOperation = "source-in";
  overlayCtx.fillStyle = "rgba(220, 38, 38, 0.55)";
  overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  ctx.drawImage(overlayCanvas, drawX, drawY, drawW, drawH);
}

function clientToImagePoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left - viewState.panX) / viewState.zoom;
  const y = (clientY - rect.top - viewState.panY) / viewState.zoom;
  return { x, y };
}

function paintMaskLine(from, to) {
  maskCtx.save();
  maskCtx.lineCap = "round";
  maskCtx.lineJoin = "round";
  maskCtx.lineWidth = viewState.brushSize;
  maskCtx.globalCompositeOperation = viewState.eraser ? "destination-out" : "source-over";
  maskCtx.strokeStyle = "rgba(255,255,255,1)";
  maskCtx.beginPath();
  maskCtx.moveTo(from.x, from.y);
  maskCtx.lineTo(to.x, to.y);
  maskCtx.stroke();
  maskCtx.restore();
}

async function loadImage(filePath) {
  const img = new Image();
  const src = fileUrlFromPath(filePath);

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = src;
  });

  viewState.image = img;
  sourceCanvas.width = img.width;
  sourceCanvas.height = img.height;
  sourceCanvas.getContext("2d").drawImage(img, 0, 0);

  maskCanvas.width = img.width;
  maskCanvas.height = img.height;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  jobState.imageSource = filePath;
  jobState.maskSource = null;
  jobState.output = null;
  jobState.error = null;
  jobState.status = "ready";
  jobState.progress = { stage: "ready", percent: 0, error: null };
  fitImageToView();
  render();
  paintOutput(null);
  syncUi();
}

function paintOutput(path) {
  if (!path) {
    setOutputState("no-output");
    return;
  }
  outputPanelState = "output-loaded";
  const outputSrc = fileUrlFromPath(path);
  resultArea.innerHTML = `<img src="${outputSrc}?t=${Date.now()}" alt="Cleaned output" />`;
  setOutputZoom(1);

  outputStateText.textContent = "Output state: output loaded";
}

function clearJobState() {
  jobState.imageSource = null;
  jobState.maskSource = null;
  jobState.status = "idle";
  jobState.progress = { stage: "idle", percent: 0, error: null };
  jobState.output = null;
  jobState.error = null;
  currentJobId = null;
  currentJobStartedAt = null;
  lastProcessingSeconds = null;

  viewState.image = null;
  viewState.zoom = 1;
  viewState.panX = 0;
  viewState.panY = 0;
  viewState.isDrawing = false;
  viewState.isPanning = false;

  sourceCanvas.width = 0;
  sourceCanvas.height = 0;
  maskCanvas.width = 0;
  maskCanvas.height = 0;

  setOutputState("no-output");
  render();
  syncUi();
}

async function removeWatermark() {
  if (!jobState.imageSource || !viewState.image) {
    jobState.error = "Load an image first";
    syncUi();
    return;
  }

  if (!hasMaskPixels()) {
    jobState.error = "Mask is empty. Paint over the watermark before removing.";
    syncUi();
    return;
  }

  try {
    jobState.error = null;
    jobState.status = "processing";
    jobState.progress = { stage: "exporting_mask", percent: 15, error: null };
    currentJobStartedAt = performance.now();
    lastProcessingSeconds = null;
    setOutputState("processing");
    syncUi();

    const maskDataUrl = maskCanvas.toDataURL("image/png");
    const maskPath = await window.backend.writeMaskDataUrl(maskDataUrl);
    jobState.maskSource = maskPath;
    jobState.progress = { stage: "starting_backend_job", percent: 30, error: null };
    syncUi();

    const started = await window.backend.startInpaint({
      image_path: jobState.imageSource,
      mask_path: jobState.maskSource,
      device: selectedDevice,
    });

    currentJobId = started.job_id;
    while (true) {
      const detail = await window.backend.getJob(currentJobId);
      jobState.progress = detail.progress;
      jobState.status = detail.status;
      jobState.output = detail.output_path || null;
      if (detail.status === "completed") {
        currentJobId = null;
        if (currentJobStartedAt !== null) {
          lastProcessingSeconds = (performance.now() - currentJobStartedAt) / 1000;
        }
        currentJobStartedAt = null;
        paintOutput(jobState.output);
        syncUi();
        return;
      }
      if (detail.status === "cancelled") {
        currentJobId = null;
        currentJobStartedAt = null;
        jobState.status = "cancelled";
        jobState.error = null;
        jobState.progress = { stage: "cancelled", percent: 0, error: null };
        setOutputState("no-output");
        syncUi();
        return;
      }
      if (detail.status === "failed") {
        currentJobId = null;
        currentJobStartedAt = null;
        throw new Error(detail.progress?.error || `Job ${detail.status}`);
      }
      syncUi();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    currentJobId = null;
    currentJobStartedAt = null;
    jobState.status = "error";
    jobState.error = error?.message || String(error);
    setOutputState("error");
    syncUi();
  }
}

async function cancelCurrentJob() {
  if (!currentJobId) {
    return;
  }

  try {
    jobState.status = "cancelling";
    jobState.progress = { stage: "cancelling", percent: jobState.progress.percent || 0, error: null };
    syncUi();
    await window.backend.cancelJob(currentJobId);
  } catch (error) {
    jobState.status = "error";
    jobState.error = `Cancel failed: ${error?.message || error}`;
    setOutputState("error");
    syncUi();
  }
}

async function saveOutputImage() {
  if (!jobState.output) {
    return;
  }

  try {
    const format = outputFormatSelect.value === "jpg" ? "jpg" : "png";
    const savedPath = await window.backend.saveOutput(jobState.output, format);
    if (!savedPath) {
      return;
    }
    jobState.error = null;
    outputStateText.textContent = `Output state: saved to ${savedPath}`;
    syncUi();
  } catch (error) {
    jobState.error = `Save failed: ${error?.message || error}`;
    syncUi();
  }
}

async function openOutputFolder() {
  if (!jobState.output) {
    return;
  }

  try {
    await window.backend.openOutputFolder(jobState.output);
    jobState.error = null;
    syncUi();
  } catch (error) {
    jobState.error = `Open folder failed: ${error?.message || error}`;
    syncUi();
  }
}

async function pickAndLoadImage() {
  try {
    const imagePath = await window.backend.pickImage();
    if (!imagePath) {
      return;
    }
    await loadImage(imagePath);
  } catch (error) {
    jobState.error = `Failed to open image: ${error?.message || error}`;
    syncUi();
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (!viewState.image) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  if (event.button === 1 || event.altKey) {
    viewState.isPanning = true;
    viewState.lastX = event.clientX;
    viewState.lastY = event.clientY;
    return;
  }

  viewState.isDrawing = true;
  viewState.lastX = event.clientX;
  viewState.lastY = event.clientY;
  const p = clientToImagePoint(event.clientX, event.clientY);
  paintMaskLine(p, p);
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (!viewState.image) {
    return;
  }

  if (viewState.isPanning) {
    const dx = event.clientX - viewState.lastX;
    const dy = event.clientY - viewState.lastY;
    viewState.panX += dx;
    viewState.panY += dy;
    viewState.lastX = event.clientX;
    viewState.lastY = event.clientY;
    render();
    return;
  }

  if (!viewState.isDrawing) {
    return;
  }

  const curr = clientToImagePoint(event.clientX, event.clientY);
  const prev = clientToImagePoint(viewState.lastX, viewState.lastY);
  paintMaskLine(prev, curr);
  viewState.lastX = event.clientX;
  viewState.lastY = event.clientY;
  render();
});

canvas.addEventListener("pointerup", () => {
  viewState.isDrawing = false;
  viewState.isPanning = false;
});

canvas.addEventListener("pointerleave", () => {
  viewState.isDrawing = false;
  viewState.isPanning = false;
});

canvas.addEventListener("wheel", (event) => {
  if (!viewState.image) {
    return;
  }
  event.preventDefault();
  const before = clientToImagePoint(event.clientX, event.clientY);
  const delta = event.deltaY < 0 ? 1.1 : 0.9;
  viewState.zoom = Math.min(4, Math.max(0.25, viewState.zoom * delta));

  const rect = canvas.getBoundingClientRect();
  viewState.panX = event.clientX - rect.left - before.x * viewState.zoom;
  viewState.panY = event.clientY - rect.top - before.y * viewState.zoom;
  zoomSlider.value = String(Math.round(viewState.zoom * 100));
  syncUi();
  render();
}, { passive: false });

window.addEventListener("resize", resizeCanvas);

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("active");
});

window.addEventListener("dragleave", () => {
  dropZone.classList.remove("active");
});

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("active");

  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(ext)) {
    jobState.error = "Only PNG and JPG are supported";
    syncUi();
    return;
  }

  try {
    await loadImage(file.path);
  } catch (error) {
    jobState.error = `Failed to load image: ${error?.message || error}`;
    syncUi();
  }
});

brushSizeInput.addEventListener("input", () => {
  viewState.brushSize = Number(brushSizeInput.value);
  syncUi();
});

zoomSlider.addEventListener("input", () => {
  viewState.zoom = Number(zoomSlider.value) / 100;
  syncUi();
  render();
});

eraserBtn.addEventListener("click", () => {
  viewState.eraser = !viewState.eraser;
  syncUi();
});

clearMaskBtn.addEventListener("click", () => {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  jobState.error = null;
  render();
  syncUi();
});

resetViewBtn.addEventListener("click", () => {
  fitImageToView();
  render();
});

openImageBtn.addEventListener("click", async () => {
  await pickAndLoadImage();
});

removeBtn.addEventListener("click", async () => {
  await removeWatermark();
});

cancelBtn.addEventListener("click", async () => {
  await cancelCurrentJob();
});

retryBtn.addEventListener("click", async () => {
  if (!jobState.imageSource) {
    return;
  }
  jobState.error = null;
  syncUi();
  await removeWatermark();
});

resetJobBtn.addEventListener("click", () => {
  clearJobState();
});

saveOutputBtn.addEventListener("click", async () => {
  await saveOutputImage();
});

openFolderBtn.addEventListener("click", async () => {
  await openOutputFolder();
});

deviceSelect.addEventListener("change", () => {
  selectedDevice = deviceSelect.value || "cpu";
});

outputZoomInBtn.addEventListener("click", () => {
  setOutputZoom(outputZoom * 1.2);
});

outputZoomOutBtn.addEventListener("click", () => {
  setOutputZoom(outputZoom / 1.2);
});

outputZoomResetBtn.addEventListener("click", () => {
  setOutputZoom(1);
});

resultArea.addEventListener("wheel", (event) => {
  const image = resultArea.querySelector("img");
  if (!image) {
    return;
  }
  event.preventDefault();
  const delta = event.deltaY < 0 ? 1.1 : 0.9;
  setOutputZoom(outputZoom * delta);
}, { passive: false });

window.backend.onStatusChanged((status) => {
  setBackendStatus(status);
  if (status.lastError && jobState.status !== "processing") {
    jobState.error = status.lastError;
    syncUi();
  }
});

if (window.updater) {
  window.updater.onUpdateAvailable((payload) => {
    updateInstallVersion = payload?.version || null;
    updateInstallAccepted = false;
    const meta = updateInstallVersion ? `Version ${updateInstallVersion}` : "";
    showUpdateToast("A new update is available. Restart to install?", meta);
    if (updateToastMeta) {
      updateToastMeta.textContent = meta;
    }
  });

  window.updater.onDownloadProgress((payload) => {
    if (!updatePromptVisible || !updateInstallAccepted || !updateToastMeta) {
      return;
    }
    const percent = Math.max(0, Math.min(100, Number(payload?.percent || 0)));
    updateToastMeta.textContent = `Downloading update... ${percent.toFixed(0)}%`;
  });

  window.updater.onUpdateDownloaded(() => {
    if (updateToastMeta && updateInstallAccepted) {
      updateToastMeta.textContent = "Installing update and restarting...";
    }
  });

  window.updater.onError((payload) => {
    if (!updateToastMeta) {
      return;
    }
    const message = payload?.message ? String(payload.message) : "Update check failed";
    updateToastMeta.textContent = message;
  });
}

if (updateYesBtn) {
  updateYesBtn.addEventListener("click", async () => {
    if (!window.updater) {
      return;
    }
    updateInstallAccepted = true;
    if (updateToastMeta) {
      updateToastMeta.textContent = "Downloading update in background...";
    }
    updateYesBtn.disabled = true;
    updateLaterBtn.disabled = true;
    try {
      await window.updater.acceptInstall();
    } catch (error) {
      updateInstallAccepted = false;
      updateYesBtn.disabled = false;
      updateLaterBtn.disabled = false;
      if (updateToastMeta) {
        updateToastMeta.textContent = `Update failed: ${error?.message || error}`;
      }
    }
  });
}

if (updateLaterBtn) {
  updateLaterBtn.addEventListener("click", async () => {
    if (window.updater) {
      try {
        await window.updater.deferInstall();
      } catch {
        // Ignore defer errors and still hide the non-critical toast.
      }
    }
    hideUpdateToast();
    if (updateYesBtn) {
      updateYesBtn.disabled = false;
    }
    if (updateLaterBtn) {
      updateLaterBtn.disabled = false;
    }
  });
}

const themeToggleBtn = document.getElementById("themeToggleBtn");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const nextTheme = currentTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    applyTheme(nextTheme);
  });
}

(async function init() {
  loadTheme();
  resizeCanvas();
  setOutputState("no-output");
  syncUi();

  try {
    const status = await window.backend.getStatus();
    setBackendStatus(status);
    const detectedDevices = await window.backend.getDevices();
    populateDevices(detectedDevices);
  } catch (error) {
    populateDevices([{ id: "cpu", label: "CPU (slower)" }]);
    jobState.error = `Failed to query backend: ${error?.message || error}`;
    syncUi();
  }
})();
