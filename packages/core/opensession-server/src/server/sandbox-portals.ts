/** Durable, server-owned snapshot of Sandbox Portal metadata.
 *
 * A volume-mode Sandbox cannot be inspected while sleeping, but the session
 * sidebar must remain useful and must never wake compute merely to render.
 * Keep only presentation metadata here. Live URLs are deliberately discarded
 * from the sleeping view, and reopening requires an explicit wake.
 */
import { readFile } from "fs/promises";
import { statePath } from "./paths";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import type { PreviewService, PreviewStatus } from "./preview";

/** `state` is optional on the wire of this durable store: entries written
 *  before it became a required PreviewService field have none. */
type CachedPortal = Pick<
  PreviewService,
  "name" | "key" | "port" | "description" | "defaultPath" | "managed"
> & { state?: PreviewService["state"] };
type CachedPortalInput = Pick<CachedPortal, "name" | "key" | "port"> &
  Partial<
    Pick<CachedPortal, "description" | "defaultPath" | "managed" | "state">
  >;
type CachedEntry = {
  sessionId: string;
  sandboxId: string;
  services: CachedPortal[];
  updatedAt: string;
};
type Store = { portals: CachedEntry[] };

function storePath(): string {
  return statePath(".opensession-sandbox-portals.json");
}
async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8"));
    return Array.isArray(parsed?.portals)
      ? { portals: parsed.portals }
      : { portals: [] };
  } catch {
    return { portals: [] };
  }
}

// Store changes run one at a time (read, change, write); reads wait for the
// changes queued before them, so a read always sees every earlier write.
let changeTail: Promise<unknown> = Promise.resolve();
function change(mutate: (store: Store) => Store | null): Promise<void> {
  const run = changeTail.then(async () => {
    const next = mutate(await readStore());
    if (next) await writeJsonAtomicAsync(storePath(), next);
  });
  changeTail = run.catch(() => {});
  return run;
}
async function load(): Promise<Store> {
  await changeTail;
  return readStore();
}

function cacheSandboxPortalMetadata(
  sessionId: string,
  sandboxId: string,
  services: CachedPortalInput[],
): Promise<void> {
  const entry: CachedEntry = {
    sessionId,
    sandboxId,
    updatedAt: new Date().toISOString(),
    services: services.map(
      ({ name, key, port, description, defaultPath, state, managed }) => ({
        name,
        key,
        port,
        ...(description ? { description } : {}),
        ...(defaultPath ? { defaultPath } : {}),
        ...(state ? { state } : {}),
        ...(managed ? { managed } : {}),
      }),
    ),
  };
  return change((store) => {
    const index = store.portals.findIndex(
      (item) => item.sessionId === sessionId,
    );
    if (index < 0) store.portals.push(entry);
    else store.portals[index] = entry;
    return store;
  });
}

export function cacheSandboxPortals(
  sessionId: string,
  sandboxId: string,
  services: PreviewService[],
): Promise<void> {
  return cacheSandboxPortalMetadata(sessionId, sandboxId, services);
}

/** Persist supervisor state at each transition, before a later status probe.
 * This keeps newly starting, failed, and stopped Portals visible even when a
 * remote provider cannot currently be inspected. */
export function cacheSandboxPortalRecords(
  sessionId: string,
  sandboxId: string,
  records: CachedPortalInput[],
): Promise<void> {
  return cacheSandboxPortalMetadata(
    sessionId,
    sandboxId,
    records.map((record) => ({ ...record, managed: true })),
  );
}

/** A non-waking status for the sidebar. There is intentionally no live URL. */
export async function sleepingSandboxPortalStatus(
  sessionId: string,
  sandboxId?: string,
): Promise<PreviewStatus | null> {
  const entry = (await load()).portals.find(
    (item) =>
      item.sessionId === sessionId &&
      (!sandboxId || item.sandboxId === sandboxId),
  );
  if (!entry) return null;
  const services: PreviewService[] = entry.services.map((service) => {
    const cached = service.state ?? "stopped";
    return {
      ...service,
      running: false,
      previewUrl: null,
      state: cached === "failed" || cached === "stopped" ? cached : "sleeping",
      pids: [],
    };
  });
  return { services, portalRecipes: [] };
}

/** Find the session that last registered this sandbox service. The caller
 * still verifies the live session and sandbox before restoring authority. */
export async function cachedSandboxPortalOwner(
  sandboxId: string,
  port?: number,
): Promise<string | null> {
  const entry = (await load()).portals.find(
    (item) =>
      item.sandboxId === sandboxId &&
      (port === undefined ||
        item.services.some((service) => service.port === port)),
  );
  return entry?.sessionId ?? null;
}

/** The cached Portal behind a sandbox service port, by name. */
export async function cachedSandboxPortalService(
  sandboxId: string,
  port: number,
): Promise<CachedPortal | null> {
  for (const entry of (await load()).portals) {
    if (entry.sandboxId !== sandboxId) continue;
    const service = entry.services.find((item) => item.port === port);
    if (service) return service;
  }
  return null;
}

export function dropCachedSandboxPortals(sandboxId: string): Promise<void> {
  return change((store) => {
    const portals = store.portals.filter(
      (entry) => entry.sandboxId !== sandboxId,
    );
    return portals.length !== store.portals.length ? { portals } : null;
  });
}
