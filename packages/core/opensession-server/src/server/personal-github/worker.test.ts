import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPersonalConnectionWorkerClient,
  installPersonalRepositoryCoordinator,
  personalConnectionClient,
} from "./worker-client";
import { stateContext } from "../paths";
import { PERSONAL_CONNECTION_DISCLOSURE } from "./disclosure";

test("real worker RPC persists no credentials before consent and cannot register or project tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-worker-"));
  const worker = createPersonalConnectionWorkerClient(directory);
  try {
    expect(await worker.call("status", 11)).toMatchObject({
      ok: true,
      status: { runtime: "shared_trusted_host", app: null },
    });
    const context = {
      ownerGithubAccountId: 11,
      origin: "https://demo.example",
      browserSessionId: "synthetic-browser-hash",
    };
    expect(await worker.call("beginManifest", context)).toMatchObject({
      code: "disclosure_required",
    });
    const ack = await worker.call("acknowledgeDisclosure", context, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: true,
    });
    if (!ack.ok) throw new Error(ack.code);
    const manifest = await worker.call(
      "beginManifest",
      context,
      ack.disclosureReceipt,
    );
    expect(manifest.ok).toBe(true);
    // No conversion/device/refresh operation is called, so this real worker
    // never contacts GitHub. The public RPC allowlist excludes these internals.
    for (const method of ["register", "getUserGrant"]) {
      const rejected = await (worker.call as Function)(method, 11, {}).then(
        () => false,
        () => true,
      );
      expect(rejected).toBe(true);
    }
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinator reinstall preserves worker identity and pending disclosure across hot reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-hot-worker-"));
  const saved = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = root;
  const key = JSON.stringify(stateContext());
  const coordinator = {
    async register() {
      return { registryId: "unused" };
    },
    async assertCurrent() {},
    async revoke() {},
    async reconcile() {},
  };
  installPersonalRepositoryCoordinator(coordinator);
  const first = personalConnectionClient();
  try {
    const context = {
      ownerGithubAccountId: 11,
      origin: "https://demo.example",
      browserSessionId: "synthetic-browser",
    };
    const ack = await first.call("acknowledgeDisclosure", context, {
      version: PERSONAL_CONNECTION_DISCLOSURE.version,
      accepted: true,
    });
    if (!ack.ok) throw new Error(ack.code);
    installPersonalRepositoryCoordinator(coordinator);
    installPersonalRepositoryCoordinator({ ...coordinator });
    expect(personalConnectionClient()).toBe(first);
    expect(
      (await first.call("beginManifest", context, ack.disclosureReceipt)).ok,
    ).toBe(true);
  } finally {
    await (first as typeof first & { close(): Promise<void> }).close();
    (
      globalThis as typeof globalThis & {
        __personalGithubClients?: Map<string, unknown>;
      }
    ).__personalGithubClients?.delete(key);
    if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});
