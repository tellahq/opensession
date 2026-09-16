import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionKernelStore } from "./session-kernel/store";
import {
  __setSessionKernelStoreForTest,
  sessionDelivery,
} from "./session-kernel/kernel";
import { personalRepositoryId } from "./personal-repository-identity";
import {
  startSessionAudiences,
  currentPrivateActorFence,
} from "./session-audience";
import { currentExecutionAccess } from "./application-access";
import { withPrivateQueueAdmission } from "./private-queue-recovery";
import { stampPrivateQueueRequest } from "./session-kernel/private-queue-admission";
import { restorePersistedQueueState } from "./queue-state";
let store: SessionKernelStore, old: SessionKernelStore | undefined;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  old = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(old);
  store.close();
});
async function setup() {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 101,
    appRecordId: "app",
    githubAppId: 501,
    installationId: 601,
    repositoryId: 701,
    repositoryOwnerGithubAccountId: 101,
    accessRevision: 1,
    fullName: "owner/repo",
  };
  const binding = { registryId: personalRepositoryId(descriptor), descriptor };
  const repo = {
    id: binding.registryId,
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
    personalGithub: descriptor,
    blocked: false,
    consumerSchema: 1,
    activeConsumers: [],
  };
  store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId: binding.registryId,
    doc: JSON.stringify(repo),
    expectedRev: null,
    principal: { githubAccountId: 101 },
  });
  store.seedSessionMetadataCatalog([
    {
      sessionId: "private-queued",
      doc: JSON.stringify({
        id: "private-queued",
        repo: binding.registryId,
        accessScope: repo.accessScope,
        personalRepo: binding,
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
  const stamp = {
    sourceSessionId: "private-queued",
    owner: 101,
    incarnation: store.sessionScopeFence().incarnation,
    generation: store.sessionScopeLookup("private-queued")!.generation,
    binding,
  };
  const request = stampPrivateQueueRequest(
    {
      op: "enqueue",
      sessionId: "private-queued",
      item: {
        id: "accepted-human",
        content: "accepted before restart",
        privateAdmission: { owner: 202 },
      },
    },
    stamp,
    store.deliverySnapshot("private-queued"),
  );
  if (request.op !== "enqueue") throw new Error("bad fixture");
  store.setDeliverySlot("private-queued", "queued", [request.item]);
  store.markDeliveryMigrationComplete();
  await startSessionAudiences();
  return { stamp, binding, repo, item: request.item };
}
test("no-host accepted private queue restores and dispatches with original admission, not a fake consumer", async () => {
  const { stamp, item } = await setup();
  const restored = await restorePersistedQueueState({
    withSessionRestore: async (id, work, items) => {
      await withPrivateQueueAdmission(id, items, work);
      return true;
    },
    sessionExists: () => true,
    journalOwnsPrompt: () => false,
    runOwnsSteers: () => false,
    deliveredUserTexts: () => [],
    effects: false,
  });
  expect(restored.queuedSessionIds).toEqual(["private-queued"]);
  await withPrivateQueueAdmission("private-queued", [item], async () => {
    expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(101);
    expect(currentPrivateActorFence()).toEqual(stamp);
    await sessionDelivery({
      op: "claim_next_dispatch",
      sessionId: "private-queued",
      promptEntryId: "resumed-dispatch",
    });
  });
  expect(store.deliverySnapshot("private-queued").queued).toEqual([]);
  expect(store.deliverySnapshot("private-queued").dispatch).toMatchObject({
    items: [{ id: "accepted-human", privateAdmission: stamp }],
  });
});
test.each([
  "owner",
  "incarnation",
  "generation",
  "revision",
  "revoked",
  "unstamped",
] as const)(
  "queue restore preserves evidence after %s denial",
  async (denial) => {
    const { binding, repo, item } = await setup();
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    if (denial === "owner")
      db.run(
        "UPDATE session_kernel_access_scope SET owner=202 WHERE id='private-queued'",
      );
    if (denial === "incarnation")
      db.run(
        "UPDATE session_kernel_access_clock SET incarnation='new-authority'",
      );
    if (denial === "generation")
      db.run(
        "UPDATE session_kernel_access_scope SET generation=generation+1 WHERE id='private-queued'",
      );
    if (denial === "revoked" || denial === "revision")
      store.repositoryCatalogPut({
        op: "repository_put",
        repositoryId: binding.registryId,
        expectedRev: 1,
        principal: { githubAccountId: 101 },
        doc: JSON.stringify({
          ...repo,
          ...(denial === "revoked"
            ? { blocked: true }
            : {
                personalGithub: { ...repo.personalGithub, accessRevision: 2 },
              }),
        }),
      });
    const items =
      denial === "unstamped"
        ? [{ id: "accepted-human", content: "legacy" }]
        : [item];
    let touched = false;
    await expect(
      withPrivateQueueAdmission("private-queued", items, async () => {
        touched = true;
      }),
    ).rejects.toThrow();
    expect(touched).toBe(false);
    expect(store.deliverySnapshot("private-queued").queued).toEqual([item]);
  },
);

test("fresh same-session execution cannot drain stale or mixed original admissions", async () => {
  const { stamp, item } = await setup();
  const { drainQueue } = await import("./run-session");
  const { promptQueues } = await import("./queue-state");
  const { withSessionExecutionAccess } = await import("./application-access");
  const { withSessionPublication } = await import("./session-audience");
  const stale = {
    ...(item as Record<string, unknown>),
    id: "stale",
    privateAdmission: { ...stamp, generation: stamp.generation - 1 },
  };
  for (const queued of [[stale], [item, stale]]) {
    await promptQueues.set(
      "private-queued",
      queued as import("./queue-state").QueueItem[],
    );
    await expect(
      withSessionExecutionAccess(
        {
          id: "private-queued",
          accessScope: { kind: "personal", ownerGithubAccountId: 101 },
          personalRepo: stamp.binding,
        },
        () =>
          withSessionPublication(
            "private-queued",
            101,
            () => drainQueue("private-queued"),
            { binding: stamp.binding },
          ),
      ),
    ).rejects.toThrow("admission");
    expect(store.deliverySnapshot("private-queued").queued).toEqual(queued);
    expect(store.deliverySnapshot("private-queued").dispatch).toBeUndefined();
  }
});

test("legacy stamped private media stays queued before parsing, claim, steer or interrupt", async () => {
  const { stamp, item } = await setup();
  const { drainQueue, steerQueuedPrompt, interruptQueuedPrompt } =
    await import("./run-session");
  const { promptQueues, steeredReceipts } = await import("./queue-state");
  const { withSessionExecutionAccess } = await import("./application-access");
  const { withSessionPublication } = await import("./session-audience");
  const { spyOn } = await import("bun:test");
  const uploads = await import("./uploads");
  const parse = spyOn(uploads, "parseImageDataUrls");
  const execute = (work: () => Promise<unknown>) =>
    withSessionExecutionAccess(
      {
        id: "private-queued",
        accessScope: { kind: "personal", ownerGithubAccountId: 101 },
        personalRepo: stamp.binding,
      },
      () =>
        withSessionPublication("private-queued", 101, work, {
          binding: stamp.binding,
        }),
    );
  try {
    for (const field of ["images", "files", "attachments"]) {
      for (const payload of [
        null,
        "malformed",
        ["/media?path=%2Fuploads%2Fexisting.png"],
        [null],
      ]) {
        const unsafe = {
          ...(item as Record<string, unknown>),
          [field]: payload,
        };
        // Fault injection simulates an older durable/stamped writer. Production
        // actor enqueue/set reject this payload independently before mutation.
        await promptQueues.set("private-queued", [
          unsafe,
        ] as import("./queue-state").QueueItem[]);
        const before = store.deliverySnapshot("private-queued");
        for (const work of [
          () => drainQueue("private-queued"),
          () => steerQueuedPrompt("private-queued", "accepted-human"),
          () => interruptQueuedPrompt("private-queued", "accepted-human"),
        ]) {
          await expect(execute(work)).rejects.toThrow(
            "attachments are unavailable",
          );
          expect(store.deliverySnapshot("private-queued")).toEqual(before);
          expect(parse).not.toHaveBeenCalled();
        }
        expect(() =>
          stampPrivateQueueRequest(
            {
              op: "claim_next_dispatch",
              sessionId: "private-queued",
              promptEntryId: "denied",
            },
            stamp,
            before,
          ),
        ).toThrow("attachments are unavailable");
        await steeredReceipts.set("private-queued", [
          unsafe,
        ] as import("./queue-state").QueueItem[]);
        const receiptBefore = store.deliverySnapshot("private-queued");
        await expect(
          execute(() =>
            interruptQueuedPrompt("private-queued", "accepted-human"),
          ),
        ).rejects.toThrow("attachments are unavailable");
        expect(store.deliverySnapshot("private-queued")).toEqual(receiptBefore);
        expect(parse).not.toHaveBeenCalled();
        await steeredReceipts.delete("private-queued");
      }
    }
  } finally {
    parse.mockRestore();
  }
});
