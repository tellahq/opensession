import {
  forgetRemoteBackgroundCommand,
  readRemoteBackgroundCommand,
  startRemoteBackgroundCommand,
  stopRemoteBackgroundCommand,
  type RemoteBackgroundCommand,
  type RemoteWorkspace,
} from "./remote-workspace";

/**
 * Shell commands that outlive the tool call that started them.
 *
 * The foreground `bash` tool holds the whole agent loop until its command
 * exits and kills it at ten minutes. That is right for `git status` and wrong
 * for a build, a long test run or a dev server: the turn can do nothing else
 * meanwhile, a steer waits behind it, and anything slower than the cap cannot
 * run at all. A background command returns its id within seconds and keeps
 * running; `bash_status` waits on it and returns only what it wrote since the
 * last look, and `bash_kill` stops it.
 *
 * A background command belongs to the run that started it. `dispose()` stops
 * whatever is still running when that run ends, so nothing is left behind by
 * a turn that forgot about it. Work that must outlive the turn is a script
 * run or a Portal, not this.
 */

/** How long starting a command waits for it to finish on its own. A typo or
 * a fast command reports its result at once instead of costing a second call. */
export const BACKGROUND_START_WAIT_S = 10;
export const BACKGROUND_STATUS_WAIT_S = 30;
export const BACKGROUND_STATUS_MAX_WAIT_S = 300;
const MAX_BACKGROUND_COMMANDS = 8;
// After the process exits, how long its pipes may keep delivering.
const DRAIN_GRACE_MS = 250;
const KILL_WAIT_MS = 3_000;

export interface ShellReport {
  id: string;
  running: boolean;
  /** Null while running, and for a command that was killed. */
  exitCode: number | null;
  /** Output since the previous report. */
  output: string;
  droppedChars: number;
  runningForS: number;
  /** Seconds since the command last wrote anything. */
  silentForS: number;
}

export interface BackgroundExit {
  command: string;
  exitCode: number | null;
  durationMs: number;
  killed: boolean;
}

export interface BackgroundShells {
  start(command: string, signal?: AbortSignal): Promise<ShellReport>;
  status(id: string, waitS: number, signal?: AbortSignal): Promise<ShellReport>;
  kill(id: string): Promise<ShellReport>;
  /** Stop everything still running. Called when the run ends. */
  dispose(): Promise<void>;
}

/** What a spawned local command exposes. `killTree` reaches its children. */
export interface LocalShellProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  killTree: () => void;
}

export function unknownBackgroundCommand(id: string): Error {
  return new Error(
    `No background command "${id}". It already finished and was reported, or it was stopped when an earlier run ended.`,
  );
}

function tooManyCommands(): Error {
  return new Error(
    `${MAX_BACKGROUND_COMMANDS} background commands are already running. Stop one with bash_kill or wait for one to finish.`,
  );
}

/** Resolve when `done` does, after `ms` (Infinity: never), or on abort,
 * whichever is first. */
function settleWithin(
  done: Promise<unknown>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (ms > 0 && Number.isFinite(ms)) timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    void done.then(finish, finish);
    if (ms <= 0) queueMicrotask(finish);
  });
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

interface LocalCommand {
  id: string;
  command: string;
  startedAt: number;
  lastOutputAt: number;
  unread: string;
  dropped: number;
  done: boolean;
  exitCode: number | null;
  killed: boolean;
  finished: Promise<void>;
  killTree: () => void;
}

