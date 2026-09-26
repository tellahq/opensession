/** Opaque workspace-owned secrets.
 *
 * This is deliberately separate from keychain.ts: keychain credentials are
 * person-owned, lendable to agents, and broker-addressable. Workspace secrets
 * are instance configuration. They can only be resolved by server code and
 * are never listed or projected into a run/sandbox.
 */

import { chmodSync, existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

interface WorkspaceSecretRecord {
  id: string;
  purpose: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceSecretStore {
  version: 1;
  secrets: WorkspaceSecretRecord[];
}

function storePath(): string {
  return (
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE ||
    stateDir("workspace-secrets.json")
  );
}

function readStore(): WorkspaceSecretStore {
  try {
    if (!existsSync(storePath())) return { version: 1, secrets: [] };
    const raw = JSON.parse(readFileSync(storePath(), "utf-8"));
    if (!raw || !Array.isArray(raw.secrets)) return { version: 1, secrets: [] };
    return {
      version: 1,
      secrets: raw.secrets.filter(
        (entry: unknown): entry is WorkspaceSecretRecord => {
          const value = entry as WorkspaceSecretRecord;
          return Boolean(
            value?.id && value?.purpose && typeof value?.value === "string",
          );
        },
      ),
    };
  } catch {
    return { version: 1, secrets: [] };
  }
}

function persist(store: WorkspaceSecretStore): void {
  writeJsonAtomic(storePath(), store);
  chmodSync(storePath(), 0o600);
}

export function putWorkspaceSecret(
  purpose: string,
  value: string,
  ref?: string,
): string {
  if (!purpose.trim()) throw new Error("workspace secret purpose is required");
  if (!value) throw new Error("workspace secret is empty");
  const store = readStore();
  const now = new Date().toISOString();
  const id = ref || `wssec-${crypto.randomUUID()}`;
  const existing = store.secrets.find((secret) => secret.id === id);
  if (existing) {
    existing.value = value;
    existing.purpose = purpose.trim();
    existing.updatedAt = now;
  } else {
    store.secrets.push({
      id,
      purpose: purpose.trim(),
      value,
      createdAt: now,
      updatedAt: now,
    });
  }
  persist(store);
  return id;
}

/** resolveWorkspaceSecret for request handlers: never blocks the loop. */
export async function resolveWorkspaceSecretAsync(
  ref: string,
): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf-8"));
    const found = Array.isArray(raw?.secrets)
      ? raw.secrets.find((secret: WorkspaceSecretRecord) => secret?.id === ref)
      : undefined;
    return typeof found?.value === "string" ? found.value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveWorkspaceSecret(ref: string): string | undefined {
  return readStore().secrets.find((secret) => secret.id === ref)?.value;
}

export function deleteWorkspaceSecret(ref: string): boolean {
  const store = readStore();
  const next = store.secrets.filter((secret) => secret.id !== ref);
  if (next.length === store.secrets.length) return false;
  store.secrets = next;
  persist(store);
  return true;
}

export function workspaceSecretExists(ref: string): boolean {
  return readStore().secrets.some((secret) => secret.id === ref);
}
