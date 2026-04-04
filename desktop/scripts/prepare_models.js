const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function resolvePython(workspaceRoot) {
  if (process.env.BUILD_PYTHON_PATH) {
    return process.env.BUILD_PYTHON_PATH;
  }

  const localVenv = path.resolve(workspaceRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(localVenv)) {
    return localVenv;
  }

  return "python";
}

function main() {
  const desktopRoot = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(desktopRoot, "..");
  const modelDir = path.resolve(workspaceRoot, "models");
  const requiredModel = path.join(modelDir, "torch", "hub", "checkpoints", "big-lama.pt");
  const python = resolvePython(workspaceRoot);

  fs.mkdirSync(modelDir, { recursive: true });

  console.log(`[models] ensuring LaMa model in ${modelDir}`);
  const result = spawnSync(
    python,
    ["-m", "iopaint", "download", "--model", "lama", "--model-dir", modelDir],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(`[models] iopaint download failed with code ${result.status}`);
  }

  if (!fs.existsSync(requiredModel)) {
    throw new Error(`[models] expected model file missing: ${requiredModel}`);
  }

  console.log(`[models] ready: ${requiredModel}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