/** Background commands on this machine (the host, or a detached run host). */
export function createLocalBackgroundShells(input: {
  spawn: (command: string) => Promise<LocalShellProcess>;
  outputCap: number;
  onExit?: (exit: BackgroundExit) => void;
  /** Tests shorten the wait for a quick exit. */
  startWaitS?: number;
}): BackgroundShells {
  const commands = new Map<string, LocalCommand>();
  let next = 1;
  let disposed = false;

  const report = (entry: LocalCommand): ShellReport => {
    const now = Date.now();
    const output = entry.unread;
    const droppedChars = entry.dropped;
    entry.unread = "";
    entry.dropped = 0;
    // A finished command is reported once, then forgotten.
    if (entry.done) commands.delete(entry.id);
    return {
      id: entry.id,
      running: !entry.done,
      exitCode: entry.done && !entry.killed ? entry.exitCode : null,
      output,
      droppedChars,
      runningForS: seconds(now - entry.startedAt),
      silentForS: seconds(now - entry.lastOutputAt),
    };
  };

  const find = (id: string): LocalCommand => {
    const entry = commands.get(id);
    if (!entry) throw unknownBackgroundCommand(id);
    return entry;
  };

  return {
    async start(command, signal) {
      if (disposed) throw new Error("This run has ended.");
      if (
        [...commands.values()].filter((c) => !c.done).length >=
        MAX_BACKGROUND_COMMANDS
      )
        throw tooManyCommands();
      const proc = await input.spawn(command);
      const startedAt = Date.now();
      const entry: LocalCommand = {
        id: `bg${next++}`,
        command,
        startedAt,
        lastOutputAt: startedAt,
        unread: "",
        dropped: 0,
        done: false,
        exitCode: null,
        killed: false,
        finished: Promise.resolve(),
        killTree: proc.killTree,
      };
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const drain = async (stream: ReadableStream<Uint8Array> | null) => {
        if (!stream) return;
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        readers.push(reader);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            entry.unread += decoder.decode(value, { stream: true });
            entry.lastOutputAt = Date.now();
            if (entry.unread.length > input.outputCap) {
              entry.dropped += entry.unread.length - input.outputCap;
              entry.unread = entry.unread.slice(-input.outputCap);
            }
          }
        } catch {
          // reader.cancel() below lands here: captured output stands.
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      };
      const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
      // Exit-gated, like the foreground tool: a grandchild that inherited the
      // pipes must not keep a finished command "running" forever.
      entry.finished = proc.exited
        .then(
          (code) => code,
          () => null,
        )
        .then(async (code) => {
          await Promise.race([drains, Bun.sleep(DRAIN_GRACE_MS)]);
          for (const reader of readers) {
            try {
              reader.cancel().catch(() => {});
            } catch {}
          }
          entry.exitCode = code;
          entry.done = true;
          input.onExit?.({
            command,
            exitCode: entry.killed ? null : code,
            durationMs: Date.now() - startedAt,
            killed: entry.killed,
          });
        });
      commands.set(entry.id, entry);
      // The run ended while the command was being spawned.
      if (disposed) {
        entry.killed = true;
        entry.killTree();
      }
      await settleWithin(
        entry.finished,
        (input.startWaitS ?? BACKGROUND_START_WAIT_S) * 1000,
        signal,
      );
      return report(entry);
    },

    async status(id, waitS, signal) {
      const entry = find(id);
      await settleWithin(entry.finished, waitS * 1000, signal);
      return report(entry);
    },

    async kill(id) {
      const entry = find(id);
      if (!entry.done) {
        entry.killed = true;
        entry.killTree();
        await settleWithin(entry.finished, KILL_WAIT_MS);
      }
      return report(entry);
    },

    async dispose() {
      disposed = true;
      const running = [...commands.values()].filter((entry) => !entry.done);
      for (const entry of running) {
        entry.killed = true;
        entry.killTree();
      }
      await settleWithin(
        Promise.all(running.map((entry) => entry.finished)),
        KILL_WAIT_MS,
      );
      commands.clear();
    },
  };
}

interface RemoteCommand {
  id: string;
  command: string;
  startedAt: number;
  handle: RemoteBackgroundCommand;
}

