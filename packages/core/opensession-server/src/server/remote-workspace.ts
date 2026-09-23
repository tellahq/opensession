/**
 * remote-workspace — the engine-side half of "the harness runs here, the
 * Sandbox is a tool" (docs/self-hosting-sandboxes.md).
 *
 * A Sandbox session's agent loop runs in an ordinary detached run host on
 * this server, like any other session. Only its workspace is elsewhere: every
 * read, write, listing, search and shell command the model asks for becomes
 * one command inside the Sandbox. Nothing the model does executes on this
 * machine, and nothing the loop needs (model credentials, history, MCP
 * connections, permissions) is placed in the Sandbox.
 *
 * Transport: the run host already holds a per-run bearer for the server's
 * run-rpc unix socket (run-rpc.ts). `/workspace/exec` on that socket runs one
 * shell script in the session's recorded Sandbox and answers with its exit
 * code and output (sandbox/workspace-rpc.ts). This module turns that single
 * primitive into Pi's tool operations. Every operation is one round trip;
 * directory listings carry entry types so `ls` does not stat each entry.
 *
 * Paths are the Sandbox's own. The model sees the Sandbox checkout path as
 * its working directory, and a relative path resolves against it. The one
 * host-side exception is read access to the skills this server ships, which
 * exist only here (see `hostReadableRoots`).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, posix, resolve as resolveLocal, sep } from "node:path";
import type { RemoteWorkspaceSpec } from "@tellahq/opensession-protocol/runner";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { rpcSocketPath } from "./run-rpc-protocol";

/** A remote workspace as the run host sees it: the spec plus its bearer. */
export type RemoteWorkspaceRun = RemoteWorkspaceSpec & { rpcToken: string };

export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteExecRequest {
  /** Bash script, run with `bash -c`. */
  script: string;
  /** Extra environment for the script. */
  env?: Record<string, string>;
  /** Working directory; default the workspace checkout. */
  cwd?: string;
  timeoutMs?: number;
  /** Safe to send again when the server went away mid-request (reads). A
   *  shell command or a write is never sent twice. */
  idempotent?: boolean;
  /** Give the command this Sandbox's workload identity lease (shell
   *  commands). File operations do not need one. */
  identity?: boolean;
}

/** How a request reaches the server. Swappable for tests. */
export type RemoteWorkspaceTransport = (
  body: Record<string, unknown>,
  options?: { idempotent?: boolean },
) => Promise<RemoteExecResult>;

/** Largest file `read` fetches. Pi truncates what it shows far below this;
 *  the cap only bounds what crosses the wire for an accidental huge file. */
export const REMOTE_READ_CAP_BYTES = 8 * 1024 * 1024;
/** Base64 carried per write command, well under a single argument's 128 KiB
 *  limit on Linux, which is what the provider's `bash -c` receives. */
const WRITE_CHUNK_BASE64 = 64 * 1024;
/** Listing and stat answers stay valid this long: `ls` asks for the type of
 *  every entry right after listing the directory. */
const STAT_CACHE_MS = 5_000;
/** How long a request keeps retrying while the server's socket is away (a
 *  deploy restarts it; the run host outlives that). */
const RECONNECT_WINDOW_MS = 90_000;

export class RemoteWorkspaceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The request never reached the server (its socket is not there): always
 *  safe to try again. */
function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "FailedToOpenSocket" ||
    /Unable to connect|ECONNREFUSED|FailedToOpenSocket/i.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}

/** The connection dropped after the request may have been accepted. */
function isDroppedConnection(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return (
    code === "ECONNRESET" ||
    /ECONNRESET|socket connection was closed|connection closed/i.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}

/** The run-rpc socket transport. Connection failures before the request was
 *  accepted are retried through a server restart; an answered error is not. */
export function unixSocketTransport(
  token: string,
  socketPath = rpcSocketPath(OPENSESSION_SESSIONS_DIR),
): RemoteWorkspaceTransport {
  return async (body, options) => {
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let data: Record<string, unknown> | null = null;
      try {
        res = await fetch("http://opensession/workspace/exec", {
          method: "POST",
          unix: socketPath,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, token }),
        } as RequestInit & { unix: string });
        data = (await res.json().catch((error: unknown) => {
          throw Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { code: "ECONNRESET" },
          );
        })) as Record<string, unknown>;
      } catch (error) {
        const retry =
          isConnectFailure(error) ||
          (options?.idempotent === true && isDroppedConnection(error));
        if (retry && Date.now() < deadline) {
          await Bun.sleep(Math.min(5_000, 250 * 2 ** attempt));
          continue;
        }
        if (isDroppedConnection(error))
          throw new RemoteWorkspaceError(
            "The Open Session server restarted while this ran in the Sandbox; it may still have run or be running there. Check before repeating it.",
          );
        throw error;
      }
      if (!res.ok || typeof data?.error === "string") {
        const message = String(data?.error || `HTTP ${res.status}`);
        // A restarted server re-registers run tokens while it reattaches its
        // hosts; the first requests after a restart may beat that.
        if (
          res.status === 403 &&
          /unknown run token/.test(message) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(Math.min(5_000, 250 * 2 ** attempt));
          continue;
        }
        throw new RemoteWorkspaceError(`Sandbox workspace: ${message}`);
      }
      return {
        exitCode: Number(data?.exitCode ?? 1),
        stdout: String(data?.stdout ?? ""),
        stderr: String(data?.stderr ?? ""),
      };
    }
  };
}

