const canvas = document.getElementById("paintCanvas");
const canvasWrap = document.getElementById("canvasWrap");
const dropZone = document.getElementById("dropZone");
const resultArea = document.getElementById("resultArea");
const backendPill = document.getElementById("backendPill");
const statusText = document.getElementById("statusText");
const fileText = document.getElementById("fileText");

const brushSizeInput = document.getElementById("brushSize");
const brushSizeLabel = document.getElementById("brushSizeLabel");
const zoomSlider = document.getElementById("zoomSlider");
const zoomLabel = document.getElementById("zoomLabel");
const eraserBtn = document.getElementById("eraserBtn");
const clearMaskBtn = document.getElementById("clearMaskBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const removeBtn = document.getElementById("removeBtn");

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

  statusText.textContent = `Status: ${jobState.status}`;
  if (jobState.progress.stage && jobState.status === "processing") {
    statusText.textContent = `Status: ${jobState.progress.stage} ${jobState.progress.percent}%`;
  }
  if (jobState.error) {
    statusText.textContent = `Status: error - ${jobState.error}`;
  }

  fileText.textContent = jobState.imageSource || "No image selected";
}

function setBackendStatus(status) {
  backendPill.textContent = `Backend: ${status.state}`;
  backendPill.style.background = status.ready ? "#d6f6f1" : "#fef3c7";
  backendPill.style.color = status.ready ? "#147d75" : "#92400e";
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
    resultArea.innerHTML = '<div class="empty-note">Run removal to preview output.</div>';
    return;
  }
  const src = fileUrlFromPath(path);
  resultArea.innerHTML = `<img alt="Output preview" src="${src}?t=${Date.now()}" />`;
}

async function removeWatermark() {
  if (!jobState.imageSource || !viewState.image) {
    jobState.error = "Load an image first";
    syncUi();
    return;
  }

  try {
    jobState.error = null;
    jobState.status = "processing";
    jobState.progress = { stage: "exporting_mask", percent: 15, error: null };
    syncUi();

    const maskDataUrl = maskCanvas.toDataURL("image/png");
    const maskPath = await window.backend.writeMaskDataUrl(maskDataUrl);
    jobState.maskSource = maskPath;
    jobState.progress = { stage: "starting_backend_job", percent: 30, error: null };
    syncUi();

    const started = await window.backend.startInpaint({
      image_path: jobState.imageSource,
      mask_path: jobState.maskSource,
    });

    const jobId = started.job_id;
    while (true) {
      const detail = await window.backend.getJob(jobId);
      jobState.progress = detail.progress;
      jobState.status = detail.status;
      jobState.output = detail.output_path || null;
      if (detail.status === "completed") {
        paintOutput(jobState.output);
        syncUi();
        return;
      }
      if (detail.status === "failed" || detail.status === "cancelled") {
        throw new Error(detail.progress?.error || `Job ${detail.status}`);
      }
      syncUi();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    jobState.status = "error";
    jobState.error = error?.message || String(error);
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
  render();
});

resetViewBtn.addEventListener("click", () => {
  fitImageToView();
  render();
});

removeBtn.addEventListener("click", async () => {
  await removeWatermark();
});

window.backend.onStatusChanged((status) => {
  setBackendStatus(status);
  if (status.lastError && jobState.status !== "processing") {
    jobState.error = status.lastError;
    syncUi();
  }
});

(async function init() {
  resizeCanvas();
  syncUi();

  try {
    const status = await window.backend.getStatus();
    setBackendStatus(status);
  } catch (error) {
    jobState.error = `Failed to query backend: ${error?.message || error}`;
    syncUi();
  }
})();
