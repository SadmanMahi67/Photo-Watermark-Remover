from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty, Queue
from typing import AsyncGenerator, Dict, Literal, Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
from pydantic import BaseModel, Field

import numpy as np
from scipy import ndimage


StatusLiteral = Literal["queued", "running", "completed", "failed", "cancelled"]


class ProgressEvent(BaseModel):
    stage: str
    percent: int = Field(ge=0, le=100)
    error: Optional[str] = None


class InpaintRequest(BaseModel):
    image_path: str
    mask_path: str
    output_path: Optional[str] = None
    device: Literal["cpu", "cuda", "mps"] = "cpu"


class InpaintResponse(BaseModel):
    job_id: str
    status: StatusLiteral


class JobStatus(BaseModel):
    job_id: str
    status: StatusLiteral
    image_path: str
    mask_path: str
    output_path: Optional[str]
    device: Literal["cpu", "cuda", "mps"]
    progress: ProgressEvent


class WarmupResponse(BaseModel):
    status: Literal["idle", "warming", "ready", "failed"]
    progress: ProgressEvent


class DetectionBox(BaseModel):
    x: int
    y: int
    width: int
    height: int
    confidence: float
    kind: str


@dataclass
class Job:
    job_id: str
    image_path: Path
    mask_path: Path
    output_path: Optional[Path]
    device: Literal["cpu", "cuda", "mps"] = "cpu"
    status: StatusLiteral = "queued"
    progress: ProgressEvent = field(default_factory=lambda: ProgressEvent(stage="queued", percent=0, error=None))
    events: "Queue[ProgressEvent]" = field(default_factory=Queue)
    process: Optional[subprocess.Popen[str]] = None


jobs: Dict[str, Job] = {}
jobs_lock = threading.Lock()
app = FastAPI(title="Watermark Remover Backend", version="0.1.0")
warmup_lock = threading.Lock()
warmup_status: Literal["idle", "warming", "ready", "failed"] = "idle"
warmup_progress = ProgressEvent(stage="idle", percent=0, error=None)

florence_lock = threading.Lock()
florence_processor = None
florence_model = None


def _expand_mask(mask: Image.Image, dilation_passes: int, blur_radius: float, threshold: int) -> Image.Image:
    expanded = mask.convert("L")
    for _ in range(max(0, int(dilation_passes))):
        expanded = expanded.filter(ImageFilter.MaxFilter(5))
    if blur_radius > 0:
        expanded = expanded.filter(ImageFilter.GaussianBlur(radius=float(blur_radius)))
    expanded = expanded.point(lambda p: 255 if p >= int(threshold) else 0).convert("L")
    expanded = expanded.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    return expanded


def florence_model_dir_path() -> Path:
    env_value = os.getenv("FLORENCE2_MODEL_DIR")
    if env_value:
        return Path(env_value).expanduser().resolve()

    base_model_dir = model_dir_path()
    candidates = [
        base_model_dir / "florence2",
        Path.cwd() / "models" / "florence2",
        Path.cwd().parent / "models" / "florence2",
        Path.cwd().parent / "models" / "huggingface" / "florence2",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate.resolve()

    return (base_model_dir / "florence2").resolve()


def load_florence2_components():
    global florence_processor, florence_model
    with florence_lock:
        if florence_processor is not None and florence_model is not None:
            return florence_processor, florence_model

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoProcessor
        except Exception as exc:
            raise RuntimeError(f"required detector dependencies are missing: {exc}") from exc

        model_dir = florence_model_dir_path()
        if not model_dir.exists():
            raise FileNotFoundError(
                f"Florence-2 model directory not found: {model_dir}. Set FLORENCE2_MODEL_DIR to a local model path."
            )

        florence_processor = AutoProcessor.from_pretrained(
            str(model_dir),
            local_files_only=True,
            trust_remote_code=True,
        )
        florence_model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            local_files_only=True,
            trust_remote_code=True,
        )
        florence_model.eval()
        _ = torch  # Keep local import explicit for linters.
        return florence_processor, florence_model


