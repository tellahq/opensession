import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LEDGER_PROTECTED_PHYSICAL_BYTES } from "./ledger-accounting";

const ZERO_CHUNK = new Uint8Array(1024 * 1024);
const RESERVE_MODE = 0o600;

export interface GenerationOwner {
  readonly uid: number;
  readonly gid: number;
}

export interface EmergencyReserveOptions {
  readonly stateDirectory: string;
  readonly owner?: GenerationOwner;
  readonly bytes?: number;
  readonly filename?: string;
}

export interface EmergencyReserveSnapshot {
  readonly path: string;
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
  readonly capacityBytes: number;
}

/**
 * A generation-local, physically allocated emergency reserve. Construction is
 * import-inert and opening it does not grow it: callers first recover/checkpoint
 * SQLite, then call replenish exactly once. Truncation is the only way reserved
 * blocks are released, so unrelated writers cannot consume the reserve itself.
 */
export class GenerationEmergencyReserve {
  readonly path: string;
  readonly capacityBytes: number;
  readonly #fd: number;
  readonly #owner: GenerationOwner;
  #closed = false;

  constructor(options: EmergencyReserveOptions) {
    const stateDirectory = resolve(options.stateDirectory);
    const filename = options.filename ?? ".agent-host-emergency.reserve";
    if (
      basename(filename) !== filename ||
      filename === "." ||
      filename === ".."
    )
      throw new Error("invalid Agent Host reserve filename");
    const bytes = options.bytes ?? LEDGER_PROTECTED_PHYSICAL_BYTES;
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("invalid Agent Host reserve size");
    const uid = options.owner?.uid ?? process.getuid?.();
    const gid = options.owner?.gid ?? process.getgid?.();
    if (
      !Number.isSafeInteger(uid) ||
      uid! < 0 ||
      !Number.isSafeInteger(gid) ||
      gid! < 0
    )
      throw new Error("Agent Host reserve requires an exact owner");
    const directory = lstatSync(stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("unsafe Agent Host generation StateDirectory");
    this.path = join(stateDirectory, filename);
    this.capacityBytes = bytes;
    this.#owner = { uid: uid!, gid: gid! };
    this.#fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      RESERVE_MODE,
    );
    try {
      const stat = fstatSync(this.#fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("unsafe Agent Host emergency reserve");
      fchownSync(this.#fd, this.#owner.uid, this.#owner.gid);
      fchmodSync(this.#fd, RESERVE_MODE);
      if (stat.size > bytes) ftruncateSync(this.#fd, bytes);
      this.#syncDirectory();
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
  }

  snapshot(): EmergencyReserveSnapshot {
    this.#open();
    const stat = fstatSync(this.#fd);
    return {
      path: this.path,
      logicalBytes: stat.size,
      allocatedBytes: Number(stat.blocks) * 512,
      capacityBytes: this.capacityBytes,
    };
  }

  /** Releases at most one reserve capacity, rounded to the filesystem block. */
  consume(requiredBytes: number): number {
    this.#open();
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0)
      throw new Error("invalid Agent Host reserve consumption");
    const before = this.snapshot();
    const fsBlock = Number(statfsSync(this.path).bsize);
    const wanted = Math.ceil(requiredBytes / fsBlock) * fsBlock;
    const released = Math.min(wanted, before.logicalBytes);
    if (released < requiredBytes)
      throw new Error("Agent Host emergency reserve is exhausted");
    ftruncateSync(this.#fd, before.logicalBytes - released);
    fdatasyncSync(this.#fd);
    this.#syncDirectory();
    return released;
  }

  /** Performs one physical allocation pass and fails rather than retrying. */
  replenish(): void {
    this.#open();
    let offset = fstatSync(this.#fd).size;
    while (offset < this.capacityBytes) {
      const length = Math.min(
        ZERO_CHUNK.byteLength,
        this.capacityBytes - offset,
      );
      const written = writeSync(this.#fd, ZERO_CHUNK, 0, length, offset);
      if (written !== length)
        throw new Error("short Agent Host reserve allocation");
      offset += written;
    }
    fdatasyncSync(this.#fd);
    this.#syncDirectory();
    const after = this.snapshot();
    if (
      after.logicalBytes !== this.capacityBytes ||
      after.allocatedBytes < this.capacityBytes
    )
      throw new Error("Agent Host reserve is not physically allocated");
    // Reassert exact metadata after recovery of a pre-existing partial file.
    fchownSync(this.#fd, this.#owner.uid, this.#owner.gid);
    fchmodSync(this.#fd, RESERVE_MODE);
  }

  close(): void {
    if (this.#closed) return;
    closeSync(this.#fd);
    this.#closed = true;
  }

  #syncDirectory(): void {
    const fd = openSync(
      dirname(this.path),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #open(): void {
    if (this.#closed) throw new Error("Agent Host emergency reserve is closed");
  }
}
