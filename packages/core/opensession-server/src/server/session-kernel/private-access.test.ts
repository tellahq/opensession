import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStore } from "./store";
import { personalRepositoryId } from "../personal-repository-identity";
import {
  personalRunConsumerKey,
  personalRunLineageKey,
} from "../personal-run-identity";
import type { PrivateActorFence } from "./private-access";
function fixture(path = ":memory:", owner = 101) {
  const store = new SessionKernelStore(path);
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: owner,
    appRecordId: "app",
    githubAppId: 501,
    installationId: 601,
    repositoryId: 701,
    repositoryOwnerGithubAccountId: owner,
    accessRevision: 1,
    fullName: "owner/repo",
  };
  const binding = { registryId: personalRepositoryId(descriptor), descriptor };
  const a = {
      runKey: "logical",
      hostId: "physical-a",
      sessionId: "private",
      binding,
    },
    b = { ...a, hostId: "physical-b" };
  const doc = {
    id: binding.registryId,
    accessScope: { kind: "personal", ownerGithubAccountId: owner },
    personalGithub: descriptor,
    consumerSchema: 1,
    activeConsumers: [a, b],
    blocked: false,
  };
  store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId: binding.registryId,
    doc: JSON.stringify(doc),
    expectedRev: null,
    principal: { githubAccountId: owner },
  });
  store.seedSessionMetadataCatalog([
    {
      sessionId: "private",
      doc: JSON.stringify({
        id: "private",
        accessScope: doc.accessScope,
        personalRepo: binding,
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 0,
    },
  ]);
  const row = store.sessionScopeLookup("private")!;
  const fence: PrivateActorFence = {
    sourceSessionId: "private",
    owner,
    incarnation: store.sessionScopeFence().incarnation,
    generation: row.generation,
    binding,
    consumer: a,
  };
  return { store, doc, binding, a, b, fence };
}
test("dispatch-time permission cannot authorize a later revoked commit", () => {
  const f = fixture();
  let committed = 0;
  try {
    f.store.withPrivateActorFence(f.fence, "private", () => committed++);
    const row = f.store.repositoryCatalogGet(f.binding.registryId, {
      githubAccountId: 101,
    })!;
    f.store.repositoryCatalogPut({
      op: "repository_put",
      repositoryId: row.repositoryId,
      principal: { githubAccountId: 101 },
      expectedRev: row.rev,
      doc: JSON.stringify({ ...f.doc, blocked: true }),
    });
    expect(() =>
      f.store.withPrivateActorFence(f.fence, "private", () => committed++),
    ).toThrow("revoked");
    expect(committed).toBe(1);
  } finally {
    f.store.close();
  }
});
test("owner/incarnation replacement, deleted and unknown resources reject captured readers/writers", () => {
  const old = fixture(),
    same = fixture(),
    other = fixture(":memory:", 202);
  try {
    let touched = false;
    expect(() =>
      same.store.withPrivateActorFence(old.fence, "private", () => {
        touched = true;
      }),
    ).toThrow("fence changed");
    expect(() =>
      other.store.withPrivateActorRead(101, "private", () => {
        touched = true;
      }),
    ).toThrow("authority changed");
    expect(() =>
      same.store.withPrivateActorRead(101, "missing", () => {
        touched = true;
      }),
    ).toThrow();
    same.store.tombstoneSessionScope("private");
    expect(() =>
      same.store.withPrivateActorRead(101, "private", () => {
        touched = true;
      }),
    ).toThrow();
    expect(() =>
      same.store.withPrivateActorFence(same.fence, "private", () => {
        touched = true;
      }),
    ).toThrow();
    expect(touched).toBe(false);
  } finally {
    old.store.close();
    same.store.close();
    other.store.close();
  }
});
test("physical A confirmation rejects A but valid B commits; logical stop denies both", () => {
  const f = fixture();
  let writes = 0;
  try {
    f.store.putCatalogDocument({
      op: "put",
      namespace: "personal_run_retirements_v1",
      key: personalRunConsumerKey(f.a),
      expectedRev: null,
      value: JSON.stringify(f.a),
      requestId: "confirm-a",
    });
    expect(() =>
      f.store.withPrivateActorFence(f.fence, "private", () => writes++),
    ).toThrow("retired");
    f.store.withPrivateActorFence(
      { ...f.fence, consumer: f.b },
      "private",
      () => writes++,
    );
    expect(writes).toBe(1);
    f.store.putCatalogDocument({
      op: "put",
      namespace: "personal_run_stop_intents_v1",
      key: personalRunLineageKey(f.a),
      expectedRev: null,
      value: JSON.stringify(f.a),
      requestId: "stop-lineage",
    });
    expect(() =>
      f.store.withPrivateActorFence(
        { ...f.fence, consumer: f.b },
        "private",
        () => writes++,
      ),
    ).toThrow("stopped");
    expect(writes).toBe(1);
  } finally {
    f.store.close();
  }
});
test("central writer exclusion covers the actual separate actor commit", () => {
  const root = mkdtempSync(join(tmpdir(), "private-commit-fence-"));
  const path = join(root, "catalog.sqlite"),
    f = fixture(path);
  const rival = new Database(path);
  rival.exec("PRAGMA busy_timeout=0");
  const actor = new Database(join(root, "actor.sqlite"));
  actor.exec("CREATE TABLE payload(value TEXT)");
  try {
    f.store.withPrivateActorFence(f.fence, "private", () => {
      expect(() =>
        rival.exec(
          "UPDATE session_kernel_repository_catalog SET doc=json_set(doc,'$.blocked',json('true'))",
        ),
      ).toThrow();
      actor
        .transaction(() =>
          actor.run("INSERT INTO payload VALUES (?)", ["owned A bytes"]),
        )
        .immediate();
    });
    expect(actor.query("SELECT count(*) AS n FROM payload").get()).toEqual({
      n: 1,
    });
    rival.exec(
      "UPDATE session_kernel_repository_catalog SET doc=json_set(doc,'$.blocked',json('true'))",
    );
    expect(() =>
      f.store.withPrivateActorFence(f.fence, "private", () =>
        actor.run("INSERT INTO payload VALUES ('late')"),
      ),
    ).toThrow();
    expect(actor.query("SELECT count(*) AS n FROM payload").get()).toEqual({
      n: 1,
    });
  } finally {
    actor.close();
    rival.close();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("global pending-steer recovery leaves private receipt authority untouched", () => {
  const f = fixture();
  try {
    f.store.setDeliverySlot("private", "queued", [
      { id: "queued", content: "private queued" },
    ]);
    // A synthetic persisted transport-acceptance gap from before restart.
    const db = (f.store as unknown as { db: Database }).db;
    db.run(
      "UPDATE session_kernel_delivery SET pending_steers=? WHERE session_id=?",
      [
        JSON.stringify([
          { item: { id: "pending", content: "private steer" }, preparedAt: 1 },
        ]),
        "private",
      ],
    );
    expect(f.store.settlePendingSteers()).toBe(0);
    expect(f.store.deliverySnapshot("private").pendingSteers).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