def detect_watermark_florence(image_path: Path, requested_device: Literal["cpu", "cuda", "mps"]) -> tuple[List[DetectionBox], Optional[Image.Image]]:
    processor, model = load_florence2_components()

    try:
        import torch
    except Exception as exc:
        raise RuntimeError(f"torch is unavailable for Florence-2 inference: {exc}") from exc

    run_device = "cpu"
    if requested_device == "cuda" and torch.cuda.is_available():
        run_device = "cuda"
    elif requested_device == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        run_device = "mps"

    model = model.to(run_device)

    with Image.open(image_path) as src:
        rgb = src.convert("RGB")
        width, height = rgb.size

    # Use precise segmentation for watermark detection to eliminate blurriness
    prompt = "<REFERRING_EXPRESSIONS_SEGMENTATION>watermark"
    inputs = processor(text=prompt, images=rgb, return_tensors="pt")
    for key, value in list(inputs.items()):
        if hasattr(value, "to"):
            inputs[key] = value.to(run_device)

    with torch.no_grad():
        generated_ids = model.generate(
            input_ids=inputs.get("input_ids"),
            pixel_values=inputs.get("pixel_values"),
            max_new_tokens=256,
            num_beams=3,
            do_sample=False,
        )

    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed = processor.post_process_generation(generated_text, task="<REFERRING_EXPRESSIONS_SEGMENTATION>", image_size=(width, height))

    seg = parsed.get("<REFERRING_EXPRESSIONS_SEGMENTATION>") if isinstance(parsed, dict) else None
    polygons = seg.get("polygons", []) if isinstance(seg, dict) else []
    labels = seg.get("labels", []) if isinstance(seg, dict) else []

    results: List[DetectionBox] = []
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    mask_found = False

    for i, poly in enumerate(polygons):
        if not isinstance(poly, (list, tuple)) or len(poly) < 4:
            continue
        
        label = str(labels[i]).lower() if i < len(labels) else ""
        label_is_watermarkish = any(token in label for token in ["watermark", "logo", "text", "stamp", "signature", "brand", "copyright", "website", "url", "writing"])
        if not label_is_watermarkish:
            continue

        # Convert flat list [x1, y1, x2, y2, ...] to list of tuples [(x1, y1), (x2, y2), ...]
        points = [(poly[j], poly[j+1]) for j in range(0, len(poly) - 1, 2)]
        draw.polygon(points, fill=255)
        mask_found = True

        # Calculate bounding box for this polygon to maintain DetectionBox metadata
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        
        x0 = max(0, min(x0, width - 1))
        y0 = max(0, min(y0, height - 1))
        x1 = max(x0 + 1, min(x1, width))
        y1 = max(y0 + 1, min(y1, height))

        results.append(
            DetectionBox(
                x=int(x0),
                y=int(y0),
                width=int(x1 - x0),
                height=int(y1 - y0),
                confidence=0.74,
                kind="watermark",
            )
        )

    return results, (mask if mask_found else None)


def write_mask_from_boxes(mask_path: Path, width: int, height: int, boxes: List[DetectionBox], padding_factor: float = 0.006) -> None:
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)

    pad_x = max(1, int(width * padding_factor))
    pad_y = max(1, int(height * padding_factor))
    for box in boxes:
        x0 = max(0, box.x - pad_x)
        y0 = max(0, box.y - pad_y)
        x1 = min(width, box.x + box.width + pad_x)
        y1 = min(height, box.y + box.height + pad_y)
        draw.rectangle([(x0, y0), (x1, y1)], fill=255)

    mask.save(mask_path, format="PNG")


def push_progress(job: Job, stage: str, percent: int, error: Optional[str] = None) -> None:
    event = ProgressEvent(stage=stage, percent=max(0, min(100, percent)), error=error)
    job.progress = event
    job.events.put(event)