type EntryKind = "d" | "f";

/**
 * One run's view of its Sandbox workspace. Construct once per run; the stat
 * cache is per instance.
 */
export class RemoteWorkspace {
  readonly cwd: string;
  readonly scratchDir: string;
  readonly os: "linux" | "darwin";
  private readonly kinds = new Map<string, { kind: EntryKind; at: number }>();
  private readonly reads = new Map<
    string,
    { bytes: Buffer; truncated: boolean; at: number }
  >();

  constructor(
    readonly spec: RemoteWorkspaceSpec,
    private readonly transport: RemoteWorkspaceTransport,
  ) {
    this.cwd = spec.cwd;
    this.scratchDir = spec.scratchDir;
    this.os = spec.os || "linux";
  }

  /** A path as the Sandbox sees it: relative paths resolve against the
   *  workspace checkout. */
  resolve(path: string): string {
    return posix.resolve(this.cwd, path || ".");
  }

  exec(request: RemoteExecRequest): Promise<RemoteExecResult> {
    return this.transport(
      {
        script: request.script,
        env: request.env,
        cwd: request.cwd ?? this.cwd,
        timeoutMs: request.timeoutMs,
        ...(request.identity ? { identity: true } : {}),
      },
      { idempotent: request.idempotent === true },
    );
  }

  private remember(path: string, kind: EntryKind): void {
    this.kinds.set(path, { kind, at: Date.now() });
  }

  private cachedKind(path: string): EntryKind | undefined {
    const hit = this.kinds.get(path);
    if (hit && Date.now() - hit.at < STAT_CACHE_MS) return hit.kind;
    this.kinds.delete(path);
    return undefined;
  }

  /** Forget cached answers about a path the run just changed. */
  private invalidate(path: string): void {
    this.kinds.delete(path);
    this.reads.delete(path);
  }

