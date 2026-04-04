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
from typing import AsyncGenerator, Dict, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image, ImageDraw
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


class InpaintResponse(BaseModel):
    job_id: str
    status: StatusLiteral


class JobStatus(BaseModel):
    job_id: str
    status: StatusLiteral
    image_path: str
    mask_path: str
    output_path: Optional[str]
    progress: ProgressEvent


class WarmupResponse(BaseModel):
    status: Literal["idle", "warming", "ready", "failed"]
    progress: ProgressEvent


@dataclass
class Job:
    job_id: str
    image_path: Path
    mask_path: Path
    output_path: Optional[Path]
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


def model_dir_path() -> Path:
    model_dir = Path(os.getenv("MODEL_DIR", str(Path.cwd() / "models"))).resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    return model_dir


def iopaint_run(image_path: Path, mask_path: Path, output_path: Path) -> subprocess.Popen[str]:
    cmd = [
        sys.executable,
        "-m",
        "iopaint",
        "run",
        "--model=lama",
        f"--device={os.getenv('IOPAINT_DEVICE', 'cpu')}",
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
        proc = iopaint_run(job.image_path, job.mask_path, output_path)
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
        if not output_path.exists():
            raise RuntimeError("processing finished but output file was not created")

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

        proc = iopaint_run(image_path, mask_path, output_path)
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
    job = Job(job_id=job_id, image_path=image, mask_path=mask, output_path=output)
    with jobs_lock:
        jobs[job_id] = job

    worker = threading.Thread(target=run_job, args=(job,), daemon=True)
    worker.start()
    return InpaintResponse(job_id=job_id, status=job.status)


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
