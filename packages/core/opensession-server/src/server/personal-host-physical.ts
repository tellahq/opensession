import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunHostMeta } from "../runner-host/protocol";
import { RUN_HOST_HELPER, runHostUnitName } from "../executor/host-unit";
import { stopHostViaExecutor } from "./executor-client";
import type { PersonalRunConsumer } from "./personal-run-consumers";

export interface PersonalPhysicalDependencies {
  command(args: string[]): Promise<{ code: number; output: string }>;
  read(path: string): Promise<string>;
  executorStop(hostId: string, hash: string): Promise<void>;
}
async function command(args: string[]) {
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) {
        child.kill();
        throw new Error("Physical probe output exceeded");
      }
      chunks.push(part.value);
    }
    return {
      code: await child.exited,
      output: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
const defaults: PersonalPhysicalDependencies = {
  command,
  read: (path) => readFile(path, "utf8"),
  executorStop: stopHostViaExecutor,
};

/** All probes are async. No legacy sync process-identity, socket-file or auth
 * helpers; no broker/catalog credential resolution on a cancellation path. */
export async function stopPersonalPhysicalHost(
  c: PersonalRunConsumer,
  dir: string,
  hash: string,
  dispatch: "never" | "direct" | "executor" | "unknown",
  deps: PersonalPhysicalDependencies = defaults,
): Promise<void> {
  if (
    !/^rh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      c.hostId,
    )
  )
    throw new Error("Invalid physical host id");
  const unit = `${runHostUnitName(c.hostId)}.service`;
  async function unitState() {
    const result = await deps.command([
      "systemctl",
      "show",
      unit,
      "--property=LoadState,ActiveState,ControlGroup",
    ]);
    const fields = Object.fromEntries(
      result.output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (
      !fields.LoadState ||
      !["loaded", "not-found"].includes(fields.LoadState) ||
      (result.code !== 0 && fields.LoadState !== "not-found") ||
      !fields.ActiveState ||
      !("ControlGroup" in fields)
    )
      throw new Error("Physical unit state unavailable");
    return fields;
  }
  async function optional(path: string) {
    try {
      return await deps.read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const before = await unitState();
  const bytes = await optional(join(dir, "meta.json"));
  const meta = bytes ? (JSON.parse(bytes) as RunHostMeta) : undefined;
  if (
    meta &&
    (meta.hostId !== c.hostId ||
      meta.osSessionId !== c.sessionId ||
      !Number.isSafeInteger(meta.pid) ||
      meta.pid <= 0)
  )
    throw new Error("Physical process identity mismatch");
  if (dispatch === "executor" || dispatch === "unknown") {
    // Includes delayed/in-flight executor dispatch, not merely current systemd.
    await deps.executorStop(c.hostId, hash);
  } else {
    if (
      dispatch === "never" &&
      !["inactive", "failed"].includes(before.ActiveState!)
    )
      throw new Error("Unexpected physical host before dispatch");
    await deps.command(["sudo", "-n", RUN_HOST_HELPER, "stop", c.hostId]);
  }
  const after = await unitState();
  if (!["inactive", "failed"].includes(after.ActiveState!))
    throw new Error("Personal host remains active");
  for (const group of new Set([
    before.ControlGroup,
    after.ControlGroup,
    `/system.slice/${unit}`,
  ])) {
    if (!group) continue;
    if (
      !group.startsWith("/") ||
      group.split("/").includes("..") ||
      /[\r\n\0]/.test(group)
    )
      throw new Error("Invalid physical cgroup");
    const events = await optional(
      join("/sys/fs/cgroup", group.slice(1), "cgroup.events"),
    );
    if (
      events !== undefined &&
      events.match(/^populated [01]$/gm)?.join("") !== "populated 0"
    )
      throw new Error("Personal cgroup absence unconfirmed");
  }
  if (meta?.pid) {
    if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0)
      throw new Error("Invalid physical pid");
    const stat = await optional(`/proc/${meta.pid}/stat`);
    if (stat !== undefined) {
      const ticks = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19];
      const boot = (await deps.read("/proc/sys/kernel/random/boot_id")).trim();
      if (
        !meta.bootId ||
        !meta.startTicks ||
        !ticks ||
        (meta.bootId === boot && meta.startTicks === ticks)
      )
        throw new Error("Personal process absence unconfirmed");
    }
  }
}
