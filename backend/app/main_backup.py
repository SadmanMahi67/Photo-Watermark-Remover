from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
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

# IOPaint persistent server management
iopaint_server_process: Optional[subprocess.Popen] = None
iopaint_server_ready = False
iopaint_server_lock = threading.Lock()
IOPAINT_SERVER_PORT = 9000


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


def detect_device() -> Literal["cpu", "cuda", "mps"]:
    """Detect best available compute device: CUDA > MPS > CPU."""
    try:
        print("[Device] Detecting compute device...")
        import torch
        print(f"[Device] PyTorch version: {torch.__version__}")
        
        # Check for CUDA
        if torch.cuda.is_available():
            print(f"[Device] OK CUDA available: {torch.cuda.get_device_name(0)}")
            return "cuda"
        
        # Check for MPS (Apple Silicon)
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            print(f"[Device] OK MPS (Apple Silicon) available")
            return "mps"
        
        print("[Device] No GPU available, using CPU")
    except Exception as exc:
        print(f"[Device] Error detecting GPU: {exc}")
    
    # Default to CPU
    print("[Device] Defaulting to CPU")
    return "cpu"


def start_iopaint_server(device: Literal["cpu", "cuda", "mps"] = "cpu") -> bool:
    """Start IOPaint server as persistent subprocess to keep model in memory."""
    global iopaint_server_process, iopaint_server_ready
    
    with iopaint_server_lock:
        if iopaint_server_process is not None and iopaint_server_process.poll() is None:
            print("[IOPaint] Server already running, skipping startup")
            return True
        
        try:
            print(f"[IOPaint] Starting server on port {IOPAINT_SERVER_PORT} with device={device}...")
            
            cmd = [
                sys.executable,
                "-m",
                "iopaint",
                "server",
                "--model=lama",
                f"--device={device}",
                f"--port={IOPAINT_SERVER_PORT}",
                f"--model-dir={model_dir_path()}",
            ]
            
            print(f"[IOPaint] Command: {' '.join(cmd)}")
            
            env = os.environ.copy()
            env["TRANSFORMERS_OFFLINE"] = "1"
            env["HF_HUB_OFFLINE"] = "1"
            
            iopaint_server_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            print(f"[IOPaint] Server process started (PID={iopaint_server_process.pid})")
            iopaint_server_ready = False
            
            # Wait for server to become ready
            print("[IOPaint] Waiting for server to be ready (timeout 60s)...")
            for attempt in range(120):  # 60 seconds with 0.5s checks
                if ping_iopaint_server():
                    iopaint_server_ready = True
                    print("[IOPaint] OK Server is ready")
                    return True
                time.sleep(0.5)
            
            print("[IOPaint] ERROR Server failed to start within 60 seconds")
            if iopaint_server_process:
                iopaint_server_process.terminate()
            iopaint_server_process = None
            return False
            
        except Exception as exc:
            import traceback
            print(f"[IOPaint] ERROR Failed to start server: {exc}")
            print(f"[IOPaint] Traceback: {traceback.format_exc()}")
            iopaint_server_process = None
            iopaint_server_ready = False
            return False


def stop_iopaint_server() -> None:
    """Stop IOPaint server subprocess."""
    global iopaint_server_process, iopaint_server_ready
    
    with iopaint_server_lock:
        if iopaint_server_process is not None:
            try:
                print("[IOPaint] Stopping server...")
                iopaint_server_process.terminate()
                try:
                    iopaint_server_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    print("[IOPaint] Server did not stop gracefully, killing...")
                    iopaint_server_process.kill()
                    iopaint_server_process.wait()
                print("[IOPaint] OK Server stopped")
            except Exception as exc:
                print(f"[IOPaint] ERROR Stopping server: {exc}")
            finally:
                iopaint_server_process = None
                iopaint_server_ready = False
        else:
            print("[IOPaint] No server to stop")


def ping_iopaint_server() -> bool:
    """Check if IOPaint server is responsive."""
    try:
        import requests
        response = requests.get(
            f"http://127.0.0.1:{IOPAINT_SERVER_PORT}/api/v1/server",
            timeout=1
        )
        return response.status_code == 200
    except Exception:
        return False


def iopaint_inpaint(
    image_path: Path,
    mask_path: Path,
    output_path: Path,
) -> bool:
    """Send inpaint request to IOPaint server."""
    if not iopaint_server_ready:
        raise RuntimeError("IOPaint server not ready")
    
    try:
        import requests
        
        with open(image_path, "rb") as f:
            image_data = f.read()
        with open(mask_path, "rb") as f:
            mask_data = f.read()
        
        files = {
            "image": ("image.png", image_data),
            "mask": ("mask.png", mask_data),
        }
        
        response = requests.post(
            f"http://127.0.0.1:{IOPAINT_SERVER_PORT}/api/v1/inpaint",
            files=files,
            timeout=300
        )
        
        if response.status_code != 200:
            raise RuntimeError(f"Server error: {response.status_code}")
        
        # Save output
        with open(output_path, "wb") as f:
            f.write(response.content)
        
        return True
    except Exception as exc:
        raise RuntimeError(f"IOPaint inpaint failed: {exc}")


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
        
        # Use persistent IOPaint server
        success = iopaint_inpaint(job.image_path, job.mask_path, output_path)
        if not success:
            raise RuntimeError("IOPaint inpaint processing failed")
        
        # Update progress during inference
        push_progress(job, stage="inpainting", percent=80)

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

        # Use persistent IOPaint server
        success = iopaint_inpaint(image_path, mask_path, output_path)
        if not success:
            raise RuntimeError("warmup inpaint failed")
        
        set_warmup("warming_model", 95)
        
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


@app.on_event("startup")
async def startup_event() -> None:
    """Start IOPaint server on app startup to keep model in memory."""
    print("\n" + "="*70)
    print("[App] STARTUP EVENT TRIGGERED")
    print("="*70)
    
    try:
        device = detect_device()
        print(f"[App] Detected device: {device}")
        print(f"[App] Starting IOPaint server...")
        
        success = start_iopaint_server(device)
        
        if success:
            print(f"[App] OK Server started successfully on startup")
        else:
            print(f"[App] WARN Server initialization failed - app will continue but inpaint operations will fail")
    except Exception as exc:
        import traceback
        print(f"[App] ERROR CRITICAL ERROR during startup: {exc}")
        print(f"[App] Traceback: {traceback.format_exc()}")
    
    print("="*70 + "\n")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Stop IOPaint server on app shutdown."""
    print("\n" + "="*70)
    print("[App] SHUTDOWN EVENT TRIGGERED")
    print("="*70)
    stop_iopaint_server()
    print("="*70 + "\n")