def output_path_for(image_path: Path, requested_output: Optional[str]) -> Path:
    if requested_output:
        out = Path(requested_output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        return out
    suffix = image_path.suffix.lower() if image_path.suffix.lower() in {".png", ".jpg", ".jpeg"} else ".png"
    return image_path.with_name(f"{image_path.stem}_clean{suffix}")


def model_dir_path() -> Path:
    model_dir = Path(os.getenv("MODEL_DIR", str(Path.cwd() / "models"))).resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    return model_dir


def iopaint_run(
    image_path: Path,
    mask_path: Path,
    output_path: Path,
    device: Literal["cpu", "cuda", "mps"],
) -> subprocess.Popen[str]:
    cmd = [
        sys.executable,
        "-m",
        "iopaint",
        "run",
        "--model=lama",
        f"--device={device}",
        f"--image={image_path}",
        f"--mask={mask_path}",
        f"--output={output_path}",
        f"--model-dir={model_dir_path()}",
    ]
    env = os.environ.copy()
    if env.get("IOPAINT_LOCAL_FILES_ONLY", "0") == "1":
        env["TRANSFORMERS_OFFLINE"] = "1"
        env["HF_HUB_OFFLINE"] = "1"

    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )


def resolve_generated_output_path(target: Path, source_image: Path) -> Optional[Path]:
    if target.is_file():
        return target

    if target.is_dir():
        preferred_names = [
            source_image.name,
            f"{source_image.stem}.png",
            f"{source_image.stem}.jpg",
            f"{source_image.stem}.jpeg",
        ]
        for name in preferred_names:
            candidate = target / name
            if candidate.is_file():
                return candidate

        image_files = [
            p for p in target.iterdir()
            if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg"}
        ]
        if image_files:
            return sorted(image_files, key=lambda p: p.stat().st_mtime, reverse=True)[0]

    return None


def run_job(job: Job) -> None:
    try:
        job.status = "running"
        push_progress(job, stage="validating_input", percent=5)

        if not job.image_path.exists():
            raise FileNotFoundError(f"image_path does not exist: {job.image_path}")
        if not job.mask_path.exists():
            raise FileNotFoundError(f"mask_path does not exist: {job.mask_path}")

        output_path = output_path_for(job.image_path, str(job.output_path) if job.output_path else None)
        job.output_path = output_path

        push_progress(job, stage="loading_model", percent=15)

        push_progress(job, stage="inpainting", percent=30)
        proc = iopaint_run(job.image_path, job.mask_path, output_path, job.device)
        job.process = proc

        percent_re = re.compile(r"(\d{1,3}(?:\.\d+)?)%")
        if proc.stdout is not None:
            for line in proc.stdout:
                line = line.strip()
                match = percent_re.search(line)
                if match:
                    found = min(99, max(30, int(float(match.group(1)))))
                    push_progress(job, stage="inpainting", percent=found)

        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"iopaint run failed with exit code {code}")

        push_progress(job, stage="writing_output", percent=98)
        resolved_output = resolve_generated_output_path(output_path, job.image_path)
        if resolved_output is None:
            raise RuntimeError("processing finished but output file was not created")
        job.output_path = resolved_output

        job.status = "completed"
        push_progress(job, stage="completed", percent=100)
    except Exception as exc:
        job.status = "failed"
        push_progress(job, stage="failed", percent=100, error=str(exc))
    finally:
        job.process = None


def set_warmup(stage: str, percent: int, error: Optional[str] = None) -> None:
    global warmup_progress
    warmup_progress = ProgressEvent(stage=stage, percent=max(0, min(100, percent)), error=error)


def run_warmup() -> None:
    global warmup_status

    with warmup_lock:
        if warmup_status == "ready":
            return
        warmup_status = "warming"
        set_warmup("warmup_started", 5)

    temp_root = Path.cwd() / "backend" / "tmp" / "warmup"
    temp_root.mkdir(parents=True, exist_ok=True)
    image_path = temp_root / "warmup_input.png"
    mask_path = temp_root / "warmup_mask.png"
    output_path = temp_root / "warmup_output.png"

    try:
        img = Image.new("RGB", (64, 64), (200, 210, 220))
        mask = Image.new("L", (64, 64), 0)
        mdraw = ImageDraw.Draw(mask)
        mdraw.rectangle([(20, 20), (44, 44)], fill=255)
        img.save(image_path)
        mask.save(mask_path)
        set_warmup("model_loading", 25)

        proc = iopaint_run(image_path, mask_path, output_path, "cpu")
        percent_re = re.compile(r"(\d{1,3}(?:\.\d+)?)%")
        if proc.stdout is not None:
            for line in proc.stdout:
                line = line.strip()
                match = percent_re.search(line)
                if match:
                    found = min(95, max(30, int(float(match.group(1)))))
                    set_warmup("warming_model", found)

        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"warmup failed with exit code {code}")
        if not output_path.exists():
            raise RuntimeError("warmup finished but output was not created")

        with warmup_lock:
            warmup_status = "ready"
        set_warmup("ready", 100)
    except Exception as exc:
        with warmup_lock:
            warmup_status = "failed"
        set_warmup("failed", 100, str(exc))
        raise


