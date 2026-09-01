import type {
  CooldownRecord,
  CooldownRepository,
} from "../storage/cooldown-repository";

export interface WedgeCooldownToken {
  readonly accountId: string;
  readonly until: number;
  readonly previous?: Extract<CooldownRecord, { scope: "account" }>;
}

function recordKey(record: CooldownRecord): string {
  return record.scope === "account"
    ? `account\0${record.accountId}`
    : `model\0${record.accountId}\0${record.model}`;
}

export class CooldownRegistry {
  readonly #repository: CooldownRepository;
  readonly #clock: () => number;
  readonly #records = new Map<string, CooldownRecord>();
  #saveTail: Promise<void> = Promise.resolve();

  private constructor(
    repository: CooldownRepository,
    clock: () => number,
    records: readonly CooldownRecord[],
  ) {
    this.#repository = repository;
    this.#clock = clock;
    const now = clock();
    for (const record of records) {
      if (record.until > now) this.#records.set(recordKey(record), record);
    }
  }

  static async open(
    repository: CooldownRepository,
    clock: () => number = Date.now,
  ): Promise<CooldownRegistry> {
    return new CooldownRegistry(repository, clock, await repository.load());
  }

  isActive(accountId: string, model?: string): boolean {
    return (
      this.#activeRecord(`account\0${accountId}`) !== undefined ||
      (model
        ? this.#activeRecord(`model\0${accountId}\0${model}`) !== undefined
        : false)
    );
  }

  async markExhausted(input: {
    readonly accountId: string;
    readonly until: number;
    readonly model?: string;
  }): Promise<void> {
    const record: CooldownRecord = input.model
      ? {
          scope: "model",
          accountId: input.accountId,
          model: input.model,
          reason: "exhausted",
          until: input.until,
        }
      : {
          scope: "account",
          accountId: input.accountId,
          reason: "exhausted",
          until: input.until,
        };
    const key = recordKey(record);
    const current = this.#activeRecord(key);
    if (current && current.until >= record.until) {
      if (current.reason === "exhausted") return;
      this.#records.set(key, { ...record, until: current.until });
    } else {
      this.#records.set(key, record);
    }
    await this.#persist();
  }

  async markWedged(
    accountId: string,
    durationMs: number,
  ): Promise<WedgeCooldownToken | undefined> {
    const until = this.#clock() + durationMs;
    const key = `account\0${accountId}`;
    const current = this.#activeRecord(key);
    if (current && current.until >= until) return undefined;
    this.#records.set(key, {
      scope: "account",
      accountId,
      reason: "wedged",
      until,
    });
    await this.#persist();
    return {
      accountId,
      until,
      ...(current?.scope === "account" ? { previous: current } : {}),
    };
  }

  async clearWedge(token: WedgeCooldownToken): Promise<boolean> {
    const key = `account\0${token.accountId}`;
    const current = this.#activeRecord(key);
    if (
      !current ||
      current.scope !== "account" ||
      current.reason !== "wedged" ||
      current.until !== token.until
    ) {
      return false;
    }
    if (token.previous && token.previous.until > this.#clock()) {
      this.#records.set(key, token.previous);
    } else {
      this.#records.delete(key);
    }
    await this.#persist();
    return true;
  }

  activeRecords(): readonly CooldownRecord[] {
    for (const key of this.#records.keys()) this.#activeRecord(key);
    return [...this.#records.values()];
  }

  #activeRecord(key: string): CooldownRecord | undefined {
    const record = this.#records.get(key);
    if (!record) return undefined;
    if (record.until > this.#clock()) return record;
    this.#records.delete(key);
    return undefined;
  }

  async #persist(): Promise<void> {
    const snapshot = [...this.#records.values()];
    const save = this.#saveTail.then(() => this.#repository.save(snapshot));
    this.#saveTail = save.catch(() => undefined);
    await save;
  }
}
