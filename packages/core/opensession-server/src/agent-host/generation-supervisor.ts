const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type AgentHostGenerationState =
  | "admission-closed"
  | "eligible"
  | "active"
  | "draining"
  | "blocked"
  | "expired";

export interface AgentHostGenerationIdentity {
  readonly hostId: string;
  readonly generation: number;
  readonly incarnation: string;
}

export interface AgentHostGenerationManifest extends AgentHostGenerationIdentity {
  readonly releaseDigest: string;
  readonly protocolDigest: string;
  readonly keyringDigest: string;
  readonly recoveryLedgerId: string;
  readonly bornAtMs: number;
  readonly deadlineMs: number;
}

export interface AgentHostGenerationRecord extends AgentHostGenerationManifest {
  readonly state: AgentHostGenerationState;
  readonly healthy: boolean;
}

export interface AgentHostClock {
  nowMs(): number;
}

/** Persistence must implement the compare-and-swap atomically. */
export interface AgentHostAdmissionStorage {
  read(): Promise<unknown>;
  compareAndSwap(
    expectedRevision: number,
    next: PersistedAdmission,
  ): Promise<boolean>;
}

/** The session/run/turn identity authenticated by the gateway. */
export interface AgentHostTurnFence {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly generation: number;
}

export interface PersistedTurnPin {
  readonly fence: AgentHostTurnFence;
  readonly generation: AgentHostGenerationManifest;
  /** Redundant, explicit rollout fence. It must match generation.releaseDigest. */
  readonly generationDigest: string;
  /** Redundant, explicit rollout epoch. It must match generation.generation. */
  readonly generationEpoch: number;
  readonly pinnedAtMs: number;
}

export interface PersistedTurnPins {
  readonly version: 1;
  readonly revision: number;
  readonly pins: readonly PersistedTurnPin[];
}

/** Persistence must implement compare-and-swap atomically and durably. */
export interface AgentHostTurnPinStorage {
  read(): Promise<unknown>;
  compareAndSwap(
    expectedRevision: number,
    next: PersistedTurnPins,
  ): Promise<boolean>;
}

export interface AgentHostVerifiedTerminalReceipt {
  readonly kind: "terminal";
  readonly receiptId: string;
  readonly pin: PersistedTurnPin;
}

export interface AgentHostVerifiedDeletionReceipt {
  readonly kind: "session-deletion";
  readonly receiptId: string;
  readonly sessionId: string;
  readonly pins: readonly PersistedTurnPin[];
}

/**
 * Authentication authority for opaque durable receipts. Implementations must
 * return canonical verification data from their authoritative store, or false.
 */
export interface AgentHostTurnReceiptVerifier {
  verifyTerminalReceipt(
    receipt: unknown,
    expectedPin: Readonly<PersistedTurnPin>,
  ): Promise<unknown | false>;
  verifySessionDeletionReceipt(
    receipt: unknown,
    expectedSessionId: string,
    expectedPins: readonly Readonly<PersistedTurnPin>[],
  ): Promise<unknown | false>;
}

/** An injected controller. Implementations may use systemd; this module never does. */
export interface AgentHostSystemdController {
  startGeneration(manifest: AgentHostGenerationManifest): Promise<void>;
  stopGeneration(identity: AgentHostGenerationIdentity): Promise<void>;
}

export interface PersistedAdmission {
  readonly version: 1;
  readonly revision: number;
  readonly active: AgentHostGenerationManifest | null;
}

interface MutableGeneration {
  manifest: Readonly<AgentHostGenerationManifest>;
  state: AgentHostGenerationState;
  healthy: boolean;
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validIdentity(value: unknown): value is AgentHostGenerationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.hostId === "string" &&
    TOKEN_RE.test(candidate.hostId) &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation as number) >= 0 &&
    typeof candidate.incarnation === "string" &&
    TOKEN_RE.test(candidate.incarnation)
  );
}

function decodePersisted(value: unknown): PersistedAdmission | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    !own(candidate, "version") ||
    !own(candidate, "revision") ||
    !own(candidate, "active") ||
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  )
    return undefined;
  try {
    return Object.freeze({
      version: 1,
      revision: candidate.revision as number,
      active:
        candidate.active === null
          ? null
          : exactManifest(candidate.active as AgentHostGenerationManifest),
    });
  } catch {
    return undefined;
  }
}

