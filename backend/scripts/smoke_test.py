from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw


def make_test_assets(tmp_dir: Path) -> tuple[Path, Path, Path]:
    tmp_dir.mkdir(parents=True, exist_ok=True)
    image_path = tmp_dir / "input.jpg"
    mask_path = tmp_dir / "mask.png"
    output_path = tmp_dir / "output.png"

    img = Image.new("RGB", (512, 320), color=(210, 222, 240))
    draw = ImageDraw.Draw(img)
    draw.rectangle([(80, 120), (430, 210)], fill=(128, 134, 142))
    draw.text((100, 145), "WATERMARK", fill=(255, 255, 255))
    img.save(image_path, format="JPEG", quality=95)

    mask = Image.new("L", (512, 320), color=0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rectangle([(75, 115), (435, 215)], fill=255)
    mask.save(mask_path, format="PNG")

    return image_path, mask_path, output_path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    image_path, mask_path, output_path = make_test_assets(root / "tmp")

    with httpx.Client(timeout=30.0) as client:
        health = client.get("http://127.0.0.1:8000/healthz")
        print("HEALTH", health.status_code, health.json())

        resp = client.post(
            "http://127.0.0.1:8000/inpaint",
            json={
                "image_path": str(image_path),
                "mask_path": str(mask_path),
                "output_path": str(output_path),
            },
        )
        resp.raise_for_status()
        job = resp.json()
        print("START", json.dumps(job, indent=2))

        job_id = job["job_id"]
        while True:
            status = client.get(f"http://127.0.0.1:8000/jobs/{job_id}")
            status.raise_for_status()
            payload = status.json()
            print("PROGRESS", payload["progress"])
            if payload["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(1)

    if not output_path.exists():
        raise SystemExit("Smoke test failed: output image was not created")

    print(f"SUCCESS: output created at {output_path}")


if __name__ == "__main__":
    main()
