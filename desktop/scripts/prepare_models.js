const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_FLORENCE2_REPO = "microsoft/Florence-2-base-ft";

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
  const florenceRepo = process.env.FLORENCE2_REPO || DEFAULT_FLORENCE2_REPO;
  const florenceDir = path.join(modelDir, "florence2");
  const florenceConfig = path.join(florenceDir, "config.json");
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

  if (fs.existsSync(florenceConfig)) {
    console.log(`[models] Florence-2 already present: ${florenceDir}`);
    return;
  }

  fs.mkdirSync(florenceDir, { recursive: true });
  console.log(`[models] downloading Florence-2 (${florenceRepo}) to ${florenceDir}`);

  const pySnippet = [
    "import pathlib",
    "import sys",
    "from huggingface_hub import snapshot_download",
    "repo_id = sys.argv[1]",
    "target = pathlib.Path(sys.argv[2]).resolve()",
    "target.mkdir(parents=True, exist_ok=True)",
    "snapshot_download(repo_id=repo_id, local_dir=str(target))",
    "print(str(target))",
  ].join("\n");

  const florenceResult = spawnSync(
    python,
    ["-c", pySnippet, florenceRepo, florenceDir],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (florenceResult.status !== 0) {
    throw new Error(
      `[models] Florence-2 download failed with code ${florenceResult.status}. Ensure internet access and that huggingface_hub is installed in ${python}.`,
    );
  }

  if (!fs.existsSync(florenceConfig)) {
    throw new Error(`[models] Florence-2 download incomplete: missing ${florenceConfig}`);
  }

  console.log(`[models] Florence-2 ready: ${florenceDir}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
