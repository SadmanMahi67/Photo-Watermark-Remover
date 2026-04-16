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
const openProjectBtn = document.getElementById("openProjectBtn");
const projectPathText = document.getElementById("projectPathText");
const projectImageList = document.getElementById("projectImageList");

const brushSizeInput = document.getElementById("brushSize");
const brushSizeLabel = document.getElementById("brushSizeLabel");
const suggestStrengthInput = document.getElementById("suggestStrength");
const suggestStrengthLabel = document.getElementById("suggestStrengthLabel");
const suggestPresetLowBtn = document.getElementById("suggestPresetLow");
const suggestPresetMediumBtn = document.getElementById("suggestPresetMedium");
const suggestPresetHighBtn = document.getElementById("suggestPresetHigh");
const detectionNote = document.getElementById("detectionNote");
const detectionRegionList = document.getElementById("detectionRegionList");
const selectAllRegionsBtn = document.getElementById("selectAllRegionsBtn");
const selectNoneRegionsBtn = document.getElementById("selectNoneRegionsBtn");
const zoomSlider = document.getElementById("zoomSlider");
const zoomLabel = document.getElementById("zoomLabel");
const openImageBtn = document.getElementById("openImageBtn");
const suggestMaskBtn = document.getElementById("suggestMaskBtn");
const suggestQueueBtn = document.getElementById("suggestQueueBtn");
const toggleSuggestPreviewBtn = document.getElementById("toggleSuggestPreviewBtn");
const applySuggestedMaskBtn = document.getElementById("applySuggestedMaskBtn");
const autoRemoveBtn = document.getElementById("autoRemoveBtn");
const eraserBtn = document.getElementById("eraserBtn");
const clearMaskBtn = document.getElementById("clearMaskBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const removeBtn = document.getElementById("removeBtn");
const addToQueueBtn = document.getElementById("addToQueueBtn");
const cancelBtn = document.getElementById("cancelBtn");
const retryBtn = document.getElementById("retryBtn");
const resetJobBtn = document.getElementById("resetJobBtn");
const processAllBtn = document.getElementById("processAllBtn");
const clearQueueBtn = document.getElementById("clearQueueBtn");
const queueList = document.getElementById("queueList");
const queueCountLabel = document.getElementById("queueCountLabel");

const ctx = canvas.getContext("2d");
const sourceCanvas = document.createElement("canvas");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const suggestedMaskCanvas = document.createElement("canvas");
const suggestedMaskCtx = suggestedMaskCanvas.getContext("2d");
const rawSuggestedMaskCanvas = document.createElement("canvas");
const rawSuggestedMaskCtx = rawSuggestedMaskCanvas.getContext("2d");

const jobState = {
  imageSource: null,
  maskSource: null,
  status: "idle",
  progress: { stage: "idle", percent: 0, error: null },
  output: null,
  error: null,
};

const queueStore = {
  jobsById: new Map(),
  activeJobId: null,
  queuedItems: [],
  processingAll: false,
};

const projectState = {
  project: null,
};

let backendReady = false;
let outputPanelState = "no-output";
let currentJobStartedAt = null;
let lastProcessingSeconds = null;
let selectedDevice = "cpu";
let outputZoom = 1;
let updatePromptVisible = false;
let updateInstallVersion = null;
let updateInstallAccepted = false;
let currentTheme = "light";
let suggestStrength = Number(suggestStrengthInput?.value || 50);
let suggestPreset = "medium";
let previewSuggestedMask = false;

const SUGGEST_PRESET_STRENGTH = {
  low: 30,
  medium: 50,
  high: 75,
};

const suggestedMaskState = {
  available: false,
  imagePath: null,
  maskPath: null,
};

const detectState = {
  detector: null,
  detections: 0,
  maskedAreaRatio: 0,
  regions: [],
};

const THEME_KEY = "pwr.theme";
const THEME_LIGHT = "light";
const THEME_DARK = "dark";

function upsertQueueJob(job) {
  if (!job || !job.job_id) {
    return;
  }
  queueStore.jobsById.set(job.job_id, {
    ...(queueStore.jobsById.get(job.job_id) || {}),
    ...job,
  });
}

function setActiveQueueJob(jobId) {
  queueStore.activeJobId = jobId || null;
}

async function refreshQueueSnapshot() {
  if (!window.backend?.getJobs) {
    return;
  }
  const jobs = await window.backend.getJobs();
  if (!Array.isArray(jobs)) {
    return;
  }
  for (const job of jobs) {
    upsertQueueJob(job);
  }
}

function fileNameFromPath(inputPath) {
  if (!inputPath) {
    return "";
  }
  const slash = Math.max(inputPath.lastIndexOf("/"), inputPath.lastIndexOf("\\"));
  return slash >= 0 ? inputPath.slice(slash + 1) : inputPath;
}

function isProjectImageActive(imagePath) {
  return Boolean(projectState.project && projectState.project.activeImagePath === imagePath);
}

function projectImageStatus(imagePath) {
  const status = projectState.project?.jobHistory?.[imagePath]?.status || null;
  if (!status) {
    return { label: "New", className: "pending" };
  }
  if (status === "processing") {
    return { label: "Processing", className: "processing" };
  }
  if (status === "completed") {
    return { label: "Done", className: "completed" };
  }
  if (status === "failed") {
    return { label: "Failed", className: "failed" };
  }
  if (status === "cancelled") {
    return { label: "Cancelled", className: "cancelled" };
  }
  return { label: String(status), className: "pending" };
}

function hasSuggestedMaskPreview() {
  return Boolean(
    suggestedMaskState.available
    && suggestedMaskState.imagePath
    && suggestedMaskState.imagePath === jobState.imageSource
    && suggestedMaskCanvas.width > 0
    && suggestedMaskCanvas.height > 0,
  );
}

function clearSuggestedMaskPreview() {
  suggestedMaskState.available = false;
  suggestedMaskState.imagePath = null;
  suggestedMaskState.maskPath = null;
  suggestedMaskCanvas.width = 0;
  suggestedMaskCanvas.height = 0;
  rawSuggestedMaskCanvas.width = 0;
  rawSuggestedMaskCanvas.height = 0;
  detectState.detector = null;
  detectState.detections = 0;
  detectState.maskedAreaRatio = 0;
  detectState.regions = [];
}

function sanitizeRegion(region, width, height) {
  const x = Math.max(0, Math.min(width - 1, Number(region?.x || 0)));
  const y = Math.max(0, Math.min(height - 1, Number(region?.y || 0)));
  const w = Math.max(1, Math.min(width - x, Number(region?.width || 1)));
  const h = Math.max(1, Math.min(height - y, Number(region?.height || 1)));
  const confidence = Math.max(0, Math.min(1, Number(region?.confidence || 0)));
  return {
    x,
    y,
    width: w,
    height: h,
    confidence,
    selected: true,
  };
}

function renderDetectionRegions() {
  if (!detectionRegionList) {
    return;
  }

  if (!detectState.regions.length) {
    detectionRegionList.innerHTML = "";
    return;
  }

  const html = detectState.regions.map((region, index) => {
    const checked = region.selected ? "checked" : "";
    const confidence = Math.round(region.confidence * 100);
    return `
      <li class="detect-region-item">
        <input type="checkbox" data-detect-region-index="${index}" ${checked} />
        <span>Region ${index + 1} (${region.width}x${region.height}) ${confidence}%</span>
      </li>
    `;
  }).join("");

  detectionRegionList.innerHTML = html;
}

function rebuildSuggestedMaskFromSelectedRegions() {
  if (rawSuggestedMaskCanvas.width === 0 || rawSuggestedMaskCanvas.height === 0) {
    suggestedMaskCanvas.width = 0;
    suggestedMaskCanvas.height = 0;
    return;
  }

  suggestedMaskCanvas.width = rawSuggestedMaskCanvas.width;
  suggestedMaskCanvas.height = rawSuggestedMaskCanvas.height;
  suggestedMaskCtx.clearRect(0, 0, suggestedMaskCanvas.width, suggestedMaskCanvas.height);

  if (!detectState.regions.length) {
    suggestedMaskCtx.drawImage(rawSuggestedMaskCanvas, 0, 0, suggestedMaskCanvas.width, suggestedMaskCanvas.height);
    return;
  }

  for (const region of detectState.regions) {
    if (!region.selected) {
      continue;
    }
    suggestedMaskCtx.drawImage(
      rawSuggestedMaskCanvas,
      region.x,
      region.y,
      region.width,
      region.height,
      region.x,
      region.y,
      region.width,
      region.height,
    );
  }
}

function setAllDetectionRegions(selected) {
  if (!detectState.regions.length) {
    return;
  }
  detectState.regions = detectState.regions.map((region) => ({ ...region, selected }));
  rebuildSuggestedMaskFromSelectedRegions();
  renderDetectionRegions();
  render();
  syncUi();
}

function updatePresetButtonsUi() {
  suggestPresetLowBtn?.classList.toggle("toggle-on", suggestPreset === "low");
  suggestPresetMediumBtn?.classList.toggle("toggle-on", suggestPreset === "medium");
  suggestPresetHighBtn?.classList.toggle("toggle-on", suggestPreset === "high");
}

function setSuggestPreset(nextPreset, options = {}) {
  const persist = options.persist !== false;
  if (!Object.prototype.hasOwnProperty.call(SUGGEST_PRESET_STRENGTH, nextPreset)) {
    return;
  }
  suggestPreset = nextPreset;
  suggestStrength = SUGGEST_PRESET_STRENGTH[nextPreset];
  if (suggestStrengthInput) {
    suggestStrengthInput.value = String(suggestStrength);
  }
  if (persist) {
    persistProjectAutoMaskSettings().catch(() => {});
  }
  syncUi();
}

function projectImageHistory(imagePath) {
  return projectState.project?.jobHistory?.[imagePath] || null;
}

function formatProjectUpdatedAt(ts) {
  if (!Number.isFinite(Number(ts))) {
    return "Unknown time";
  }
  const date = new Date(Number(ts));
  return date.toLocaleString();
}

function projectStatusTooltip(imagePath, statusLabel) {
  const history = projectImageHistory(imagePath);
  if (!history) {
    return "No jobs yet";
  }

  const when = formatProjectUpdatedAt(history.updatedAt);
  const outputHint = history.outputPath ? " | Click badge to preview output" : "";
  return `${statusLabel} | Last run: ${when}${outputHint}`;
}

function serializeQueueForProject() {
  return queueStore.queuedItems.map((item) => ({
    id: item.id,
    imagePath: item.imagePath,
    maskPath: item.maskPath,
    device: item.device,
    status: item.status,
    progress: item.progress,
    backendJobId: item.backendJobId,
    outputPath: item.outputPath,
    error: item.error,
    createdAt: item.createdAt,
  }));
}

function hydrateQueueItem(raw) {
  return {
    id: String(raw?.id || `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    imagePath: raw?.imagePath || "",
    maskPath: raw?.maskPath || "",
    device: raw?.device || selectedDevice,
    status: raw?.status || "pending",
    progress: raw?.progress || { stage: "pending", percent: 0, error: null },
    backendJobId: raw?.backendJobId || null,
    outputPath: raw?.outputPath || null,
    error: raw?.error || null,
    createdAt: Number(raw?.createdAt || Date.now()),
  };
}

async function persistQueueToProject() {
  if (!projectState.project || !window.projects?.setQueue) {
    return;
  }

  const saved = await window.projects.setQueue(serializeQueueForProject());
  if (Array.isArray(saved)) {
    queueStore.queuedItems = saved.map(hydrateQueueItem);
  }
}

async function restoreQueueFromProject() {
  if (!projectState.project || !window.projects?.getQueue) {
    return;
  }

  const saved = await window.projects.getQueue();
  if (!Array.isArray(saved)) {
    return;
  }

  queueStore.queuedItems = saved.map(hydrateQueueItem);
  queueStore.activeJobId = null;
  queueStore.processingAll = false;
}

function currentProjectImageIndex() {
  const images = projectState.project?.images || [];
  const active = projectState.project?.activeImagePath || null;
  if (!active || !images.length) {
    return -1;
  }
  return images.indexOf(active);
}

async function selectAdjacentProjectImage(offset) {
  if (!projectState.project?.images?.length) {
    return;
  }
  const currentIndex = currentProjectImageIndex();
  if (currentIndex < 0) {
    return;
  }
  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= projectState.project.images.length) {
    return;
  }
  await selectProjectImage(projectState.project.images[nextIndex]);
}

function renderProjectImages() {
  if (!projectImageList || !projectPathText) {
    return;
  }

  const project = projectState.project;
  if (!project) {
    projectPathText.textContent = "No project folder opened.";
    projectImageList.innerHTML = "<li class=\"empty-note\">Open a folder to start a project.</li>";
    return;
  }

  projectPathText.textContent = project.folderPath || "Project opened";
  const images = Array.isArray(project.images) ? project.images : [];
  if (!images.length) {
    projectImageList.innerHTML = "<li class=\"empty-note\">No PNG/JPG images found in this folder.</li>";
    return;
  }

  const html = images.map((imagePath) => {
    const name = fileNameFromPath(imagePath);
    const activeClass = isProjectImageActive(imagePath) ? "active" : "";
    const imageStatus = projectImageStatus(imagePath);
    const history = projectImageHistory(imagePath);
    const hasOutputClass = history?.outputPath ? "has-output" : "";
    const statusTitle = projectStatusTooltip(imagePath, imageStatus.label).replace(/"/g, "&quot;");
    const safePath = String(imagePath).replace(/"/g, "&quot;");
    const thumb = fileUrlFromPath(imagePath);
    return `
      <li>
        <button class="project-image-btn ${activeClass} ${hasOutputClass}" type="button" data-project-image="${safePath}" title="${safePath}">
          <img class="project-image-thumb" src="${thumb}" alt="${name}" />
          <span class="project-image-name">${name}</span>
          <span class="project-image-status ${imageStatus.className}" title="${statusTitle}">${imageStatus.label}</span>
        </button>
      </li>
    `;
  }).join("");

  projectImageList.innerHTML = html;
}

async function persistCurrentMaskToProject() {
  if (!projectState.project || !jobState.imageSource || !window.projects?.saveMask) {
    return;
  }
  if (!projectState.project.images?.includes(jobState.imageSource)) {
    return;
  }

  const dataUrl = maskCanvas.toDataURL("image/png");
  await window.projects.saveMask(jobState.imageSource, dataUrl);
}

async function loadMaskFromPath(maskPath) {
  if (!maskPath) {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    render();
    return;
  }

  await loadMaskIntoCanvas(maskPath, maskCanvas, maskCtx);
  render();
}

async function loadMaskIntoCanvas(maskPath, targetCanvas, targetCtx) {
  if (!maskPath) {
    targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    return;
  }

  const img = new Image();
  const src = fileUrlFromPath(maskPath);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = src;
  });

  if (targetCanvas.width !== maskCanvas.width || targetCanvas.height !== maskCanvas.height) {
    targetCanvas.width = maskCanvas.width;
    targetCanvas.height = maskCanvas.height;
  }
  targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  targetCtx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
}

async function applySuggestedMaskToEditor(options = {}) {
  const persist = options.persist !== false;
  if (!hasSuggestedMaskPreview()) {
    return;
  }
  if (detectState.regions.length && !detectState.regions.some((region) => region.selected)) {
    jobState.error = "No detection regions selected. Select at least one region.";
    syncUi();
    return;
  }

  if (maskCanvas.width !== suggestedMaskCanvas.width || maskCanvas.height !== suggestedMaskCanvas.height) {
    maskCanvas.width = suggestedMaskCanvas.width;
    maskCanvas.height = suggestedMaskCanvas.height;
  }
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.drawImage(suggestedMaskCanvas, 0, 0, maskCanvas.width, maskCanvas.height);
  jobState.maskSource = suggestedMaskState.maskPath;
  if (persist) {
    await persistCurrentMaskToProject();
  }
  render();
}

async function selectProjectImage(imagePath) {
  if (!projectState.project || !imagePath || !window.projects?.selectImage) {
    return;
  }

  projectState.project = await window.projects.selectImage(imagePath);
  await loadImage(imagePath);

  const maskPath = await window.projects.getMaskPath(imagePath);
  await loadMaskFromPath(maskPath);
  renderProjectImages();
}

async function openProjectFolderFlow() {
  if (!window.projects?.pickFolder || !window.projects?.openFolder) {
    return;
  }

  const folderPath = await window.projects.pickFolder();
  if (!folderPath) {
    return;
  }

  projectState.project = await window.projects.openFolder(folderPath);
  applyProjectSettingsToUi();
  await restoreQueueFromProject();
  renderProjectImages();
  if (projectState.project?.activeImagePath) {
    await selectProjectImage(projectState.project.activeImagePath);
  }
  syncUi();
}

async function updateProjectJobHistory(imagePath, status, outputPath, jobId) {
  if (!projectState.project || !window.projects?.updateJobHistory || !imagePath) {
    return;
  }
  projectState.project = await window.projects.updateJobHistory({
    imagePath,
    status,
    outputPath: outputPath || null,
    jobId: jobId || null,
  });
  renderProjectImages();
}

function applyProjectSettingsToUi() {
  const autoMask = projectState.project?.settings?.autoMask || {};
  const presetValue = String(autoMask.preset || "medium").toLowerCase();
  if (["low", "medium", "high"].includes(presetValue)) {
    suggestPreset = presetValue;
  }

  const defaultStrength = SUGGEST_PRESET_STRENGTH[suggestPreset] || 50;
  const value = Number(autoMask.strength || defaultStrength);
  suggestStrength = Math.max(1, Math.min(100, Number.isFinite(value) ? value : defaultStrength));
  previewSuggestedMask = Boolean(autoMask.previewSuggestedMask);
  if (suggestStrengthInput) {
    suggestStrengthInput.value = String(suggestStrength);
  }
  updatePresetButtonsUi();
}

async function persistProjectAutoMaskSettings() {
  if (!projectState.project || !window.projects?.updateSettings) {
    return;
  }

  projectState.project = await window.projects.updateSettings({
    autoMask: {
      strength: suggestStrength,
      preset: suggestPreset,
      previewSuggestedMask,
    },
  });
}

function createQueueItem(payload) {
  return {
    id: `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    imagePath: payload.imagePath,
    maskPath: payload.maskPath,
    device: payload.device,
    status: "pending",
    progress: { stage: "pending", percent: 0, error: null },
    backendJobId: null,
    outputPath: null,
    error: null,
    createdAt: Date.now(),
  };
}

function queueStatusLabel(item) {
  if (item.status === "processing") {
    return `${humanStage(item.progress?.stage)} ${Number(item.progress?.percent || 0)}%`;
  }
  if (item.status === "pending") {
    return "Pending";
  }
  if (item.status === "completed") {
    return "Completed";
  }
  if (item.status === "failed") {
    return "Failed";
  }
  if (item.status === "cancelled") {
    return "Cancelled";
  }
  return String(item.status || "Unknown");
}

function queueStatusClass(item) {
  if (item.status === "processing") return "processing";
  if (item.status === "pending") return "pending";
  if (item.status === "completed") return "completed";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled") return "cancelled";
  return "pending";
}

function hasPendingQueueItems() {
  return queueStore.queuedItems.some((item) => item.status === "pending");
}

function renderQueueList() {
  if (!queueList) {
    return;
  }

  if (queueCountLabel) {
    queueCountLabel.textContent = `${queueStore.queuedItems.length} item${queueStore.queuedItems.length === 1 ? "" : "s"}`;
  }

  if (!queueStore.queuedItems.length) {
    queueList.innerHTML = "<li class=\"empty-note\">No queued jobs yet.</li>";
    return;
  }

  const html = queueStore.queuedItems.map((item) => {
    const canCancel = item.status === "pending" || item.status === "processing";
    const canRemove = item.status !== "processing";
    const statusText = queueStatusLabel(item);
    const statusClass = queueStatusClass(item);
    const errorText = item.error ? ` | ${item.error}` : "";
    const title = String(item.imagePath || "").replace(/"/g, "&quot;");
    const thumbSrc = item.imagePath ? fileUrlFromPath(item.imagePath) : "";
    const activeClass = queueStore.activeJobId === item.backendJobId && item.backendJobId ? "active" : "";

    return `
      <li class="queue-item ${activeClass}" data-queue-id="${item.id}">
        <img class="queue-item-thumb" src="${thumbSrc}" alt="Thumbnail" />
        <div class="queue-item-main">
          <div class="queue-item-path" title="${title}">${item.imagePath || "(unknown image)"}</div>
          <div class="queue-item-meta">
            <span class="queue-status ${statusClass}">${statusText}</span>
            ${errorText ? `<span>${errorText}</span>` : ""}
          </div>
        </div>
        <div class="queue-item-controls">
          <button type="button" data-action="cancel" data-queue-id="${item.id}" ${canCancel ? "" : "disabled"}>Cancel</button>
          <button type="button" data-action="remove" data-queue-id="${item.id}" ${canRemove ? "" : "disabled"}>Remove</button>
        </div>
      </li>
    `;
  }).join("");

  queueList.innerHTML = html;
}

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
    detecting_watermark: "Detecting watermark",
    suggesting_mask: "Suggesting mask",
    queuing: "Adding to queue",
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
  if (suggestStrengthLabel) {
    suggestStrengthLabel.textContent = `${Math.round(suggestStrength)}%`;
  }
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
  const queueBusy = queueStore.processingAll;
  const activeJobId = queueStore.activeJobId;
  const canRetry = Boolean(hasImage && jobState.error);
  removeBtn.disabled = !hasImage || running || !backendReady || queueBusy;
  addToQueueBtn.disabled = !hasImage || running || !backendReady || queueBusy;
  processAllBtn.disabled = !hasPendingQueueItems() || !backendReady || running || queueBusy;
  clearQueueBtn.disabled = queueBusy || queueStore.queuedItems.length === 0;
  openImageBtn.disabled = running || queueBusy;
  if (suggestMaskBtn) suggestMaskBtn.disabled = !hasImage || running || queueBusy || !backendReady;
  if (suggestQueueBtn) suggestQueueBtn.disabled = !hasImage || running || queueBusy || !backendReady;
  if (autoRemoveBtn) autoRemoveBtn.disabled = !hasImage || running || queueBusy || !backendReady;
  if (toggleSuggestPreviewBtn) {
    toggleSuggestPreviewBtn.disabled = !hasSuggestedMaskPreview() || running || queueBusy;
  }
  if (applySuggestedMaskBtn) {
    applySuggestedMaskBtn.disabled = !hasSuggestedMaskPreview() || running || queueBusy;
  }
  eraserBtn.disabled = running || queueBusy || !hasImage;
  clearMaskBtn.disabled = running || queueBusy || !hasImage;
  resetViewBtn.disabled = running || queueBusy || !hasImage;
  cancelBtn.disabled = !activeJobId || !running;
  retryBtn.disabled = !canRetry || running;
  resetJobBtn.disabled = running || queueBusy;
  saveOutputBtn.disabled = !hasOutput || running || queueBusy;
  openFolderBtn.disabled = !hasOutput || running || queueBusy;
  outputFormatSelect.disabled = running || queueBusy;
  deviceSelect.disabled = running || queueBusy;
  if (suggestStrengthInput) {
    suggestStrengthInput.disabled = running || queueBusy;
  }
  if (suggestPresetLowBtn) suggestPresetLowBtn.disabled = running || queueBusy;
  if (suggestPresetMediumBtn) suggestPresetMediumBtn.disabled = running || queueBusy;
  if (suggestPresetHighBtn) suggestPresetHighBtn.disabled = running || queueBusy;
  if (selectAllRegionsBtn) {
    selectAllRegionsBtn.disabled = running || queueBusy || detectState.regions.length === 0;
  }
  if (selectNoneRegionsBtn) {
    selectNoneRegionsBtn.disabled = running || queueBusy || detectState.regions.length === 0;
  }

  if (toggleSuggestPreviewBtn) {
    toggleSuggestPreviewBtn.textContent = `Preview Suggested: ${previewSuggestedMask ? "On" : "Off"}`;
    toggleSuggestPreviewBtn.classList.toggle("toggle-on", previewSuggestedMask);
  }
  updatePresetButtonsUi();

  if (detectionNote) {
    if (detectState.detector) {
      const percent = Math.round(detectState.maskedAreaRatio * 100);
      const selected = detectState.regions.length
        ? detectState.regions.filter((region) => region.selected).length
        : detectState.detections;
      detectionNote.textContent = `Detector: ${detectState.detector} | Regions: ${selected}/${detectState.detections} | Coverage: ${percent}%`;
    } else {
      detectionNote.textContent = "";
    }
  }

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
  renderDetectionRegions();
  renderQueueList();
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

  const drawTintedMask = (maskSourceCanvas, fillStyle) => {
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = maskSourceCanvas.width;
    overlayCanvas.height = maskSourceCanvas.height;
    const overlayCtx = overlayCanvas.getContext("2d");
    overlayCtx.drawImage(maskSourceCanvas, 0, 0);
    overlayCtx.globalCompositeOperation = "source-in";
    overlayCtx.fillStyle = fillStyle;
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.drawImage(overlayCanvas, drawX, drawY, drawW, drawH);
  };

  drawTintedMask(maskCanvas, "rgba(220, 38, 38, 0.55)");
  if (previewSuggestedMask && hasSuggestedMaskPreview()) {
    drawTintedMask(suggestedMaskCanvas, "rgba(14, 165, 233, 0.45)");
  }
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
  clearSuggestedMaskPreview();

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
  setActiveQueueJob(null);
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
  clearSuggestedMaskPreview();

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
    await updateProjectJobHistory(jobState.imageSource, "processing", null, started.job_id);

    const startedJob = {
      job_id: started.job_id,
      status: started.status,
      image_path: jobState.imageSource,
      mask_path: jobState.maskSource,
      output_path: null,
      device: selectedDevice,
      progress: { stage: "starting_backend_job", percent: 30, error: null },
    };
    upsertQueueJob(startedJob);
    setActiveQueueJob(started.job_id);

    while (true) {
      const activeJobId = queueStore.activeJobId;
      if (!activeJobId) {
        return;
      }

      const detail = await window.backend.getJob(activeJobId);
      upsertQueueJob(detail);
      jobState.progress = detail.progress;
      jobState.status = detail.status;
      jobState.output = detail.output_path || null;
      if (detail.status === "completed") {
        await updateProjectJobHistory(jobState.imageSource, "completed", detail.output_path || null, detail.job_id);
        setActiveQueueJob(null);
        if (currentJobStartedAt !== null) {
          lastProcessingSeconds = (performance.now() - currentJobStartedAt) / 1000;
        }
        currentJobStartedAt = null;
        paintOutput(jobState.output);
        syncUi();
        return;
      }
      if (detail.status === "cancelled") {
        await updateProjectJobHistory(jobState.imageSource, "cancelled", null, detail.job_id);
        setActiveQueueJob(null);
        currentJobStartedAt = null;
        jobState.status = "cancelled";
        jobState.error = null;
        jobState.progress = { stage: "cancelled", percent: 0, error: null };
        setOutputState("no-output");
        syncUi();
        return;
      }
      if (detail.status === "failed") {
        await updateProjectJobHistory(jobState.imageSource, "failed", detail.output_path || null, detail.job_id);
        setActiveQueueJob(null);
        currentJobStartedAt = null;
        throw new Error(detail.progress?.error || `Job ${detail.status}`);
      }
      syncUi();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    setActiveQueueJob(null);
    currentJobStartedAt = null;
    jobState.status = "error";
    jobState.error = error?.message || String(error);
    setOutputState("error");
    syncUi();
  }
}

async function addCurrentImageToQueue() {
  if (!jobState.imageSource || !viewState.image) {
    jobState.error = "Load an image first";
    syncUi();
    return;
  }

  if (!hasMaskPixels()) {
    jobState.error = "Mask is empty. Paint over the watermark before adding to queue.";
    syncUi();
    return;
  }

  try {
    jobState.error = null;
    const maskDataUrl = maskCanvas.toDataURL("image/png");
    const maskPath = projectState.project && window.projects?.saveMask
      ? await window.projects.saveMask(jobState.imageSource, maskDataUrl)
      : await window.backend.writeMaskDataUrl(maskDataUrl);
    if (projectState.project && window.projects?.saveMask) {
      await persistCurrentMaskToProject();
    }
    queueStore.queuedItems.push(createQueueItem({
      imagePath: jobState.imageSource,
      maskPath,
      device: selectedDevice,
    }));
    await persistQueueToProject();
    syncUi();
  } catch (error) {
    jobState.error = `Failed to add queue item: ${error?.message || error}`;
    syncUi();
  }
}

async function processQueuedItem(item) {
  item.status = "processing";
  item.progress = { stage: "starting_backend_job", percent: 5, error: null };
  item.error = null;
  syncUi();

  const started = await window.backend.startInpaint({
    image_path: item.imagePath,
    mask_path: item.maskPath,
    device: item.device,
  });
  await updateProjectJobHistory(item.imagePath, "processing", null, started.job_id);

  item.backendJobId = started.job_id;
  setActiveQueueJob(started.job_id);

  while (true) {
    const detail = await window.backend.getJob(started.job_id);
    upsertQueueJob(detail);
    item.progress = detail.progress;
    item.outputPath = detail.output_path || null;

    if (detail.status === "completed") {
      item.status = "completed";
      await updateProjectJobHistory(item.imagePath, "completed", detail.output_path || null, detail.job_id);
      setActiveQueueJob(null);
      await persistQueueToProject();
      syncUi();
      return;
    }
    if (detail.status === "cancelled") {
      item.status = "cancelled";
      item.error = null;
      await updateProjectJobHistory(item.imagePath, "cancelled", null, detail.job_id);
      setActiveQueueJob(null);
      await persistQueueToProject();
      syncUi();
      return;
    }
    if (detail.status === "failed") {
      item.status = "failed";
      item.error = detail.progress?.error || "Queue item failed";
      await updateProjectJobHistory(item.imagePath, "failed", detail.output_path || null, detail.job_id);
      setActiveQueueJob(null);
      await persistQueueToProject();
      syncUi();
      return;
    }

    syncUi();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function processAllQueueItems() {
  if (queueStore.processingAll || !hasPendingQueueItems()) {
    return;
  }

  queueStore.processingAll = true;
  syncUi();

  try {
    for (const item of queueStore.queuedItems) {
      if (item.status !== "pending") {
        continue;
      }
      await processQueuedItem(item);
    }
  } catch (error) {
    jobState.error = `Queue processing failed: ${error?.message || error}`;
  } finally {
    queueStore.processingAll = false;
    setActiveQueueJob(null);
    syncUi();
  }
}

async function cancelQueueItem(queueId) {
  const item = queueStore.queuedItems.find((entry) => entry.id === queueId);
  if (!item) {
    return;
  }

  if (item.status === "pending") {
    item.status = "cancelled";
    await persistQueueToProject();
    syncUi();
    return;
  }

  if (item.status === "processing" && item.backendJobId) {
    try {
      await window.backend.cancelJob(item.backendJobId);
    } catch (error) {
      item.error = `Cancel failed: ${error?.message || error}`;
      syncUi();
    }
  }
}

function clearQueueItems() {
  if (queueStore.processingAll) {
    return;
  }
  queueStore.queuedItems = [];
  persistQueueToProject().catch(() => {});
  syncUi();
}

async function cancelCurrentJob() {
  const activeJobId = queueStore.activeJobId;
  if (!activeJobId) {
    return;
  }

  try {
    jobState.status = "cancelling";
    jobState.progress = { stage: "cancelling", percent: jobState.progress.percent || 0, error: null };
    syncUi();
    await window.backend.cancelJob(activeJobId);
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

async function suggestMaskForCurrentImage(options = {}) {
  const queueAfter = Boolean(options.queueAfter);

  if (!jobState.imageSource || !viewState.image) {
    jobState.error = "Load an image first";
    syncUi();
    return;
  }

  if (!window.backend?.suggestMask) {
    jobState.error = "Mask suggestion is unavailable in this build.";
    syncUi();
    return;
  }

  try {
    jobState.error = null;
    jobState.status = "processing";
    jobState.progress = { stage: "detecting_watermark", percent: 18, error: null };
    syncUi();

    const detectAvailable = typeof window.backend.detectMask === "function";
    const response = detectAvailable
      ? await window.backend.detectMask({
        image_path: jobState.imageSource,
        strength: suggestStrength,
        min_area_ratio: 0.0005,
        min_confidence: 0.14,
        max_detections: 24,
      })
      : await window.backend.suggestMask({
        image_path: jobState.imageSource,
        strength: suggestStrength,
      });

    const maskPath = response?.mask_path;
    if (!maskPath) {
      throw new Error("Mask suggestion did not return a mask path.");
    }

    const rawDetections = Array.isArray(response?.detections) ? response.detections : [];
    const detectionCount = rawDetections.length;
    const maskedAreaRatio = Number(response?.masked_area_ratio || 0);
    detectState.detector = String(response?.detector || (detectAvailable ? "detect" : "suggest"));
    detectState.detections = detectionCount;
    detectState.maskedAreaRatio = Math.max(0, Math.min(1, maskedAreaRatio));
    if (detectAvailable && detectionCount === 0) {
      clearSuggestedMaskPreview();
      jobState.status = "ready";
      jobState.error = "No watermark region detected. Try manual masking or adjust strength.";
      jobState.progress = { stage: "ready", percent: 0, error: null };
      render();
      syncUi();
      return;
    }
    if (detectAvailable && maskedAreaRatio > 0.6) {
      clearSuggestedMaskPreview();
      throw new Error(`Detection covered too much area (${Math.round(maskedAreaRatio * 100)}%). Lower strength or mask manually.`);
    }

    jobState.progress = { stage: "suggesting_mask", percent: 85, error: null };
    syncUi();

    await loadMaskIntoCanvas(maskPath, rawSuggestedMaskCanvas, rawSuggestedMaskCtx);
    if (rawDetections.length > 0) {
      detectState.regions = rawDetections
        .map((region) => sanitizeRegion(region, rawSuggestedMaskCanvas.width, rawSuggestedMaskCanvas.height));
    } else {
      detectState.regions = [];
    }
    rebuildSuggestedMaskFromSelectedRegions();
    suggestedMaskState.available = true;
    suggestedMaskState.imagePath = jobState.imageSource;
    suggestedMaskState.maskPath = maskPath;
    previewSuggestedMask = true;
    await persistProjectAutoMaskSettings();

    let persistedMaskPath = maskPath;

    if (queueAfter) {
      await applySuggestedMaskToEditor({ persist: false });
      persistedMaskPath = jobState.maskSource || maskPath;

      if (projectState.project && window.projects?.saveMask) {
        const dataUrl = maskCanvas.toDataURL("image/png");
        persistedMaskPath = await window.projects.saveMask(jobState.imageSource, dataUrl);
        await persistCurrentMaskToProject();
      }

      jobState.progress = { stage: "queuing", percent: 92, error: null };
      syncUi();
      queueStore.queuedItems.push(createQueueItem({
        imagePath: jobState.imageSource,
        maskPath: persistedMaskPath,
        device: selectedDevice,
      }));
      await persistQueueToProject();
    }

    jobState.status = "ready";
    jobState.progress = { stage: "ready", percent: 0, error: null };
    syncUi();
  } catch (error) {
    jobState.status = "error";
    jobState.error = `Mask suggestion failed: ${error?.message || error}`;
    setOutputState("error");
    syncUi();
  }
}

async function autoRemoveWatermark() {
  if (!jobState.imageSource || !viewState.image) {
    jobState.error = "Load an image first";
    syncUi();
    return;
  }

  if (!window.backend?.autoRemove) {
    jobState.error = "Auto remove is unavailable in this build.";
    syncUi();
    return;
  }

  try {
    jobState.error = null;
    jobState.status = "processing";
    jobState.progress = { stage: "detecting_watermark", percent: 14, error: null };
    setOutputState("processing");
    currentJobStartedAt = performance.now();
    lastProcessingSeconds = null;
    syncUi();

    const result = await window.backend.autoRemove({
      image_path: jobState.imageSource,
      device: selectedDevice,
    });

    if (!result?.output_path) {
      throw new Error("Auto remove did not produce output.");
    }

    jobState.output = result.output_path;
    jobState.maskSource = result.mask_path || null;
    jobState.status = "completed";
    jobState.progress = { stage: "completed", percent: 100, error: null };
    if (currentJobStartedAt !== null) {
      lastProcessingSeconds = (performance.now() - currentJobStartedAt) / 1000;
    }
    currentJobStartedAt = null;

    await updateProjectJobHistory(
      jobState.imageSource,
      "completed",
      result.output_path,
      `auto-${Date.now()}`,
    );

    paintOutput(result.output_path);
    syncUi();
  } catch (error) {
    currentJobStartedAt = null;
    jobState.status = "error";
    jobState.error = `Auto remove failed: ${error?.message || error}`;
    setOutputState("error");
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
  persistCurrentMaskToProject().catch(() => {});
});

canvas.addEventListener("pointerleave", () => {
  viewState.isDrawing = false;
  viewState.isPanning = false;
  persistCurrentMaskToProject().catch(() => {});
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

if (suggestStrengthInput) {
  suggestStrengthInput.addEventListener("input", () => {
    suggestStrength = Math.max(1, Math.min(100, Number(suggestStrengthInput.value) || 50));
    const matchedPreset = Object.entries(SUGGEST_PRESET_STRENGTH)
      .find(([, value]) => value === suggestStrength)?.[0];
    suggestPreset = matchedPreset || "medium";
    syncUi();
  });

  suggestStrengthInput.addEventListener("change", () => {
    persistProjectAutoMaskSettings().catch(() => {});
  });
}

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
  persistCurrentMaskToProject().catch(() => {});
});

resetViewBtn.addEventListener("click", () => {
  fitImageToView();
  render();
});

openImageBtn.addEventListener("click", async () => {
  await pickAndLoadImage();
});

if (suggestMaskBtn) {
  suggestMaskBtn.addEventListener("click", async () => {
    await suggestMaskForCurrentImage();
  });
}

if (suggestQueueBtn) {
  suggestQueueBtn.addEventListener("click", async () => {
    await suggestMaskForCurrentImage({ queueAfter: true });
  });
}

if (autoRemoveBtn) {
  autoRemoveBtn.addEventListener("click", async () => {
    await autoRemoveWatermark();
  });
}

if (toggleSuggestPreviewBtn) {
  toggleSuggestPreviewBtn.addEventListener("click", () => {
    if (!hasSuggestedMaskPreview()) {
      return;
    }
    previewSuggestedMask = !previewSuggestedMask;
    persistProjectAutoMaskSettings().catch(() => {});
    render();
    syncUi();
  });
}

if (applySuggestedMaskBtn) {
  applySuggestedMaskBtn.addEventListener("click", async () => {
    await applySuggestedMaskToEditor();
    syncUi();
  });
}

if (suggestPresetLowBtn) {
  suggestPresetLowBtn.addEventListener("click", () => setSuggestPreset("low"));
}
if (suggestPresetMediumBtn) {
  suggestPresetMediumBtn.addEventListener("click", () => setSuggestPreset("medium"));
}
if (suggestPresetHighBtn) {
  suggestPresetHighBtn.addEventListener("click", () => setSuggestPreset("high"));
}

if (detectionRegionList) {
  detectionRegionList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const rawIndex = target.getAttribute("data-detect-region-index");
    if (rawIndex === null) {
      return;
    }
    const index = Number(rawIndex);
    if (!Number.isFinite(index) || !detectState.regions[index]) {
      return;
    }
    detectState.regions[index] = {
      ...detectState.regions[index],
      selected: Boolean(target.checked),
    };
    rebuildSuggestedMaskFromSelectedRegions();
    render();
    syncUi();
  });
}

if (selectAllRegionsBtn) {
  selectAllRegionsBtn.addEventListener("click", () => setAllDetectionRegions(true));
}

if (selectNoneRegionsBtn) {
  selectNoneRegionsBtn.addEventListener("click", () => setAllDetectionRegions(false));
}

removeBtn.addEventListener("click", async () => {
  await removeWatermark();
});

addToQueueBtn.addEventListener("click", async () => {
  await addCurrentImageToQueue();
});

processAllBtn.addEventListener("click", async () => {
  await processAllQueueItems();
});

clearQueueBtn.addEventListener("click", () => {
  clearQueueItems();
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

if (queueList) {
  queueList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.getAttribute("data-action");
    const queueId = target.getAttribute("data-queue-id");
    if (!action || !queueId) {
      return;
    }

    if (action === "cancel") {
      await cancelQueueItem(queueId);
      return;
    }

    if (action === "remove") {
      queueStore.queuedItems = queueStore.queuedItems.filter((item) => item.id !== queueId);
      persistQueueToProject().catch(() => {});
      syncUi();
    }
  });
}

if (openProjectBtn) {
  openProjectBtn.addEventListener("click", async () => {
    try {
      await openProjectFolderFlow();
    } catch (error) {
      jobState.error = `Project open failed: ${error?.message || error}`;
      syncUi();
    }
  });
}

if (projectImageList) {
  projectImageList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("[data-project-image]");
    if (!button) {
      return;
    }
    const imagePath = button.getAttribute("data-project-image");
    if (!imagePath) {
      return;
    }

    const clickedStatus = target.closest(".project-image-status");
    try {
      await selectProjectImage(imagePath);

      if (clickedStatus) {
        const history = projectImageHistory(imagePath);
        if (history?.outputPath) {
          jobState.output = history.outputPath;
          jobState.status = "completed";
          jobState.error = null;
          paintOutput(history.outputPath);
          syncUi();
        }
      }
    } catch (error) {
      jobState.error = `Failed to load project image: ${error?.message || error}`;
      syncUi();
    }
  });
}

window.addEventListener("keydown", async (event) => {
  const tagName = String(event.target?.tagName || "").toLowerCase();
  if (tagName === "input" || tagName === "textarea" || event.target?.isContentEditable) {
    return;
  }
  if (!projectState.project?.images?.length) {
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    await selectAdjacentProjectImage(-1);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    await selectAdjacentProjectImage(1);
  }
});

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
    if (window.projects?.getActive) {
      projectState.project = await window.projects.getActive();
      applyProjectSettingsToUi();
      await restoreQueueFromProject();
      renderProjectImages();
      if (projectState.project?.activeImagePath) {
        await selectProjectImage(projectState.project.activeImagePath);
      }
      syncUi();
    }

    await refreshQueueSnapshot();
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