  /** `d`, `f`, or null when nothing is there. */
  async kind(rawPath: string): Promise<EntryKind | null> {
    const path = this.resolve(rawPath);
    const cached = this.cachedKind(path);
    if (cached) return cached;
    const result = await this.exec({
      script:
        'if [ -d "$OS_PATH" ]; then echo d; elif [ -e "$OS_PATH" ]; then echo f; else echo -; fi',
      env: { OS_PATH: path },
      cwd: "/",
      idempotent: true,
    });
    const answer = result.stdout.trim();
    if (result.exitCode !== 0)
      throw new RemoteWorkspaceError(
        `Could not inspect ${path} in the Sandbox: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    if (answer !== "d" && answer !== "f") return null;
    this.remember(path, answer);
    return answer;
  }

  /**
   * The file's bytes, at most REMOTE_READ_CAP_BYTES of them. `keep` holds
   * the answer for exactly one following readFile of the same path (the
   * tools check access, then read); a write or a command drops it. `whole`
   * refuses a file larger than the cap instead of truncating it, for a
   * caller that writes the content back.
   */
  async readFile(
    rawPath: string,
    options: { keep?: boolean; whole?: boolean } = {},
  ): Promise<Buffer> {
    const path = this.resolve(rawPath);
    const cached = this.reads.get(path);
    if (cached) {
      this.reads.delete(path);
      if (Date.now() - cached.at < STAT_CACHE_MS) {
        if (options.whole && cached.truncated) throw tooLarge(path);
        if (options.keep) this.reads.set(path, cached);
        return cached.bytes;
      }
    }
    const result = await this.exec({
      script:
        'f="$OS_PATH"; if [ -d "$f" ]; then echo EISDIR >&2; exit 21; fi; ' +
        'if [ ! -e "$f" ]; then echo ENOENT >&2; exit 2; fi; ' +
        'if [ ! -r "$f" ]; then echo EACCES >&2; exit 13; fi; ' +
        'wc -c < "$f" | tr -d " "; ' +
        `head -c ${REMOTE_READ_CAP_BYTES} "$f" | base64 | tr -d '\\n'`,
      env: { OS_PATH: path },
      cwd: "/",
      idempotent: true,
    });
    if (result.exitCode !== 0) throw fsError(result, path, "open");
    const newline = result.stdout.indexOf("\n");
    const size = Number(result.stdout.slice(0, newline));
    const bytes = Buffer.from(
      result.stdout.slice(newline + 1).trim(),
      "base64",
    );
    const truncated = Number.isFinite(size) && size > bytes.length;
    this.remember(path, "f");
    if (options.whole && truncated) throw tooLarge(path);
    if (options.keep)
      this.reads.set(path, { bytes, truncated, at: Date.now() });
    return bytes;
  }

  /** Forget every cached answer: a command the model ran may have changed
   *  anything. */
  forgetCache(): void {
    this.kinds.clear();
    this.reads.clear();
  }

  /** Create or replace a file, creating its directory. Content above one
   *  command's argument budget is written in chunks to a temporary file and
   *  moved into place, so a reader never sees half a file. */
  async writeFile(rawPath: string, content: string | Buffer): Promise<void> {
    const path = this.resolve(rawPath);
    const encoded = Buffer.from(content).toString("base64");
    this.invalidate(path);
    if (encoded.length <= WRITE_CHUNK_BASE64) {
      const result = await this.exec({
        script:
          'mkdir -p "$(dirname "$OS_PATH")" && printf %s "$OS_DATA" | base64 -d > "$OS_PATH"',
        env: { OS_PATH: path, OS_DATA: encoded },
        cwd: "/",
      });
      if (result.exitCode !== 0) throw fsError(result, path, "write");
      return;
    }
    const temporary = `${path}.opensession-${crypto.randomUUID().slice(0, 8)}`;
    try {
      for (let at = 0; at < encoded.length; at += WRITE_CHUNK_BASE64) {
        const chunk = encoded.slice(at, at + WRITE_CHUNK_BASE64);
        const result = await this.exec({
          script:
            (at === 0
              ? 'mkdir -p "$(dirname "$OS_PATH")" && : > "$OS_TMP" && '
              : "") + 'printf %s "$OS_DATA" | base64 -d >> "$OS_TMP"',
          env: { OS_PATH: path, OS_TMP: temporary, OS_DATA: chunk },
          cwd: "/",
        });
        if (result.exitCode !== 0) throw fsError(result, path, "write");
      }
      const moved = await this.exec({
        script: 'mv -f "$OS_TMP" "$OS_PATH"',
        env: { OS_PATH: path, OS_TMP: temporary },
        cwd: "/",
      });
      if (moved.exitCode !== 0) throw fsError(moved, path, "write");
    } catch (error) {
      await this.exec({
        script: 'rm -f "$OS_TMP"',
        env: { OS_TMP: temporary },
        cwd: "/",
      }).catch(() => {});
      throw error;
    }
  }

  async mkdir(rawPath: string): Promise<void> {
    const path = this.resolve(rawPath);
    const result = await this.exec({
      script: 'mkdir -p "$OS_PATH"',
      env: { OS_PATH: path },
      cwd: "/",
    });
    if (result.exitCode !== 0) throw fsError(result, path, "mkdir");
    this.remember(path, "d");
  }

  async readdir(rawPath: string): Promise<string[]> {
    const path = this.resolve(rawPath);
    const result = await this.exec({
      script:
        'cd "$OS_PATH" 2>/dev/null || { if [ -e "$OS_PATH" ]; then echo ENOTDIR >&2; exit 20; fi; echo ENOENT >&2; exit 2; }; ' +
        'for e in .* *; do case "$e" in .|..) continue;; esac; ' +
        '[ -e "$e" ] || [ -L "$e" ] || continue; ' +
        'if [ -d "$e" ]; then printf \'d\\t%s\\n\' "$e"; else printf \'f\\t%s\\n\' "$e"; fi; done',
      env: { OS_PATH: path },
      cwd: "/",
      idempotent: true,
    });
    if (result.exitCode !== 0) throw fsError(result, path, "scandir");
    this.remember(path, "d");
    const names: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab !== 1) continue;
      const kind = line[0] as EntryKind;
      const name = line.slice(2);
      if (!name) continue;
      names.push(name);
      this.remember(posix.join(path, name), kind);
    }
    return names;
  }

  /** Paths under `searchPath` matching a glob, like fd: a bare pattern
   *  matches a basename anywhere, .gitignore is respected. */
  async glob(
    pattern: string,
    searchPath: string,
    options: { ignore: string[]; limit: number },
  ): Promise<string[]> {
    const root = this.resolve(searchPath);
    const limit = Math.max(1, options.limit || 1000);
    const args = ["--files", "--hidden", "-g", pattern, "-g", "!.git"];
    for (const ignore of options.ignore || []) args.push("-g", `!${ignore}`);
    // rg exits 1 for "no files"; any other failure (a bad glob) must not
    // read as an empty result.
    const result = await this.exec({
      script:
        `rg ${args.map(shellWord).join(" ")} | head -n ${limit}; ` +
        'code="${PIPESTATUS[0]}"; [ "$code" = 1 ] && exit 0; exit "$code"',
      cwd: root,
      timeoutMs: 120_000,
      idempotent: true,
    });
    if (result.exitCode !== 0 && !result.stdout.trim())
      throw new RemoteWorkspaceError(
        (result.stderr || `find failed in ${root}`).trim().slice(0, 300),
      );
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((relative) => posix.join(root, relative.replace(/^\.\//, "")))
      .sort();
  }
}

function tooLarge(path: string): RemoteWorkspaceError {
  return new RemoteWorkspaceError(
    `EFBIG: ${path} is larger than ${REMOTE_READ_CAP_BYTES / 1024 / 1024} MiB; change it with a shell command instead.`,
    "EFBIG",
  );
}

/** Map a failed file command to an fs-style error the tools already word. */
function fsError(
  result: RemoteExecResult,
  path: string,
  syscall: string,
): RemoteWorkspaceError {
  const text = (result.stderr || result.stdout).trim();
  const code =
    result.exitCode === 2 || /ENOENT|No such file/.test(text)
      ? "ENOENT"
      : result.exitCode === 13 || /EACCES|Permission denied/.test(text)
        ? "EACCES"
        : result.exitCode === 21 || /EISDIR/.test(text)
          ? "EISDIR"
          : result.exitCode === 20 || /ENOTDIR/.test(text)
            ? "ENOTDIR"
            : undefined;
  const error = new RemoteWorkspaceError(
    code
      ? `${code}: ${
          code === "ENOENT"
            ? "no such file or directory"
            : code === "EACCES"
              ? "permission denied"
              : code === "EISDIR"
                ? "illegal operation on a directory"
                : "not a directory"
        }, ${syscall} '${path}'`
      : `Sandbox ${syscall} failed for ${path}: ${text.slice(0, 300) || `exit ${result.exitCode}`}`,
    code,
  );
  return error;
}

/** POSIX-quote one shell word. */
export function shellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

const runWorkspaces = new Map<string, RemoteWorkspace>();

/**
 * The run's workspace client, shared by everything in this process that acts
 * for the run (attachment staging, tools). Refuses a spec without its token:
 * a Sandbox run's tools run in the Sandbox or not at all.
 */
export function remoteWorkspaceForRun(
  run: RemoteWorkspaceRun,
): RemoteWorkspace {
  if (!run.rpcToken || !run.sandboxId || !run.cwd.startsWith("/"))
    throw new RemoteWorkspaceError(
      "This run's Sandbox workspace is not reachable (no run token). Its tools never run anywhere else; send the prompt again.",
    );
  const key = `${run.rpcToken}:${run.provider}:${run.sandboxId}`;
  let workspace = runWorkspaces.get(key);
  if (!workspace) {
    workspace = new RemoteWorkspace(run, unixSocketTransport(run.rpcToken));
    runWorkspaces.set(key, workspace);
  }
  return workspace;
}

// ── Pi tool operations ───────────────────────────────────────────────────────

/**
 * Directories this server may read on the model's behalf in a remote run:
 * the skills it ships. They exist only here, and the model is told their
 * paths, so read/ls/find under them are served from local disk. Read only;
 * nothing else on this machine is reachable.
 */
function underRoot(path: string, roots: string[]): boolean {
  const resolved = resolveLocal(path);
  return roots.some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );
}

/** The same shape makeGuardedToolOps returns, acting on the Sandbox. */
export function makeRemoteToolOps(
  workspace: RemoteWorkspace,
  hostReadableRoots: string[] = [],
) {
  // Lexically under a shipped root, and still there once symlinks resolve.
  const local = (path: string) => {
    if (!underRoot(path, hostReadableRoots)) return false;
    try {
      return underRoot(realpathSync(path), hostReadableRoots);
    } catch {
      return true; // not there: answered from here as missing
    }
  };
  const exists = async (path: string) =>
    local(path) ? existsSync(path) : (await workspace.kind(path)) !== null;
  const readOnlyHere = (path: string) => {
    if (local(path))
      throw new RemoteWorkspaceError(
        `${path} is one of Open Session's shipped skills and is read only.`,
      );
  };
  return {
    /** Remote runs have no containment root: the Sandbox is the boundary. */
    guard: (path: string) => workspace.resolve(path),
    read: {
      readFile: async (path: string) =>
        local(path) ? readFile(path) : workspace.readFile(path),
      access: async (path: string) => {
        if (local(path)) {
          await readFile(path);
          return;
        }
        // Fetch now: the read that follows is served from this answer.
        await workspace.readFile(path, { keep: true });
      },
      detectImageMimeType: async (path: string) =>
        sniffImageBytes(
          local(path)
            ? await readFile(path)
            : await workspace.readFile(path, { keep: true }),
        ),
    },
    ls: {
      exists,
      stat: async (path: string) => {
        if (local(path)) {
          const { stat } = await import("node:fs/promises");
          return stat(path);
        }
        const kind = await workspace.kind(path);
        if (!kind)
          throw new RemoteWorkspaceError(
            `ENOENT: no such file or directory, stat '${workspace.resolve(path)}'`,
            "ENOENT",
          );
        return { isDirectory: () => kind === "d" };
      },
      readdir: async (path: string) => {
        if (local(path)) {
          const { readdir } = await import("node:fs/promises");
          return readdir(path);
        }
        return workspace.readdir(path);
      },
    },
    find: {
      exists,
      glob: async (
        pattern: string,
        searchPath: string,
        options: { ignore: string[]; limit: number },
      ) => {
        if (local(searchPath)) {
          const out: string[] = [];
          const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
          for await (const rel of new Bun.Glob(effective).scan({
            cwd: searchPath,
            dot: true,
            followSymlinks: false,
          })) {
            out.push(`${searchPath}/${rel}`);
            if (out.length >= (options.limit || 1000)) break;
          }
          return out.sort();
        }
        return workspace.glob(pattern, searchPath, options);
      },
    },
    edit: {
      readFile: async (path: string) => {
        readOnlyHere(path);
        // Written back whole: never edit a truncated copy.
        return workspace.readFile(path, { whole: true });
      },
      writeFile: async (path: string, content: string) => {
        readOnlyHere(path);
        await workspace.writeFile(path, content);
      },
      access: async (path: string) => {
        readOnlyHere(path);
        const result = await workspace.exec({
          script:
            'if [ ! -e "$OS_PATH" ]; then echo ENOENT >&2; exit 2; fi; ' +
            'if [ ! -r "$OS_PATH" ] || [ ! -w "$OS_PATH" ]; then echo EACCES >&2; exit 13; fi',
          env: { OS_PATH: workspace.resolve(path) },
          cwd: "/",
        });
        if (result.exitCode !== 0)
          throw fsError(result, workspace.resolve(path), "access");
      },
    },
    write: {
      writeFile: async (path: string, content: string) => {
        readOnlyHere(path);
        await workspace.writeFile(path, content);
      },
      // writeFile creates the directory in the same command.
      mkdir: async (_dir: string) => {},
    },
  };
}

