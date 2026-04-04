# Desktop Shell (Step 2-6)

Electron main process lifecycle orchestration for local Python backend, plus masking UI, async UX, output UX, and packaging setup.

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
- Step 4 async UX: stage-aware progress, cancel/retry/reset, graceful error recovery
- Step 5 output UX: before/after compare slider, save output PNG/JPG, open output folder
- Step 6 packaging setup: staged Python runtime + bundled backend/models via electron-builder

## Run

```powershell
cd .\desktop
npm install
npm run prepare:models
npm run start
```

## Packaging (Windows)

```powershell
cd .\desktop
npm install
npm run dist:dir
# or installer
npm run dist:win
```

Packaging scripts perform:

1. Model prep to `../models`
2. Python runtime staging from `.venv` (or `PYTHON_RUNTIME_DIR`) into `desktop/build-resources/python`
3. Bundling backend, models, and python runtime into app resources

## Clean Machine Validation Checklist

1. Install built app on a machine with no manually configured project venv.
2. Launch app while offline.
3. Drop image -> mask -> remove -> save output.
4. Confirm app runs without trying to download models at runtime.
5. Confirm app can still start when port 8000 is occupied.

## Notes

- Dev mode expects Python at `.venv\Scripts\python.exe` and backend at `backend\app\main.py`.
- Packaged mode expects bundled resources under `resources/backend` and `resources/python`.
- Models are expected to be bundled under `resources/models` in packaged app.
- On launch, if the local user model cache is missing, models are copied from bundled location before backend startup.
- For packaged runtime path, backend manager checks both `resources/python/Scripts/python.exe` and `resources/python/python.exe`.