function identityKey(identity: AgentHostGenerationIdentity): string {
  return JSON.stringify([
    identity.hostId,
    identity.generation,
    identity.incarnation,
  ]);
}

function sameIdentity(
  left: AgentHostGenerationIdentity,
  right: AgentHostGenerationIdentity,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.generation === right.generation &&
    left.incarnation === right.incarnation
  );
}

const MANIFEST_KEYS = [
  "hostId",
  "generation",
  "incarnation",
  "releaseDigest",
  "protocolDigest",
  "keyringDigest",
  "recoveryLedgerId",
  "bornAtMs",
  "deadlineMs",
] as const;

function exactManifest(
  manifest: AgentHostGenerationManifest,
): Readonly<AgentHostGenerationManifest> {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== MANIFEST_KEYS.length ||
    !Object.keys(manifest).every((key) =>
      MANIFEST_KEYS.includes(key as (typeof MANIFEST_KEYS)[number]),
    ) ||
    !validIdentity({
      hostId: manifest.hostId,
      generation: manifest.generation,
      incarnation: manifest.incarnation,
    }) ||
    typeof manifest.releaseDigest !== "string" ||
    !DIGEST_RE.test(manifest.releaseDigest) ||
    typeof manifest.protocolDigest !== "string" ||
    !DIGEST_RE.test(manifest.protocolDigest) ||
    typeof manifest.keyringDigest !== "string" ||
    !DIGEST_RE.test(manifest.keyringDigest) ||
    typeof manifest.recoveryLedgerId !== "string" ||
    !TOKEN_RE.test(manifest.recoveryLedgerId) ||
    !isSafeTime(manifest.bornAtMs) ||
    !isSafeTime(manifest.deadlineMs) ||
    manifest.deadlineMs <= manifest.bornAtMs ||
    manifest.deadlineMs - manifest.bornAtMs > DAY_MS
  )
    throw new Error("Invalid Agent Host generation manifest");
  return Object.freeze({ ...manifest });
}

function sameManifest(
  left: AgentHostGenerationManifest,
  right: AgentHostGenerationManifest,
): boolean {
  return MANIFEST_KEYS.every((key) => left[key] === right[key]);
}

const TURN_FENCE_KEYS = ["sessionId", "runId", "turnId", "generation"] as const;
const TURN_FENCE_TOKEN_KEYS = ["sessionId", "runId", "turnId"] as const;

function exactTurnFence(
  value: AgentHostTurnFence,
): Readonly<AgentHostTurnFence> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== TURN_FENCE_KEYS.length ||
    !Object.keys(value).every((key) =>
      TURN_FENCE_KEYS.includes(key as (typeof TURN_FENCE_KEYS)[number]),
    ) ||
    !TURN_FENCE_TOKEN_KEYS.every(
      (key) => typeof value[key] === "string" && TOKEN_RE.test(value[key]),
    ) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  )
    throw new Error("Invalid Agent Host turn fence");
  return Object.freeze({ ...value });
}

function turnFenceKey(fence: AgentHostTurnFence): string {
  return JSON.stringify([
    fence.sessionId,
    fence.runId,
    fence.turnId,
    fence.generation,
  ]);
}

function exactTurnPin(value: PersistedTurnPin): Readonly<PersistedTurnPin> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    ![
      "fence",
      "generation",
      "generationDigest",
      "generationEpoch",
      "pinnedAtMs",
    ].every((key) => own(value, key))
  )
    throw new Error("Invalid persisted Agent Host turn pin");
  const fence = exactTurnFence(value.fence);
  const generation = exactManifest(value.generation);
  if (
    value.generationDigest !== generation.releaseDigest ||
    value.generationEpoch !== generation.generation ||
    !isSafeTime(value.pinnedAtMs) ||
    value.pinnedAtMs < generation.bornAtMs ||
    value.pinnedAtMs >= generation.deadlineMs
  )
    throw new Error("Invalid persisted Agent Host turn pin");
  return Object.freeze({
    fence,
    generation,
    generationDigest: value.generationDigest,
    generationEpoch: value.generationEpoch,
    pinnedAtMs: value.pinnedAtMs,
  });
}

