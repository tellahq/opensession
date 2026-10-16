/** Worker-owned durable credentials. Modes are hygiene, NOT root isolation. */
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersonalBrokerStore, StoredPersonalApp } from "./broker-core";
import { isGithubAccountId } from "../../shared/access-scope";
const MAX_BYTES = 16 * 1024 * 1024;
export async function openTrustedHostStore(
  directory: string,
  coordinator?: import("./repository-coordinator").PersonalRepositoryCoordinator,
): Promise<
  PersonalBrokerStore & {
    assertNoConsumers(): Promise<void>;
    requireCatalogRevocation(): Promise<void>;
    close(): Promise<void>;
  }
> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.mode & 0o077
  )
    throw new Error("Personal store directory permissions invalid");
  const lockPath = join(root, "writer.lock");
  // The kernel releases this advisory lock on crash/worker termination. No
  // stale PID guessing, unlink races, or two writable broker snapshots.
  const lockFile = await open(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const lockStat = await lockFile.stat();
  await lockFile.close();
  if (!lockStat.isFile() || lockStat.mode & 0o077)
    throw new Error("Invalid writer lock");
  const holder = Bun.spawn(
    [
      "/usr/bin/flock",
      "-n",
      lockPath,
      "/bin/sh",
      "-c",
      "printf locked; /bin/cat >/dev/null",
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const reader = holder.stdout.getReader();
  const timer = setTimeout(() => holder.kill(), 5000);
  const ready = await reader.read();
  clearTimeout(timer);
  reader.releaseLock();
  if (ready.done || Buffer.from(ready.value).toString() !== "locked") {
    holder.stdin.end();
    await holder.exited;
    throw new Error("Personal store already owned or lock unavailable");
  }
  const releaseWriter = async () => {
    holder.stdin.end();
    await holder.exited;
  };
  const path = join(root, "connections.json");
  let records = new Map<number, StoredPersonalApp>();
  const lanes = new Map<string, { tail: Promise<void>; size: number }>();
  let closed = false;
  let catalogRequired = false;
  function validateEnvelope(data: any) {
    const catalog = data?.version === 2 && data.admission === "catalog_bound";
    const zero =
      data?.version === 1 &&
      data.admission === "connections_only" &&
      Array.isArray(data.bindings) &&
      data.bindings.length === 0;
    if (
      (!catalog && !zero) ||
      (catalog && !coordinator) ||
      !Array.isArray(data.records) ||
      data.records.length > 500 ||
      Object.keys(data).some(
        (key) =>
          !(
            catalog
              ? ["version", "admission", "records"]
              : ["version", "admission", "bindings", "records"]
          ).includes(key),
      )
    )
      throw new Error("Personal store provenance invalid");
    const allowed = [
      "app",
      "secrets",
      "rev",
      "lifecycle",
      "grant",
      "installation",
      "repositories",
      "accessRevision",
      "cleanupTokens",
      "projectedTokens",
    ];
    for (const record of data.records) {
      if (
        !record ||
        typeof record !== "object" ||
        Object.keys(record).some((key) => !allowed.includes(key)) ||
        (!catalog && record.projectedTokens?.length)
      )
        throw new Error("Unknown personal record bindings");
    }
  }
  async function readEnvelope() {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.mode & 0o077)
        throw new Error("Personal store file invalid");
      const data = JSON.parse(await file.readFile("utf8"));
      validateEnvelope(data);
      return data;
    } finally {
      await file.close();
    }
  }
  async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (closed || holder.exitCode !== null)
      throw new Error("Personal store closed");
    const lane = lanes.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (lane.size >= 16 || (!lanes.has(key) && lanes.size >= 1024))
      throw new Error("Personal store queue full");
    const previous = lane.tail;
    let release!: () => void;
    lane.tail = new Promise<void>((done) => {
      release = done;
    });
    lane.size++;
    lanes.set(key, lane);
    await previous;
    try {
      if (closed || holder.exitCode !== null)
        throw new Error("Personal store closed");
      return await work();
    } finally {
      release();
      if (--lane.size === 0) lanes.delete(key);
    }
  }
  let initialized = false;
  try {
    const data = await readEnvelope();
    initialized = true;
    catalogRequired = data.version === 2;
    const appIds = new Set<number>();
    for (const record of data.records as StoredPersonalApp[]) {
      const owner = record?.app?.ownerGithubAccountId;
      if (
        !isGithubAccountId(owner) ||
        !isGithubAccountId(record.app.githubAppId) ||
        records.has(owner) ||
        appIds.has(record.app.githubAppId) ||
        !Number.isSafeInteger(record.rev) ||
        record.rev < 1 ||
        (record.lifecycle !== "active" && record.lifecycle !== "revoking") ||
        record.app.public !== false ||
        record.app.webhooks !== "disabled" ||
        !record.app.connectionAcknowledgement ||
        record.app.connectionAcknowledgement.ownerGithubAccountId !== owner ||
        (record.grant && record.grant.value.grantedGithubAccountId !== owner)
      )
        throw new Error("Personal store ownership invalid");
      records.set(owner, record);
      appIds.add(record.app.githubAppId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await releaseWriter();
      throw error;
    }
  }
  async function assertStoreCurrent() {
    if (closed || holder.exitCode !== null)
      throw new Error("Personal store closed");
    try {
      const data = await readEnvelope();
      if ((data.version === 2) !== catalogRequired)
        throw new Error("Personal store provenance changed");
      if (!initialized)
        throw new Error("Personal store appeared outside its writer");
    } catch (error) {
      if (!initialized && (error as NodeJS.ErrnoException).code === "ENOENT")
        return;
      throw error;
    }
  }
  async function persist(
    updated: Map<number, StoredPersonalApp>,
    nextCatalog: boolean,
  ) {
    const content = JSON.stringify(
      nextCatalog
        ? {
            version: 2,
            admission: "catalog_bound",
            records: [...updated.values()],
          }
        : {
            version: 1,
            admission: "connections_only",
            bindings: [],
            records: [...updated.values()],
          },
    );
    if (Buffer.byteLength(content) > MAX_BYTES)
      throw new Error("Personal store size limit");
    const temporary = join(root, `.write-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    let promoted = false;
    try {
      await file.writeFile(content);
      await file.sync();
      await file.close();
      await rename(temporary, path);
      promoted = true;
      records = updated;
      catalogRequired = nextCatalog;
      initialized = true;
      const dir = await open(root, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await file.close().catch(() => {});
      if (!promoted) await unlink(temporary).catch(() => {});
    }
  }
  return {
    withLock,
    async assertNoConsumers() {
      await assertStoreCurrent();
      if (catalogRequired)
        throw new Error("Catalog consumers require real revocation");
    },
    requireCatalogRevocation() {
      return withLock("store-commit", async () => {
        await assertStoreCurrent();
        if (!coordinator) throw new Error("Catalog coordinator required");
        if (!catalogRequired) await persist(records, true);
      });
    },
    async read(owner) {
      if (closed || !isGithubAccountId(owner))
        throw new Error("Invalid personal store read");
      await assertStoreCurrent();
      return structuredClone(records.get(owner) ?? null);
    },
    compareAndSet(owner, expected, next) {
      return withLock("store-commit", async () => {
        await assertStoreCurrent();
        if (!isGithubAccountId(owner)) throw new Error("Invalid owner");
        if ((records.get(owner)?.rev ?? null) !== expected) return false;
        if (!catalogRequired && next?.projectedTokens?.length)
          throw new Error("Projection requires catalog provenance");
        const previous = records.get(owner);
        if (
          next &&
          (next.rev !== (expected === null ? 1 : expected + 1) ||
            (previous &&
              (previous.app.recordId !== next.app.recordId ||
                previous.app.githubAppId !== next.app.githubAppId ||
                previous.app.clientId !== next.app.clientId ||
                next.accessRevision < previous.accessRevision)))
        )
          throw new Error("Personal App identity/revision cannot change");
        if (
          next &&
          (next.app.ownerGithubAccountId !== owner ||
            !next.app.connectionAcknowledgement ||
            next.app.connectionAcknowledgement.ownerGithubAccountId !== owner ||
            (next.grant && next.grant.value.grantedGithubAccountId !== owner))
        )
          throw new Error("Invalid stored owner");
        if (
          next &&
          [...records.values()].some(
            (r) =>
              r.app.ownerGithubAccountId !== owner &&
              r.app.githubAppId === next.app.githubAppId,
          )
        )
          return false;
        const updated = new Map(records);
        if (next) updated.set(owner, structuredClone(next));
        else updated.delete(owner);
        if (updated.size > 500) throw new Error("Personal store owner limit");
        await persist(updated, catalogRequired);
        return true;
      });
    },
    async close() {
      if (lanes.size) throw new Error("Personal store is busy");
      closed = true;
      await releaseWriter();
    },
  };
}
