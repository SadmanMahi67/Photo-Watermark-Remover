const fs = require("node:fs");
const path = require("node:path");

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function main() {
  const desktopRoot = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(desktopRoot, "..");
  const defaultRuntimeSource = path.resolve(workspaceRoot, ".venv");
  const runtimeSource = process.env.PYTHON_RUNTIME_DIR
    ? path.resolve(process.env.PYTHON_RUNTIME_DIR)
    : defaultRuntimeSource;

  const stagingRoot = path.resolve(desktopRoot, "build-resources");
  const runtimeDest = path.resolve(stagingRoot, "python");

  if (!fs.existsSync(runtimeSource)) {
    throw new Error(
      `Python runtime source not found at ${runtimeSource}. Set PYTHON_RUNTIME_DIR to a valid runtime directory.`,
    );
  }

  console.log(`[runtime] staging python runtime from ${runtimeSource}`);
  fs.rmSync(runtimeDest, { recursive: true, force: true });
  copyDir(runtimeSource, runtimeDest);

  const winExe = path.join(runtimeDest, "Scripts", "python.exe");
  const directExe = path.join(runtimeDest, "python.exe");
  if (!fs.existsSync(winExe) && !fs.existsSync(directExe)) {
    throw new Error(
      `[runtime] expected python executable was not found under ${runtimeDest}`,
    );
  }

  console.log(`[runtime] ready at ${runtimeDest}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
