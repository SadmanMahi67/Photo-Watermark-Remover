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
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from pydantic import BaseModel, Field


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


class SuggestMaskRequest(BaseModel):
    image_path: str
    output_path: Optional[str] = None
    strength: int = Field(default=50, ge=1, le=100)


class SuggestMaskResponse(BaseModel):
    mask_path: str
    width: int
    height: int
    method: str


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


def suggest_mask_output_path(image_path: Path, requested_output: Optional[str]) -> Path:
    if requested_output:
        out = Path(requested_output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.suffix.lower() != ".png":
            out = out.with_suffix(".png")
        return out

    root = Path.cwd() / "tmp" / "auto_mask"
    root.mkdir(parents=True, exist_ok=True)
    file_name = f"{image_path.stem}_suggested_mask_{uuid.uuid4().hex[:8]}.png"
    return root / file_name


def suggest_mask_file(image_path: Path, requested_output: Optional[str], strength: int) -> tuple[Path, tuple[int, int]]:
    if not image_path.exists() or not image_path.is_file():
        raise FileNotFoundError(f"image_path does not exist: {image_path}")

    out_path = suggest_mask_output_path(image_path, requested_output)
    strength_norm = max(1, min(100, int(strength)))

    # Higher strength lowers thresholds and increases expansion passes.
    edge_threshold = int(42 - (strength_norm * 0.24))
    edge_threshold = max(10, min(48, edge_threshold))

    bright_threshold = int(242 - (strength_norm * 0.45))
    bright_threshold = max(180, min(248, bright_threshold))

    dilation_passes = 1 + (strength_norm // 34)
    final_threshold = int(50 - (strength_norm * 0.22))
    final_threshold = max(12, min(58, final_threshold))

    with Image.open(image_path) as src:
        rgb = src.convert("RGB")
        gray = rgb.convert("L")

        # Heuristic: blend strong edges and bright regions, then expand to make brush-like masks.
        edges = gray.filter(ImageFilter.FIND_EDGES)
        edges_bin = edges.point(lambda p: 255 if p >= edge_threshold else 0).convert("L")
        bright_bin = gray.point(lambda p: 255 if p >= bright_threshold else 0).convert("L")

        combined = ImageChops.lighter(edges_bin, bright_bin)
        for _ in range(dilation_passes):
            combined = combined.filter(ImageFilter.MaxFilter(5))
        combined = combined.filter(ImageFilter.GaussianBlur(radius=1.0))
        mask = combined.point(lambda p: 255 if p >= final_threshold else 0).convert("L")

        mask.save(out_path, format="PNG")
        return out_path, rgb.size


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


@app.post("/mask/suggest", response_model=SuggestMaskResponse)
def suggest_mask(req: SuggestMaskRequest) -> SuggestMaskResponse:
    image = Path(req.image_path).expanduser().resolve()

    try:
        mask_path, (width, height) = suggest_mask_file(image, req.output_path, req.strength)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"mask suggestion failed: {exc}") from exc

    return SuggestMaskResponse(
        mask_path=str(mask_path),
        width=width,
        height=height,
        method="edge-brightness-v1",
    )


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