/** Image type from magic bytes (the formats Pi's read tool can attach). */
export function sniffImageBytes(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── grep ─────────────────────────────────────────────────────────────────────

const GREP_TRANSFER_CAP = 256 * 1024;

/** ripgrep inside the Sandbox, with the local grep tool's output contract:
 *  paths relative to the search root, a match limit, a byte cap. */
export function makeRemoteGrepExecute(workspace: RemoteWorkspace) {
  return async function execute(
    _toolCallId: string,
    params: {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
      ignoreCase?: unknown;
      literal?: unknown;
      context?: unknown;
      limit?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: undefined;
  }> {
    const pattern = String(params?.pattern ?? "");
    if (!pattern) throw new Error("grep: pattern is required");
    if (signal?.aborted) throw new Error("Operation aborted");
    const rawPath =
      typeof params?.path === "string" && params.path ? params.path : ".";
    const searchPath = workspace.resolve(rawPath);
    const kind = await workspace.kind(searchPath);
    if (!kind) throw new Error(`Path not found: ${searchPath}`);
    const args = [
      "--line-number",
      "--color=never",
      "--hidden",
      "--with-filename",
    ];
    if (params?.ignoreCase) args.push("--ignore-case");
    if (params?.literal) args.push("--fixed-strings");
    if (typeof params?.glob === "string" && params.glob)
      args.push("--glob", params.glob);
    const contextLines = Number(params?.context);
    if (Number.isFinite(contextLines) && contextLines > 0)
      args.push("--context", String(Math.floor(contextLines)));
    const limit = Math.max(1, Number(params?.limit) || GREP_DEFAULT_LIMIT);
    args.push("--", pattern, kind === "d" ? "." : posix.basename(searchPath));
    const result = await workspace.exec({
      script: `rg ${args.map(shellWord).join(" ")} | head -c ${GREP_TRANSFER_CAP}; exit "\${PIPESTATUS[0]}"`,
      cwd: kind === "d" ? searchPath : posix.dirname(searchPath),
      timeoutMs: 120_000,
    });
    if (signal?.aborted) throw new Error("Operation aborted");
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdout)
      throw new Error(
        result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`,
      );
    let out = "";
    let matches = 0;
    let matchLimitReached = false;
    for (const line of result.stdout.split("\n")) {
      if (/^(.+?):(\d+):/.test(line)) {
        if (matches >= limit) {
          matchLimitReached = true;
          continue;
        }
        matches++;
      } else if (matches >= limit) continue;
      out += `${line}\n`;
    }
    let text = out.trimEnd();
    if (!text)
      return {
        content: [{ type: "text", text: "No matches found" }],
        details: undefined,
      };
    if (text.length > GREP_OUTPUT_CAP)
      text = `${text.slice(0, GREP_OUTPUT_CAP)}\n\n[Truncated: 50KB limit reached]`;
    if (matchLimitReached)
      text += `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`;
    return { content: [{ type: "text", text }], details: undefined };
  };
}
const GREP_DEFAULT_LIMIT = 100;
const GREP_OUTPUT_CAP = 50 * 1024;

// ── bash ─────────────────────────────────────────────────────────────────────

export interface RemoteCommandResult {
  /** Tail of merged stdout+stderr, at most `outputCap` characters. */
  output: string;
  /** Characters dropped from the front. */
  droppedChars: number;
  exitCode: number | null;
  timedOut: boolean;
}

const EXIT_MARKER = "__OPENSESSION_EXIT__";

/**
 * The wrapper every remote command runs in. The command is carried in the
 * environment (or, when large, in a file), never spliced into shell text. It
 * runs as its own process group (job control), so a timeout or a Stop
 * reaches everything it started, with its output going to a file rather
 * than the provider's pipe: a server it backgrounded (`bun run dev &`)
 * keeps the file open, not the call. That file stays in the session's
 * scratch while such a server lives, so its log remains visible. After the
 * command exits, the tail of the file and one marker line are printed.
 *
 * A Stop writes `$OS_PIDFILE.cancel` before it reads the pid file, and the
 * wrapper checks for it after writing the pid file, so a Stop that races
 * the start still reaches the command.
 */
export function remoteCommandScript(input: {
  timeoutS: number;
  outputCap: number;
}): string {
  const timeout = Math.max(1, Math.floor(input.timeoutS));
  return [
    "set -m",
    // TMPDIR arrives as OS_TMPDIR: a provider's own exec wrapper may call
    // mktemp before this script runs, and the directory may not exist yet.
    'if [ -n "$OS_TMPDIR" ] && mkdir -p "$OS_TMPDIR" 2>/dev/null; then export TMPDIR="$OS_TMPDIR"; fi',
    'mkdir -p "$OPENSESSION_SCRATCH" 2>/dev/null',
    'out="$(mktemp "${TMPDIR:-/tmp}/os-cmd-XXXXXX")" || exit 125',
    'if [ -n "$OS_CMD_FILE" ]; then bash "$OS_CMD_FILE" </dev/null >"$out" 2>&1 & else bash -c "$OS_CMD" </dev/null >"$out" 2>&1 & fi',
    "pid=$!",
    'printf %s "$pid" > "$OS_PIDFILE"',
    'if [ -e "$OS_PIDFILE.cancel" ]; then kill -TERM -- -"$pid" 2>/dev/null; fi',
    `( sleep ${timeout}; : > "$out.timeout"; kill -TERM -- -"$pid" 2>/dev/null; sleep 2; kill -KILL -- -"$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &`,
    "watchdog=$!",
    'wait "$pid"; code=$?',
    'kill -- -"$watchdog" 2>/dev/null; kill "$watchdog" 2>/dev/null',
    'timedout=0; if [ -e "$out.timeout" ]; then timedout=1; fi',
    'size=$(wc -c < "$out" | tr -d " ")',
    `tail -c ${input.outputCap} "$out"`,
    `printf '\n${EXIT_MARKER} %s %s %s\n' "$code" "$size" "$timedout"`,
    'rm -f "$out.timeout" "$OS_PIDFILE" "$OS_PIDFILE.cancel"',
    // Something the command left running still writes here: keep the log.
    'kill -0 -- -"$pid" 2>/dev/null || rm -f "$out"',
  ].join("\n");
}

/** Parse what remoteCommandScript printed. Null when the marker is missing
 *  (the wrapper itself was killed or never ran). */
export function parseRemoteCommandOutput(
  stdout: string,
  outputCap: number,
): RemoteCommandResult | null {
  const at = stdout.lastIndexOf(`\n${EXIT_MARKER} `);
  if (at < 0) return null;
  const [code, size, timedOut] = stdout
    .slice(at + EXIT_MARKER.length + 2)
    .trim()
    .split(/\s+/);
  const output = stdout.slice(0, at);
  const total = Number(size) || output.length;
  return {
    output: output.length > outputCap ? output.slice(-outputCap) : output,
    droppedChars: Math.max(0, total - Math.min(output.length, outputCap)),
    exitCode: code === undefined ? null : Number(code),
    timedOut: timedOut === "1",
  };
}

/** Commands longer than this travel as a file: one argument may not exceed
 *  128 KiB on Linux, and providers put the environment on the command line. */
const INLINE_COMMAND_BYTES = 32 * 1024;
/** How long a stopped command's call may take to come back before the tool
 *  answers anyway (an unreachable Sandbox must not hold a Stop). */
const STOP_GRACE_MS = 15_000;

/** Run one model shell command in the Sandbox. `signals` stop it: the
 *  process group is killed by a second command, and the tool answers within
 *  STOP_GRACE_MS of the Stop whatever the first call does. */
export async function runRemoteCommand(
  workspace: RemoteWorkspace,
  input: {
    command: string;
    timeoutS: number;
    outputCap: number;
    env: Record<string, string>;
    signals: AbortSignal[];
  },
): Promise<RemoteCommandResult & { cancelled: boolean }> {
  const id = crypto.randomUUID().slice(0, 12);
  const pidFile = `${workspace.scratchDir}/.os-cmd-${id}.pid`;
  let cancelled = false;
  let stopped: () => void = () => {};
  const stop = new Promise<void>((resolve) => (stopped = resolve));
  const kill = () => {
    if (cancelled) return;
    cancelled = true;
    stopped();
    void workspace
      .exec({
        script:
          ': > "$OS_PIDFILE.cancel"; pid="$(cat "$OS_PIDFILE" 2>/dev/null)"; [ -n "$pid" ] || exit 0; ' +
          'kill -TERM -- -"$pid" 2>/dev/null; sleep 1.5; kill -KILL -- -"$pid" 2>/dev/null; exit 0',
        env: { OS_PIDFILE: pidFile },
        cwd: "/",
        timeoutMs: 30_000,
      })
      .catch(() => {});
  };
  // Whatever the command does, the next file operation must look again.
  workspace.forgetCache();
  let commandFile: string | undefined;
  try {
    if (Buffer.byteLength(input.command) > INLINE_COMMAND_BYTES) {
      commandFile = `${workspace.scratchDir}/.os-cmd-${id}.sh`;
      await workspace.writeFile(commandFile, input.command);
    }
    for (const signal of input.signals)
      signal.addEventListener("abort", kill, { once: true });
    if (input.signals.some((signal) => signal.aborted)) kill();
    const call = workspace.exec({
      script: remoteCommandScript(input),
      env: {
        ...input.env,
        ...(commandFile
          ? { OS_CMD_FILE: commandFile }
          : { OS_CMD: input.command }),
        OS_PIDFILE: pidFile,
      },
      identity: true,
      // The provider's own deadline is a backstop behind the wrapper's.
      timeoutMs: (input.timeoutS + 30) * 1000,
    });
    const raced = await Promise.race([
      call,
      stop.then(() =>
        Promise.race([call, Bun.sleep(STOP_GRACE_MS).then(() => null)]),
      ),
    ]);
    call.catch(() => {});
    if (!raced)
      return {
        output: "",
        droppedChars: 0,
        exitCode: null,
        timedOut: false,
        cancelled: true,
      };
    const parsed = parseRemoteCommandOutput(raced.stdout, input.outputCap);
    if (!parsed) {
      const detail = (raced.stderr || raced.stdout).trim().slice(-2_000);
      return {
        output: detail
          ? `The Sandbox did not finish the command: ${detail}`
          : "The Sandbox did not finish the command.",
        droppedChars: 0,
        exitCode: raced.exitCode,
        timedOut: raced.exitCode === 124,
        cancelled,
      };
    }
    return { ...parsed, cancelled };
  } finally {
    for (const signal of input.signals)
      signal.removeEventListener("abort", kill);
    workspace.forgetCache();
    if (commandFile)
      void workspace
        .exec({
          script: 'rm -f "$OS_FILE"',
          env: { OS_FILE: commandFile },
          cwd: "/",
        })
        .catch(() => {});
  }
}

/**
 * The environment a remote command receives: the run's explicit entries,
 * minus everything that names this machine (its PATH, HOME, temp and
 * credential-file paths), with Sandbox scratch in their place. GitHub
 * transport goes through an inline credential helper reading $GH_TOKEN,
 * since this server's helper binary does not exist in the Sandbox.
 */
export function remoteCommandEnv(
  local: Record<string, string>,
  workspace: Pick<RemoteWorkspace, "scratchDir">,
  runKey: string,
  isolatedHome: boolean,
): Record<string, string> {
  const dropped = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "OPENSESSION_SCRATCH",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_PROFILE",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_HOME",
    "OPENAI_API_KEY",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(local))
    if (!dropped.has(key)) env[key] = value;
  for (let index = 0; ; index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    if (key === undefined) break;
    if (
      /^credential\..*\.helper$/.test(key) &&
      env[`GIT_CONFIG_VALUE_${index}`]
    )
      env[`GIT_CONFIG_VALUE_${index}`] = INLINE_GITHUB_CREDENTIAL_HELPER;
  }
  const safeKey = runKey.replace(/[^A-Za-z0-9_-]/g, "_");
  const scratch = workspace.scratchDir;
  env.OS_TMPDIR = `${scratch}/tmp`;
  env.OPENSESSION_SCRATCH = scratch;
  env.GH_CONFIG_DIR = `${scratch}/gh-config-${safeKey}`;
  if (isolatedHome) {
    const home = `${scratch}/automation-home-${safeKey}`;
    env.HOME = home;
    env.XDG_CONFIG_HOME = `${home}/.config`;
    env.GH_CONFIG_DIR = `${home}/.config/gh`;
  }
  return env;
}

export const INLINE_GITHUB_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

// ── Attachments ──────────────────────────────────────────────────────────────

/** Writes a staged attachment into the Sandbox's scratch; false when it
 *  could not. Same "never overwrite" contract as the local stager. */
export function remoteAttachmentWriter(workspace: RemoteWorkspace) {
  return async (path: string, bytes: Buffer): Promise<boolean> => {
    try {
      if ((await workspace.kind(path)) === "f") return true;
      await workspace.writeFile(path, bytes);
      return true;
    } catch (error) {
      console.warn(`[remote-workspace] attachment ${path} not written:`, error);
      return false;
    }
  };
}

// ── Context (AGENTS.md, skills) ──────────────────────────────────────────────

const CONTEXT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "AGENTS.local.md",
  "CLAUDE.local.md",
];
const CONTEXT_CAP_BYTES = 2 * 1024 * 1024;
const FILE_MARKER = "__OPENSESSION_FILE__";

/**
 * Copy what the loop reads from the checkout itself (context files and the
 * checkout's own SKILL.md files) into a local mirror, in one command. The
 * mirror has the checkout's layout, so the resource loader reads it exactly
 * as it reads a local worktree; `toRemote` maps its paths back to the ones
 * the model can act on.
 */
export async function mirrorRemoteContext(
  workspace: RemoteWorkspace,
  mirrorDir: string,
): Promise<{
  dir: string;
  toRemote: (localPath: string) => string;
}> {
  const script = [
    `emit() { printf '${FILE_MARKER} %s\\n' "$1"; base64 < "$1" | tr -d '\\n'; printf '\\n'; }`,
    `for f in ${CONTEXT_FILES.join(" ")}; do [ -f "$f" ] && emit "$f"; done`,
    "for d in .claude/skills .agents/skills; do",
    '  [ -d "$d" ] || continue',
    '  find -L "$d" -maxdepth 3 -name SKILL.md -type f 2>/dev/null | sort | while read -r f; do emit "$f"; done',
    "done",
    "exit 0",
  ].join("\n");
  const result = await workspace.exec({ script, timeoutMs: 60_000 });
  await rm(mirrorDir, { recursive: true, force: true });
  await mkdir(mirrorDir, { recursive: true });
  let total = 0;
  const lines = result.stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(`${FILE_MARKER} `)) continue;
    const relative = line.slice(FILE_MARKER.length + 1).replace(/^\.\//, "");
    const bytes = Buffer.from(lines[i + 1] || "", "base64");
    i++;
    total += bytes.length;
    if (total > CONTEXT_CAP_BYTES) break;
    // Never let a checkout name a path outside the mirror.
    const target = resolveLocal(mirrorDir, relative);
    if (!target.startsWith(mirrorDir + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return {
    dir: mirrorDir,
    toRemote: (localPath: string) => {
      const resolved = resolveLocal(localPath);
      if (resolved === mirrorDir) return workspace.cwd;
      if (!resolved.startsWith(mirrorDir + sep)) return localPath;
      return posix.join(
        workspace.cwd,
        resolved
          .slice(mirrorDir.length + 1)
          .split(sep)
          .join("/"),
      );
    },
  };
}