function decodePersistedTurnPins(
  value: unknown,
): PersistedTurnPins | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    !Array.isArray(candidate.pins)
  )
    return;
  try {
    const pins = candidate.pins.map((pin) => exactTurnPin(pin));
    const keys = pins.map((pin) => turnFenceKey(pin.fence));
    if (new Set(keys).size !== keys.length) return;
    return Object.freeze({
      version: 1,
      revision: candidate.revision as number,
      pins: Object.freeze(pins),
    });
  } catch {
    return;
  }
}

function sameTurnFence(
  left: AgentHostTurnFence,
  right: AgentHostTurnFence,
): boolean {
  return TURN_FENCE_KEYS.every((key) => left[key] === right[key]);
}

function sameTurnPin(left: PersistedTurnPin, right: PersistedTurnPin): boolean {
  return (
    sameTurnFence(left.fence, right.fence) &&
    sameManifest(left.generation, right.generation) &&
    left.generationDigest === right.generationDigest &&
    left.generationEpoch === right.generationEpoch &&
    left.pinnedAtMs === right.pinnedAtMs
  );
}

function decodeVerifiedTerminalReceipt(
  value: unknown,
): AgentHostVerifiedTerminalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.kind !== "terminal" ||
    typeof candidate.receiptId !== "string" ||
    !TOKEN_RE.test(candidate.receiptId)
  )
    return;
  try {
    return Object.freeze({
      kind: "terminal",
      receiptId: candidate.receiptId,
      pin: exactTurnPin(candidate.pin as PersistedTurnPin),
    });
  } catch {
    return;
  }
}

function decodeVerifiedDeletionReceipt(
  value: unknown,
): AgentHostVerifiedDeletionReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    candidate.kind !== "session-deletion" ||
    typeof candidate.receiptId !== "string" ||
    !TOKEN_RE.test(candidate.receiptId) ||
    typeof candidate.sessionId !== "string" ||
    !TOKEN_RE.test(candidate.sessionId) ||
    !Array.isArray(candidate.pins)
  )
    return;
  try {
    const pins = candidate.pins.map((pin) => exactTurnPin(pin));
    const keys = pins.map((pin) => turnFenceKey(pin.fence));
    if (new Set(keys).size !== keys.length) return;
    return Object.freeze({
      kind: "session-deletion",
      receiptId: candidate.receiptId,
      sessionId: candidate.sessionId,
      pins: Object.freeze(pins),
    });
  } catch {
    return;
  }
}

