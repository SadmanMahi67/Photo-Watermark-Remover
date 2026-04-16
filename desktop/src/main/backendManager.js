const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { app } = require("electron");

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const HEALTH_POLL_INTERVAL_MS = 500;
const MAX_RESTART_ATTEMPTS = 3;
const REQUIRED_LAMA_MODEL_RELATIVE_PATH = path.join("torch", "hub", "checkpoints", "big-lama.pt");

class BackendManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || "127.0.0.1";
    this.preferredPort = options.port || 8000;
    this.port = this.preferredPort;
    this.startupTimeoutMs = Number(process.env.BACKEND_STARTUP_TIMEOUT_MS || DEFAULT_STARTUP_TIMEOUT_MS);
    this.restartAttempts = 0;
    this.status = {
      state: "stopped",
      ready: false,
      pid: null,
      lastError: null,
      modelDir: null,
    };
    this.process = null;
    this.shuttingDown = false;
    this.instanceToken = null;
  }

  getBackendRoot() {
    if (!app.isPackaged) {
      return path.resolve(app.getAppPath(), "..", "backend");
    }
    return path.join(process.resourcesPath, "backend");
  }

  getPythonExecutable() {
    const candidates = [];

    if (!app.isPackaged) {
      // Prefer the workspace venv in development, regardless of how Electron resolves app path.
      candidates.push(path.resolve(process.cwd(), "..", ".venv", "Scripts", "python.exe"));
      candidates.push(path.resolve(app.getAppPath(), "..", ".venv", "Scripts", "python.exe"));
      candidates.push(path.resolve(__dirname, "..", "..", "..", ".venv", "Scripts", "python.exe"));
    }

    if (process.env.BACKEND_PYTHON_PATH) {
      candidates.push(path.resolve(process.env.BACKEND_PYTHON_PATH));
    }

    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, "python", "Scripts", "python.exe"));
      candidates.push(path.join(process.resourcesPath, "python", "python.exe"));
    }

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    return found || candidates[0];
  }

  getBundledModelsDir() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "models");
    }
    return path.resolve(app.getAppPath(), "..", "models");
  }

  getLocalModelsDir() {
    return path.join(app.getPath("userData"), "models");
  }

  getRequiredModelPath(baseDir) {
    return path.join(baseDir, REQUIRED_LAMA_MODEL_RELATIVE_PATH);
  }

  ensureLocalModelsReady() {
    const bundledModelsDir = this.getBundledModelsDir();
    const localModelsDir = this.getLocalModelsDir();
    const bundledRequired = this.getRequiredModelPath(bundledModelsDir);
    const localRequired = this.getRequiredModelPath(localModelsDir);

    if (!fs.existsSync(bundledRequired)) {
      throw new Error(
        `Bundled LaMa model not found at ${bundledRequired}. Run model preparation before packaging.`,
      );
    }

    if (!fs.existsSync(localRequired)) {
      this.setStatus({ state: "preparing-models", ready: false, modelDir: localModelsDir });
      fs.mkdirSync(localModelsDir, { recursive: true });
      fs.cpSync(bundledModelsDir, localModelsDir, { recursive: true, force: false, errorOnExist: false });
      this.emit("log", {
        level: "info",
        message: `Copied bundled models to local directory: ${localModelsDir}`,
      });
    }

    return localModelsDir;
  }

  backendBaseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  healthUrl() {
    return `http://${this.host}:${this.port}/healthz`;
  }

  getStatus() {
    return { ...this.status, url: this.healthUrl() };
  }

  setStatus(next) {
    this.status = { ...this.status, ...next };
    this.emit("status", this.getStatus());
  }

  async start() {
    if (this.process) {
      return this.waitUntilHealthy();
    }

    this.shuttingDown = false;
    const backendRoot = this.getBackendRoot();
    const pythonPath = this.getPythonExecutable();
    const localModelsDir = this.ensureLocalModelsReady();
    this.port = await this.selectStartupPort();

    if (!fs.existsSync(backendRoot)) {
      const err = `Backend directory not found: ${backendRoot}`;
      this.setStatus({ state: "failed", ready: false, lastError: err });
      throw new Error(err);
    }

    if (!fs.existsSync(pythonPath)) {
      const err = `Python executable not found: ${pythonPath}`;
      this.setStatus({ state: "failed", ready: false, lastError: err });
      throw new Error(err);
    }

    this.emit("log", {
      level: "info",
      message: `Backend python executable: ${pythonPath}`,
    });

    const args = [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      this.host,
      "--port",
      String(this.port),
    ];

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      MODEL_DIR: process.env.MODEL_DIR || localModelsDir,
      IOPAINT_LOCAL_FILES_ONLY: process.env.IOPAINT_LOCAL_FILES_ONLY || "1",
    };
    this.instanceToken = crypto.randomUUID();
    env.BACKEND_INSTANCE_TOKEN = this.instanceToken;

    this.process = spawn(pythonPath, args, {
      cwd: backendRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.setStatus({
      state: "starting",
      ready: false,
      pid: this.process.pid || null,
      lastError: null,
      modelDir: localModelsDir,
    });

    this.process.stdout.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.emit("log", { level: "info", message });
      }
    });

    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.emit("log", { level: "error", message });
      }
    });

    this.process.once("exit", (code, signal) => {
      const expected = this.shuttingDown;
      this.process = null;
      this.setStatus({
        state: expected ? "stopped" : "crashed",
        ready: false,
        pid: null,
        lastError: expected ? null : `Backend exited (code=${code}, signal=${signal})`,
      });

      if (!expected) {
        this.tryRestart().catch((err) => {
          this.setStatus({ state: "failed", ready: false, lastError: err.message });
        });
      }
    });

    return this.waitUntilHealthy();
  }

  async waitUntilHealthy() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.startupTimeoutMs) {
      const ok = await this.pingHealth();
      if (ok) {
        this.restartAttempts = 0;
        this.setStatus({ state: "ready", ready: true, lastError: null });
        return this.getStatus();
      }
      await this.sleep(HEALTH_POLL_INTERVAL_MS);
    }

    const err = new Error(`Backend did not become ready in ${this.startupTimeoutMs}ms`);
    this.setStatus({ state: "failed", ready: false, lastError: err.message });
    await this.stop();
    throw err;
  }

  async selectStartupPort() {
    const preferredFree = await this.isPortFree(this.preferredPort);
    if (preferredFree) {
      return this.preferredPort;
    }

    const fallback = await this.findFreePort();
    this.emit("log", {
      level: "info",
      message: `Preferred backend port ${this.preferredPort} is busy. Falling back to ${fallback}.`,
    });
    return fallback;
  }

  async isPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => {
        resolve(false);
      });
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, this.host);
    });
  }

  async findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.once("listening", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to resolve free backend port")));
          return;
        }
        const freePort = address.port;
        server.close(() => resolve(freePort));
      });
      server.listen(0, this.host);
    });
  }

  async pingHealth() {
    return new Promise((resolve) => {
      const req = http.get(this.healthUrl(), (res) => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const tokenMatches = parsed.instance_token && this.instanceToken
              ? parsed.instance_token === this.instanceToken
              : true;
            resolve(Boolean(parsed.iopaint_available) && tokenMatches);
          } catch {
            resolve(false);
          }
        });
      });

      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async tryRestart() {
    if (this.shuttingDown) {
      return;
    }
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      throw new Error("Backend restart attempts exhausted");
    }
    this.restartAttempts += 1;
    this.setStatus({
      state: "restarting",
      ready: false,
      lastError: `Attempting restart ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}`,
    });
    await this.sleep(1000);
    await this.start();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async stop() {
    this.shuttingDown = true;

    if (!this.process) {
      this.setStatus({ state: "stopped", ready: false, pid: null });
      return;
    }

    const proc = this.process;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
        }
      }, 4000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });

    this.process = null;
    this.setStatus({ state: "stopped", ready: false, pid: null, lastError: null });
  }

  async requestJson(method, endpointPath, body) {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {
      Accept: "application/json",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }

    const options = {
      method,
      hostname: this.host,
      port: this.port,
      path: endpointPath,
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Backend request failed (${res.statusCode}): ${data}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (error) {
            reject(new Error(`Invalid JSON from backend: ${error.message}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error(`Backend request timeout for ${method} ${endpointPath}`));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async startInpaint(payload) {
    return this.requestJson("POST", "/inpaint", payload);
  }

  async getJob(jobId) {
    return this.requestJson("GET", `/jobs/${jobId}`);
  }

  async getJobs() {
    return this.requestJson("GET", "/jobs");
  }

  async cancelJob(jobId) {
    return this.requestJson("POST", `/jobs/${jobId}/cancel`);
  }

  async detectDevices() {
    const pythonPath = this.getPythonExecutable();
    if (!fs.existsSync(pythonPath)) {
      this.emit("log", {
        level: "error",
        message: `Device detection python not found: ${pythonPath}`,
      });
      return [{ id: "cpu", label: "CPU (slower)" }];
    }

    const snippet = [
      "import json",
      "import sys",
      "devices = [{'id': 'cpu', 'label': 'CPU (slower)'}]",
      "runtime = {'python': sys.executable, 'torch': None, 'cuda': None, 'cuda_available': False}",
      "try:",
      "    import torch",
      "    runtime['torch'] = torch.__version__",
      "    runtime['cuda'] = torch.version.cuda",
      "    runtime['cuda_available'] = bool(torch.cuda.is_available())",
      "    if torch.cuda.is_available():",
      "        count = torch.cuda.device_count()",
      "        if count > 0:",
      "            name = torch.cuda.get_device_name(0)",
      "            suffix = f' +{count-1} more' if count > 1 else ''",
      "            devices.insert(0, {'id': 'cuda', 'label': f'{name}{suffix} (CUDA)'})",
      "    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():",
      "        devices.insert(0, {'id': 'mps', 'label': 'Apple Silicon GPU (MPS)'})",
      "except Exception as exc:",
      "    runtime['error'] = str(exc)",
      "print(json.dumps({'devices': devices, 'runtime': runtime}))",
    ].join("\n");

    return new Promise((resolve) => {
      const proc = spawn(pythonPath, ["-c", snippet], {
        cwd: this.getBackendRoot(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        err += chunk.toString();
      });

      proc.on("close", (code) => {
        if (err.trim()) {
          this.emit("log", {
            level: "error",
            message: `Device detection stderr: ${err.trim()}`,
          });
        }

        try {
          const parsed = JSON.parse(out.trim());
          const runtime = parsed.runtime || {};
          this.emit("log", {
            level: "info",
            message: `Device detection using ${runtime.python || pythonPath} (torch=${runtime.torch || "n/a"}, cuda=${runtime.cuda || "n/a"}, cuda_available=${runtime.cuda_available ? "true" : "false"})`,
          });
          if (Array.isArray(parsed.devices) && parsed.devices.length > 0) {
            resolve(parsed.devices);
            return;
          }
        } catch {
          this.emit("log", {
            level: "error",
            message: `Device detection parse failure (exit=${code}): ${out.trim()}`,
          });
        }
        resolve([{ id: "cpu", label: "CPU (slower)" }]);
      });
    });
  }

  async warmup() {
    if (!this.process || !this.status.ready) {
      return;
    }

    try {
      this.setStatus({ state: "warming", ready: false });
      this.emit("log", {
        level: "info",
        message: "Preloading model into memory...",
      });

      await this.requestJson("POST", "/warmup", null);

      this.setStatus({ state: "ready", ready: true });
      this.emit("log", {
        level: "info",
        message: "Model preload complete.",
      });
    } catch (error) {
      this.emit("log", {
        level: "warn",
        message: `Model preload failed (non-critical): ${error?.message || error}`,
      });
      // Warmup failure is not critical; reset to ready state so app continues
      this.setStatus({ state: "ready", ready: true });
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { BackendManager };
