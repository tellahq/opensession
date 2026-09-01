#!/usr/bin/env bun

import { existsSync, unlinkSync, writeFileSync } from "fs";
import { sessionsDir } from "../server/paths";
import { runtimeGeneration } from "../server/runtime-generation";
import { readExecutorCredential } from "./auth";
import { ExecutorCoordinator } from "./coordinator";
import { verifyRunHostHelper } from "./host-unit";
import { startExecutorServer } from "./server";

export async function runExecutor(): Promise<void> {
  process.umask(0o077);
  await verifyRunHostHelper();
  const token = readExecutorCredential();
  if (!token) throw new Error("executor credential is unavailable");
  const root = sessionsDir();
  const coordinator = new ExecutorCoordinator(root, token);
  const listener = await startExecutorServer({
    sessionsDir: root,
    coordinator,
    token,
  });
  const readyFile = process.env.OPENSESSION_EXECUTOR_READY_FILE;
  if (readyFile) {
    writeFileSync(
      readyFile,
      `${JSON.stringify({
        pid: process.pid,
        generation: runtimeGeneration(),
        component: "executor",
      })}\n`,
      { mode: 0o600 },
    );
  }
  console.log("[executor] listening");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    coordinator.closeAdmission();
    listener.stop(false);
    await Promise.race([coordinator.drain(), Bun.sleep(25_000)]);
    if (readyFile && existsSync(readyFile)) unlinkSync(readyFile);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

if (import.meta.main) await runExecutor();
