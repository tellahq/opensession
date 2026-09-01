const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STOP_TIMEOUT_MS = 1500;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;

function helperPath() {
  return path.join(process.resourcesPath, "os1-dictation");
}

function commandFrame(type, payload) {
  const body = payload
    ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    : Buffer.alloc(0);
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame[0] = type;
  frame.writeUInt32LE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

function validID(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

class NativeDictation {
  constructor() {
    this.active = null;
  }

  start(id, sampleRate, language, onText) {
    this.cancel();
    if (
      !validID(id) ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8_000 ||
      sampleRate > 192_000
    ) {
      return { ok: false };
    }
    const executable = helperPath();
    if (process.platform !== "darwin" || !fs.existsSync(executable))
      return { ok: false };

    let child;
    try {
      child = spawn(
        executable,
        [String(sampleRate), String(language || "en-US")],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      console.error("[dictation] native helper could not start", error);
      return { ok: false };
    }

    const entry = {
      id,
      child,
      latest: "",
      failed: false,
      closed: false,
      finishResolve: null,
      finishTimer: null,
      stderr: "",
      stdout: "",
    };
    this.active = entry;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      entry.stdout += chunk;
      let newline;
      while ((newline = entry.stdout.indexOf("\n")) >= 0) {
        const line = entry.stdout.slice(0, newline);
        entry.stdout = entry.stdout.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "text" && typeof event.text === "string") {
          entry.latest = event.text.trim();
          if (entry.latest) onText(entry.latest);
        } else if (event.type === "final") {
          if (typeof event.text === "string" && event.text.trim()) {
            entry.latest = event.text.trim();
          }
          this.settle(entry);
        } else if (event.type === "error") {
          entry.failed = true;
          this.settle(entry, "");
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      entry.stderr = (entry.stderr + chunk).slice(-2_000);
    });
    child.on("error", (error) => {
      entry.failed = true;
      console.error("[dictation] native helper failed", error);
      this.settle(entry, "");
    });
    child.on("close", (code) => {
      entry.closed = true;
      if (code && !entry.failed) {
        console.error(
          `[dictation] native helper exited ${code}: ${entry.stderr}`,
        );
      }
      this.settle(entry, entry.failed ? "" : entry.latest);
    });
    return { ok: true };
  }

  push(id, samples) {
    const entry = this.active;
    if (!entry || entry.id !== id || entry.closed || entry.failed) return;
    if (
      !(samples instanceof Float32Array) ||
      samples.byteLength > MAX_AUDIO_CHUNK_BYTES
    )
      return;
    entry.child.stdin.write(commandFrame(1, samples));
  }

  finish(id) {
    const entry = this.active;
    if (!entry || entry.id !== id) return Promise.resolve({ text: "" });
    if (entry.closed || entry.failed) {
      const text = entry.failed ? "" : entry.latest;
      this.clear(entry);
      return Promise.resolve({ text });
    }
    if (entry.finishResolve) {
      return new Promise((resolve) => {
        const previous = entry.finishResolve;
        entry.finishResolve = (text) => {
          previous(text);
          resolve({ text });
        };
      });
    }
    return new Promise((resolve) => {
      entry.finishResolve = (text) => resolve({ text });
      entry.child.stdin.write(commandFrame(2));
      entry.finishTimer = setTimeout(() => {
        entry.child.kill("SIGTERM");
        this.settle(entry, entry.latest);
      }, STOP_TIMEOUT_MS);
    });
  }

  settle(entry, text = entry.latest) {
    if (entry.finishResolve) {
      const resolve = entry.finishResolve;
      entry.finishResolve = null;
      resolve(text);
      this.clear(entry);
    }
  }

  clear(entry) {
    if (entry.finishTimer) clearTimeout(entry.finishTimer);
    entry.finishTimer = null;
    if (this.active === entry) this.active = null;
  }

  cancel(id) {
    const entry = this.active;
    if (!entry || (id && entry.id !== id)) return;
    entry.failed = true;
    if (!entry.closed) entry.child.kill("SIGTERM");
    this.settle(entry, "");
    this.clear(entry);
  }
}

module.exports = {
  NativeDictation,
  commandFrame,
  validID,
};
