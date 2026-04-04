const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
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
    this.port = options.port || 8000;
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
  }

  getBackendRoot() {
    if (!app.isPackaged) {
      return path.resolve(app.getAppPath(), "..", "backend");
    }
    return path.join(process.resourcesPath, "backend");
  }

  getPythonExecutable() {
    if (process.env.BACKEND_PYTHON_PATH) {
      return process.env.BACKEND_PYTHON_PATH;
    }
    if (!app.isPackaged) {
      return path.resolve(app.getAppPath(), "..", ".venv", "Scripts", "python.exe");
    }
    return path.join(process.resourcesPath, "python", "python.exe");
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
            resolve(Boolean(parsed.iopaint_available));
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

  async cancelJob(jobId) {
    return this.requestJson("POST", `/jobs/${jobId}/cancel`);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { BackendManager };