@app.get("/healthz")
def healthz() -> dict:
    import importlib.util

    iopaint_available = importlib.util.find_spec("iopaint") is not None
    return {
        "status": "ok" if iopaint_available else "degraded",
        "iopaint_available": iopaint_available,
        "instance_token": os.getenv("BACKEND_INSTANCE_TOKEN"),
        "model": "lama",
        "warmup": WarmupResponse(status=warmup_status, progress=warmup_progress).model_dump(),
        "progress_schema": {"stage": "string", "percent": "number", "error": "string|null"},
    }


@app.post("/warmup", response_model=WarmupResponse)
def warmup() -> WarmupResponse:
    try:
        run_warmup()
    except Exception:
        pass
    return WarmupResponse(status=warmup_status, progress=warmup_progress)


@app.get("/warmup", response_model=WarmupResponse)
def get_warmup() -> WarmupResponse:
    return WarmupResponse(status=warmup_status, progress=warmup_progress)


@app.post("/inpaint", response_model=InpaintResponse)
def start_inpaint(req: InpaintRequest) -> InpaintResponse:
    image = Path(req.image_path).expanduser().resolve()
    mask = Path(req.mask_path).expanduser().resolve()
    output = Path(req.output_path).expanduser().resolve() if req.output_path else None

    job_id = str(uuid.uuid4())
    job = Job(job_id=job_id, image_path=image, mask_path=mask, output_path=output, device=req.device)
    with jobs_lock:
        jobs[job_id] = job

    worker = threading.Thread(target=run_job, args=(job,), daemon=True)
    worker.start()
    return InpaintResponse(job_id=job_id, status=job.status)


@app.get("/jobs", response_model=List[JobStatus])
def list_jobs() -> List[JobStatus]:
    with jobs_lock:
        snapshot = list(jobs.values())

    return [
        JobStatus(
            job_id=job.job_id,
            status=job.status,
            image_path=str(job.image_path),
            mask_path=str(job.mask_path),
            output_path=str(job.output_path) if job.output_path else None,
            device=job.device,
            progress=job.progress,
        )
        for job in snapshot
    ]


@app.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    with jobs_lock:
        job = jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    return JobStatus(
        job_id=job.job_id,
        status=job.status,
        image_path=str(job.image_path),
        mask_path=str(job.mask_path),
        output_path=str(job.output_path) if job.output_path else None,
        device=job.device,
        progress=job.progress,
    )


@app.post("/jobs/{job_id}/cancel", response_model=JobStatus)
def cancel_job(job_id: str) -> JobStatus:
    with jobs_lock:
        job = jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    if job.process and job.status == "running":
        job.process.kill()
        job.status = "cancelled"
        push_progress(job, stage="cancelled", percent=100, error="Cancelled by user")

    return JobStatus(
        job_id=job.job_id,
        status=job.status,
        image_path=str(job.image_path),
        mask_path=str(job.mask_path),
        output_path=str(job.output_path) if job.output_path else None,
        device=job.device,
        progress=job.progress,
    )


@app.get("/jobs/{job_id}/events")
async def stream_events(job_id: str) -> StreamingResponse:
    with jobs_lock:
        job = jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    async def event_generator() -> AsyncGenerator[str, None]:
        last = job.progress
        yield f"data: {last.model_dump_json()}\n\n"

        while True:
            try:
                ev = job.events.get(timeout=0.5)
                last = ev
                yield f"data: {ev.model_dump_json()}\n\n"
            except Empty:
                if job.status in {"completed", "failed", "cancelled"}:
                    yield f"data: {last.model_dump_json()}\n\n"
                    break

    return StreamingResponse(event_generator(), media_type="text/event-stream")
