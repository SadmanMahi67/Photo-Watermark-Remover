# Desktop Shell (Step 2 + Step 3 Start)

Electron main process lifecycle orchestration for local Python backend, plus initial Step 3 masking UI.

## What is implemented

- Spawn backend subprocess on app startup
- Startup timeout + health polling (`/healthz`)
- Automatic crash recovery with bounded restart attempts
- Graceful backend shutdown when app exits
- IPC bridge to query status and trigger manual restart
- Build-time LaMa model download script (`npm run prepare:models`)
- First-launch model copy from bundled source to local app data model directory
- Runtime configured for offline-only model loading (`IOPAINT_LOCAL_FILES_ONLY=1`)
- Step 3 core renderer: drag/drop PNG/JPG, brush/eraser mask, zoom/pan, and remove action

## Run

```powershell
cd .\desktop
npm install
npm run prepare:models
npm run start
```

## Notes

- Dev mode expects Python at `.venv\Scripts\python.exe` and backend at `backend\app\main.py`.
- Packaged mode expects bundled resources under `resources/backend` and `resources/python/python.exe`.
- Models are expected to be bundled under `resources/models` in packaged app.
- On launch, if the local user model cache is missing, models are copied from bundled location before backend startup.