/** Background commands in a Sandbox workspace. */
export function createRemoteBackgroundShells(input: {
  workspace: RemoteWorkspace;
  env: Record<string, string>;
  outputCap: number;
  onExit?: (exit: BackgroundExit) => void;
  /** Tests shorten the wait for a quick exit. */
  startWaitS?: number;
}): BackgroundShells {
  const commands = new Map<string, RemoteCommand>();
  let next = 1;
  let disposed = false;

  const read = async (
    entry: RemoteCommand,
    waitS: number,
    signal?: AbortSignal,
    killed = false,
  ): Promise<ShellReport> => {
    const call = readRemoteBackgroundCommand(input.workspace, entry.handle, {
      waitS,
      outputCap: input.outputCap,
    });
    // The wait runs inside the Sandbox, so an abort cannot shorten it there;
    // stop waiting here and let dispose() stop the command.
    let aborted = false;
    await settleWithin(call, Number.POSITIVE_INFINITY, signal);
    if (signal?.aborted) {
      aborted = true;
      call.catch(() => {});
    }
    const now = Date.now();
    if (aborted)
      return {
        id: entry.id,
        running: true,
        exitCode: null,
        output: "",
        droppedChars: 0,
        runningForS: seconds(now - entry.startedAt),
        silentForS: 0,
      };
    const result = await call;
    if (!result.running) {
      commands.delete(entry.id);
      forgetRemoteBackgroundCommand(input.workspace, entry.handle);
      input.onExit?.({
        command: entry.command,
        exitCode: killed ? null : result.exitCode,
        durationMs: now - entry.startedAt,
        killed: killed || result.exitCode === null,
      });
    }
    return {
      id: entry.id,
      running: result.running,
      exitCode: killed ? null : result.exitCode,
      output: result.output,
      droppedChars: result.droppedChars,
      runningForS: seconds(now - entry.startedAt),
      silentForS: result.silentForS,
    };
  };

  const find = (id: string): RemoteCommand => {
    const entry = commands.get(id);
    if (!entry) throw unknownBackgroundCommand(id);
    return entry;
  };

  return {
    async start(command, signal) {
      if (disposed) throw new Error("This run has ended.");
      if (commands.size >= MAX_BACKGROUND_COMMANDS) throw tooManyCommands();
      const handle = await startRemoteBackgroundCommand(input.workspace, {
        command,
        env: input.env,
      });
      const entry: RemoteCommand = {
        id: `bg${next++}`,
        command,
        startedAt: Date.now(),
        handle,
      };
      commands.set(entry.id, entry);
      if (disposed) {
        await stopRemoteBackgroundCommand(input.workspace, handle).catch(
          () => {},
        );
        return read(entry, 0, undefined, true);
      }
      return read(entry, input.startWaitS ?? BACKGROUND_START_WAIT_S, signal);
    },

    async status(id, waitS, signal) {
      return read(find(id), waitS, signal);
    },

    async kill(id) {
      const entry = find(id);
      await stopRemoteBackgroundCommand(input.workspace, entry.handle);
      return read(entry, 1, undefined, true);
    },

    async dispose() {
      disposed = true;
      const running = [...commands.values()];
      commands.clear();
      await Promise.all(
        running.map(async (entry) => {
          try {
            await stopRemoteBackgroundCommand(input.workspace, entry.handle);
          } catch {}
          forgetRemoteBackgroundCommand(input.workspace, entry.handle);
        }),
      );
    },
  };
}

/** The line a report opens with, and the output under it. */
export function shellReportText(report: ShellReport): string {
  const ran = `${report.runningForS}s`;
  const head = report.running
    ? `[${report.id} is still running after ${ran}` +
      (report.silentForS >= 5 ? `, no output for ${report.silentForS}s]` : "]")
    : report.exitCode === null
      ? `[${report.id} was stopped after ${ran}]`
      : `[${report.id} exited with code ${report.exitCode} after ${ran}]`;
  const dropped =
    report.droppedChars > 0
      ? `[output truncated: first ${report.droppedChars} characters dropped]\n`
      : "";
  const body = report.output
    ? `${dropped}${report.output}`
    : report.running
      ? "(no new output)"
      : "(no more output)";
  return `${head}\n${body}`;
}