function samePinSet(
  left: readonly PersistedTurnPin[],
  right: readonly PersistedTurnPin[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByFence = new Map(
    right.map((pin) => [turnFenceKey(pin.fence), pin] as const),
  );
  return left.every((pin) => {
    const other = rightByFence.get(turnFenceKey(pin.fence));
    return !!other && sameTurnPin(pin, other);
  });
}

/**
 * Import-inert blue/green generation authority. All effects are explicit and
 * injected. A generation's ledger ID is unique, so no two live generations can
 * be writers for the same recovery ledger.
 */
export class AgentHostGenerationSupervisor {
  private readonly generations = new Map<string, MutableGeneration>();
  private readonly ledgerOwners = new Map<string, string>();
  private readonly turnPins = new Map<string, Readonly<PersistedTurnPin>>();
  private activeKey: string | undefined;
  private persistedRevision: number | undefined;
  private pinRevision: number | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: AgentHostClock,
    private readonly storage: AgentHostAdmissionStorage,
    private readonly controller: AgentHostSystemdController,
    private readonly pinStorage: AgentHostTurnPinStorage,
    private readonly receiptVerifier: AgentHostTurnReceiptVerifier,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private expireDue(): void {
    const now = this.clock.nowMs();
    for (const [key, generation] of this.generations) {
      if (
        generation.state !== "expired" &&
        generation.state !== "blocked" &&
        now >= generation.manifest.deadlineMs
      ) {
        const hasPins = [...this.turnPins.values()].some((pin) =>
          sameIdentity(pin.generation, generation.manifest),
        );
        generation.state = hasPins ? "blocked" : "expired";
        generation.healthy = false;
        if (this.activeKey === key) this.activeKey = undefined;
      }
    }
  }

  private getExact(identity: AgentHostGenerationIdentity): MutableGeneration {
    const generation = this.generations.get(identityKey(identity));
    if (!generation || !sameIdentity(generation.manifest, identity))
      throw new Error("Stale Agent Host generation fence");
    this.expireDue();
    if (generation.state === "expired")
      throw new Error("Expired Agent Host generation fence");
    return generation;
  }

  async stage(
    manifestValue: AgentHostGenerationManifest,
  ): Promise<AgentHostGenerationRecord> {
    return this.serialize(async () => {
      const manifest = exactManifest(manifestValue);
      const key = identityKey(manifest);
      if (this.generations.has(key))
        throw new Error("Duplicate Agent Host generation");
      if (
        [...this.generations.values()].some(
          (entry) =>
            entry.manifest.hostId === manifest.hostId &&
            entry.manifest.generation === manifest.generation,
        )
      )
        throw new Error("Agent Host generation incarnation conflict");
      if (this.ledgerOwners.has(manifest.recoveryLedgerId))
        throw new Error("Agent Host recovery ledger already has a writer");
      if (this.clock.nowMs() >= manifest.deadlineMs)
        throw new Error("Cannot stage an expired Agent Host generation");

      await this.controller.startGeneration(manifest);
      this.generations.set(key, {
        manifest,
        state: "admission-closed",
        healthy: false,
      });
      this.ledgerOwners.set(manifest.recoveryLedgerId, key);
      return this.snapshot(key)!;
    });
  }

  markEligible(
    identity: AgentHostGenerationIdentity,
  ): AgentHostGenerationRecord {
    const generation = this.getExact(identity);
    if (
      generation.state !== "admission-closed" &&
      generation.state !== "eligible"
    )
      throw new Error("Agent Host generation cannot become eligible");
    generation.healthy = true;
    generation.state = "eligible";
    return this.snapshot(identityKey(identity))!;
  }

  async closeAdmission(identity: AgentHostGenerationIdentity): Promise<void> {
    return this.serialize(async () => {
      const generation = this.getExact(identity);
      generation.healthy = false;
      const wasActive = generation.state === "active";
      if (generation.state !== "draining" && generation.state !== "blocked")
        generation.state = "admission-closed";
      if (this.activeKey === identityKey(identity)) this.activeKey = undefined;
      if (wasActive) await this.persistActive(null);
    });
  }

  /** Fail closed unless the persisted exact incarnation is locally healthy and eligible. */
  async recoverAdmission(): Promise<AgentHostGenerationRecord | undefined> {
    return this.serialize(async () => {
      this.activeKey = undefined;
      for (const generation of this.generations.values()) {
        if (generation.state === "active")
          generation.state = "admission-closed";
      }
      this.turnPins.clear();
      const [persistedValue, persistedPinsValue] = await Promise.all([
        this.storage.read(),
        this.pinStorage.read(),
      ]);
      const persisted = decodePersisted(persistedValue);
      const persistedPins = decodePersistedTurnPins(persistedPinsValue);
      if (!persisted) {
        this.persistedRevision = undefined;
        throw new Error("Invalid persisted Agent Host admission generation");
      }
      if (!persistedPins) {
        this.pinRevision = undefined;
        throw new Error("Invalid persisted Agent Host turn pins");
      }
      for (const pin of persistedPins.pins) {
        const generation = this.generations.get(identityKey(pin.generation));
        if (!generation || !sameManifest(generation.manifest, pin.generation)) {
          this.pinRevision = undefined;
          throw new Error(
            "Persisted Agent Host turn generation is unavailable",
          );
        }
      }
      for (const pin of persistedPins.pins)
        this.turnPins.set(turnFenceKey(pin.fence), pin);
      this.persistedRevision = persisted.revision;
      this.pinRevision = persistedPins.revision;
      this.expireDue();
      if (!persisted.active) return undefined;
      const key = identityKey(persisted.active);
      const generation = this.generations.get(key);
      if (
        !generation ||
        !sameManifest(generation.manifest, persisted.active) ||
        generation.state !== "eligible" ||
        !generation.healthy
      ) {
        throw new Error(
          "Persisted Agent Host admission generation is unavailable",
        );
      }
      generation.state = "active";
      this.activeKey = key;
      return this.snapshot(key);
    });
  }

  private async persistActive(
    active: AgentHostGenerationManifest | null,
  ): Promise<void> {
    const persisted = decodePersisted(await this.storage.read());
    if (
      !persisted ||
      (this.persistedRevision !== undefined &&
        persisted.revision !== this.persistedRevision)
    ) {
      this.activeKey = undefined;
      throw new Error("Agent Host admission generation raced persistence");
    }
    const next: PersistedAdmission = Object.freeze({
      version: 1,
      revision: persisted.revision + 1,
      active: active ? exactManifest(active) : null,
    });
    if (!(await this.storage.compareAndSwap(persisted.revision, next))) {
      this.activeKey = undefined;
      throw new Error("Agent Host admission generation raced persistence");
    }
    this.persistedRevision = next.revision;
  }

  async promote(
    identity: AgentHostGenerationIdentity,
    options: { rollback?: boolean } = {},
  ): Promise<AgentHostGenerationRecord> {
    return this.serialize(async () => {
      const candidate = this.getExact(identity);
      const key = identityKey(identity);
      if (
        candidate.state !== "eligible" &&
        !(options.rollback && candidate.state === "draining")
      )
        throw new Error("Agent Host generation is not eligible for promotion");
      if (!candidate.healthy)
        throw new Error("Agent Host generation is unhealthy");
      const current = this.activeKey
        ? this.generations.get(this.activeKey)
        : undefined;
      if (options.rollback) {
        if (!current)
          throw new Error("Rollback requires an active Agent Host generation");
        if (
          candidate.manifest.protocolDigest !==
            current.manifest.protocolDigest ||
          candidate.manifest.keyringDigest !== current.manifest.keyringDigest
        )
          throw new Error("Incompatible Agent Host rollback generation");
      }
      await this.persistActive(candidate.manifest);
      if (current && this.activeKey !== key) current.state = "draining";
      candidate.state = "active";
      this.activeKey = key;
      return this.snapshot(key)!;
    });
  }

  /** Durably pins before returning an admission target. */
  async admitNewTurn(
    fenceValue: AgentHostTurnFence,
  ): Promise<AgentHostGenerationRecord> {
    return this.serialize(async () => {
      const fence = exactTurnFence(fenceValue);
      this.expireDue();
      if (!this.activeKey || this.pinRevision === undefined)
        throw new Error("Agent Host admission is closed");
      const generation = this.generations.get(this.activeKey)!;
      if (generation.state !== "active" || !generation.healthy)
        throw new Error("Agent Host admission is closed");

      const persisted = decodePersistedTurnPins(await this.pinStorage.read());
      if (!persisted || persisted.revision !== this.pinRevision)
        throw new Error("Agent Host turn pin raced persistence");
      const fenceKey = turnFenceKey(fence);
      const existing = persisted.pins.find(
        (pin) => turnFenceKey(pin.fence) === fenceKey,
      );
      if (existing) {
        const local = this.generations.get(identityKey(existing.generation));
        if (!local || !sameManifest(local.manifest, existing.generation))
          throw new Error(
            "Persisted Agent Host turn generation is unavailable",
          );
        this.turnPins.set(fenceKey, existing);
        return this.snapshot(identityKey(existing.generation))!;
      }

      const pin = exactTurnPin({
        fence,
        generation: generation.manifest,
        generationDigest: generation.manifest.releaseDigest,
        generationEpoch: generation.manifest.generation,
        pinnedAtMs: this.clock.nowMs(),
      });
      const next: PersistedTurnPins = Object.freeze({
        version: 1,
        revision: persisted.revision + 1,
        pins: Object.freeze([...persisted.pins, pin]),
      });
      if (!(await this.pinStorage.compareAndSwap(persisted.revision, next)))
        throw new Error("Agent Host turn pin raced persistence");
      this.pinRevision = next.revision;
      this.turnPins.set(fenceKey, pin);
      return this.snapshot(this.activeKey)!;
    });
  }

  targetForExistingTurn(
    fenceValue: AgentHostTurnFence,
    generationFence: AgentHostGenerationManifest,
  ): AgentHostGenerationRecord {
    const fence = exactTurnFence(fenceValue);
    const exactGenerationFence = exactManifest(generationFence);
    const pin = this.turnPins.get(turnFenceKey(fence));
    if (!pin || !sameManifest(pin.generation, exactGenerationFence))
      throw new Error("Stale Agent Host generation fence");
    const generation = this.getExact(exactGenerationFence);
    if (!sameManifest(generation.manifest, pin.generation))
      throw new Error("Stale Agent Host generation fence");
    return this.snapshot(identityKey(exactGenerationFence))!;
  }

  async releaseTurn(
    fenceValue: AgentHostTurnFence,
    generationFence: AgentHostGenerationManifest,
    opaqueReceipt: unknown,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const fence = exactTurnFence(fenceValue);
      const fenceKey = turnFenceKey(fence);
      const exactGenerationFence = exactManifest(generationFence);
      const pin = this.turnPins.get(fenceKey);
      if (!pin || !sameManifest(pin.generation, exactGenerationFence))
        return false;
      const verified = decodeVerifiedTerminalReceipt(
        await this.receiptVerifier.verifyTerminalReceipt(opaqueReceipt, pin),
      );
      if (!verified || !sameTurnPin(verified.pin, pin))
        throw new Error("Agent Host terminal receipt verification failed");
      return this.persistPinRemoval(
        (candidate) => turnFenceKey(candidate.fence) === fenceKey,
      );
    });
  }

  async releaseSessionTurns(
    sessionId: string,
    opaqueReceipt: unknown,
  ): Promise<number> {
    return this.serialize(async () => {
      if (!TOKEN_RE.test(sessionId))
        throw new Error("Invalid Agent Host session fence");
      const pins = [...this.turnPins.values()].filter(
        (pin) => pin.fence.sessionId === sessionId,
      );
      if (pins.length === 0) return 0;
      const verified = decodeVerifiedDeletionReceipt(
        await this.receiptVerifier.verifySessionDeletionReceipt(
          opaqueReceipt,
          sessionId,
          pins,
        ),
      );
      if (
        !verified ||
        verified.sessionId !== sessionId ||
        !samePinSet(verified.pins, pins)
      )
        throw new Error("Agent Host deletion receipt verification failed");
      await this.persistPinRemoval(
        (candidate) => candidate.fence.sessionId === sessionId,
      );
      return pins.length;
    });
  }

  private async persistPinRemoval(
    remove: (pin: Readonly<PersistedTurnPin>) => boolean,
  ): Promise<boolean> {
    if (this.pinRevision === undefined)
      throw new Error("Agent Host turn pins have not been recovered");
    const persisted = decodePersistedTurnPins(await this.pinStorage.read());
    if (!persisted || persisted.revision !== this.pinRevision)
      throw new Error("Agent Host turn pin raced persistence");
    const pins = persisted.pins.filter((pin) => !remove(pin));
    if (pins.length === persisted.pins.length) return false;
    const next: PersistedTurnPins = Object.freeze({
      version: 1,
      revision: persisted.revision + 1,
      pins: Object.freeze(pins),
    });
    if (!(await this.pinStorage.compareAndSwap(persisted.revision, next)))
      throw new Error("Agent Host turn pin raced persistence");
    this.pinRevision = next.revision;
    this.turnPins.clear();
    for (const pin of pins) this.turnPins.set(turnFenceKey(pin.fence), pin);
    return true;
  }

  deletionBroadcastTargets(): readonly AgentHostGenerationRecord[] {
    this.expireDue();
    return Object.freeze(
      [...this.generations.entries()]
        .filter(
          ([, generation]) =>
            generation.state === "active" ||
            generation.state === "draining" ||
            generation.state === "blocked",
        )
        .map(([key]) => this.snapshot(key)!),
    );
  }

  async retire(identity: AgentHostGenerationIdentity): Promise<void> {
    return this.serialize(async () => {
      const key = identityKey(identity);
      const generation = this.generations.get(key);
      if (!generation || !sameIdentity(generation.manifest, identity))
        throw new Error("Stale Agent Host generation fence");
      this.expireDue();
      if (
        generation.state === "active" ||
        [...this.turnPins.values()].some((pin) =>
          sameIdentity(pin.generation, generation.manifest),
        )
      )
        throw new Error("Cannot retire an owned Agent Host generation");
      await this.controller.stopGeneration(identity);
      this.generations.delete(key);
      this.ledgerOwners.delete(generation.manifest.recoveryLedgerId);
    });
  }

  snapshot(
    identityOrKey: AgentHostGenerationIdentity | string,
  ): AgentHostGenerationRecord | undefined {
    this.expireDue();
    const generation = this.generations.get(
      typeof identityOrKey === "string"
        ? identityOrKey
        : identityKey(identityOrKey),
    );
    return generation
      ? Object.freeze({
          ...generation.manifest,
          state: generation.state,
          healthy: generation.healthy,
        })
      : undefined;
  }
}
