import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type CooldownRecord =
  | {
      readonly scope: "account";
      readonly accountId: string;
      readonly reason: "exhausted" | "wedged";
      readonly until: number;
    }
  | {
      readonly scope: "model";
      readonly accountId: string;
      readonly model: string;
      readonly reason: "exhausted";
      readonly until: number;
    };

export interface CooldownRepository {
  load(): Promise<readonly CooldownRecord[]>;
  save(records: readonly CooldownRecord[]): Promise<void>;
}

export class MemoryCooldownRepository implements CooldownRepository {
  #records: CooldownRecord[];

  constructor(records: readonly CooldownRecord[] = []) {
    this.#records = [...records];
  }

  async load(): Promise<readonly CooldownRecord[]> {
    return [...this.#records];
  }

  async save(records: readonly CooldownRecord[]): Promise<void> {
    this.#records = [...records];
  }
}

function isCooldownRecord(value: unknown): value is CooldownRecord {
  if (!value || typeof value !== "object") return false;
  if (!("scope" in value) || !("accountId" in value)) return false;
  if (!("reason" in value) || !("until" in value)) return false;
  if (typeof value.accountId !== "string" || !value.accountId) return false;
  if (typeof value.until !== "number" || !Number.isFinite(value.until)) {
    return false;
  }
  if (value.scope === "account") {
    return value.reason === "exhausted" || value.reason === "wedged";
  }
  return (
    value.scope === "model" &&
    value.reason === "exhausted" &&
    "model" in value &&
    typeof value.model === "string" &&
    !!value.model
  );
}

export class JsonCooldownRepository implements CooldownRepository {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<readonly CooldownRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every(isCooldownRecord)) {
      throw new Error(`Invalid cooldown store at ${this.#path}`);
    }
    return parsed;
  }

  async save(records: readonly CooldownRecord[]): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(records, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
