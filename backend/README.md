# Python Backend (Step 1)

Local FastAPI service for watermark removal using IOPaint LaMa.

## Endpoints

- `POST /warmup` -> one-time model warmup and readiness verification
- `GET /warmup` -> current warmup status

Progress event shape is always:

```json
{ "stage": "string", "percent": 0, "error": null }
```

## Run

From workspace root:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

## Smoke Test

Start backend, then run:

```powershell
.\.venv\Scripts\python.exe .\backend\scripts\smoke_test.py
```

The smoke test creates `backend/tmp/input.jpg` and `backend/tmp/mask.png`, submits an inpaint job, polls progress, and asserts output exists.
