import type { PrivateActorFence } from "./private-access";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionKernelService } from "./actor-service";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import type { MetadataActorRequest } from "./metadata-protocol";
import { sessionKernelSessionDbPath } from "./store";

const root = mkdtempSync(join(tmpdir(), "metadata-access-worker-"));
const saved = {
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_SESSION_KERNEL_DB_PATH:
    process.env.OPENSESSION_SESSION_KERNEL_DB_PATH,
};
const token = "synthetic-access-worker-token";
let service: Awaited<ReturnType<typeof startSessionKernelService>>;
let epoch: string;
async function rpc(request: KernelActorTransportEnvelope["request"]) {
  const response = await fetch(`${service.url}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: SESSION_KERNEL_TRANSPORT_VERSION,
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      ...(epoch ? { serviceEpoch: epoch } : {}),
      request,
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function metadata(
  request: MetadataActorRequest,
  fence?: PrivateActorFence,
) {
  const result = await rpc({
    t: "call",
    rpcId: crypto.randomUUID(),
    outputBytes: 256 * 1024,
    request: {
      t: "reduce",
      command: {
        kind: "metadata",
        commandId: crypto.randomUUID(),
        request,
        access: {
          principal:
            "principal" in request
              ? request.principal?.githubAccountId
              : undefined,
          fence,
        },
      },
    },
  });
  expect(result.t).toBe("call_result");
  return JSON.parse(result.body);
}
beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = root;
  service = await startSessionKernelService({
    port: 0,
    token,
    workerCount: 2,
    databasePath: join(root, "kernel.sqlite"),
  });
  epoch = (
    await rpc({
      t: "hello",
      rpcId: "hello",
      version: SESSION_KERNEL_ACTOR_VERSION,
    })
  ).serviceEpoch;
});
afterAll(() => {
  service.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("real worker RPC preserves owner predicates without opening a session actor for catalog reads", async () => {
  const principal = { githubAccountId: 101 };
  const doc = JSON.stringify({
    id: "private",
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  await metadata({
    op: "seed_catalog",
    rows: [
      { sessionId: "private", doc, rev: 1, archived: false, lastActivityMs: 1 },
    ],
  });
  const fence = (await metadata({ op: "scope_fence" })).result;
  expect(fence.generation).toBe(1);
  expect(typeof fence.incarnation).toBe("string");
  expect(
    (await metadata({ op: "scope_changes", after: 0, limit: 1 })).result.rows,
  ).toMatchObject([{ id: "private", owner: 101, generation: 1 }]);
  expect(
    (await metadata({ op: "catalog_read", sessionId: "private" })).result,
  ).toEqual({ status: "denied" });
  expect(
    (
      await metadata({
        op: "catalog_get",
        sessionId: "private",
        principal: { githubAccountId: 202 },
      })
    ).result,
  ).toBeNull();
  expect((await metadata({ op: "catalog_count" })).result).toBe(0);
  expect(
    (
      await metadata({
        op: "catalog_page",
        afterSessionId: "",
        limit: 10,
        principal,
      })
    ).result,
  ).toHaveLength(1);
  expect(
    existsSync(
      sessionKernelSessionDbPath(
        "private",
        join(root, "session-kernel-sessions"),
      ),
    ),
  ).toBe(false);
  expect(
    (
      await metadata(
        {
          op: "put",
          sessionId: "private",
          doc,
          principal,
          requestId: "private-seed",
          expectedRev: null,
          rev: 1,
          archived: false,
          lastActivityMs: 1,
        },
        {
          sourceSessionId: "private",
          owner: 101,
          incarnation: fence.incarnation,
          generation: 1,
        },
      )
    ).result,
  ).toMatchObject({ status: "committed", rev: 1 });
  expect(
    (await metadata({ op: "get", sessionId: "private" })).result,
  ).toBeNull();
  expect(
    (
      await metadata({
        op: "get",
        sessionId: "private",
        principal: { githubAccountId: 202 },
      })
    ).result,
  ).toBeNull();
  expect(
    (await metadata({ op: "get", sessionId: "private", principal })).result,
  ).toMatchObject({ sessionId: "private", doc });
  expect(
    (
      await metadata({
        op: "repository_put",
        repositoryId: "private-repo",
        doc,
        expectedRev: null,
        principal,
      })
    ).result,
  ).toEqual({ status: "committed", rev: 1 });
  expect(
    (await metadata({ op: "repository_get", repositoryId: "private-repo" }))
      .result,
  ).toBeNull();
  expect((await metadata({ op: "repository_count", principal })).result).toBe(
    1,
  );
});

test("real worker refuses private queue/core payloads without source fence and rejects late retired scope", async () => {
  const id = "private-payload",
    principal = { githubAccountId: 101 };
  const doc = JSON.stringify({
    id,
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  await metadata({
    op: "seed_catalog",
    rows: [{ sessionId: id, doc, rev: 1, archived: false, lastActivityMs: 1 }],
  });
  const clock = (await metadata({ op: "scope_fence" })).result;
  const row = (await metadata({ op: "scope_lookup", sessionId: id })).result;
  const fence = {
    sourceSessionId: id,
    owner: 101,
    incarnation: clock.incarnation,
    generation: row.generation,
  };
  await metadata(
    {
      op: "put",
      sessionId: id,
      principal,
      doc,
      requestId: "payload-owner",
      expectedRev: null,
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
    fence,
  );
  async function reduce(
    command: import("./lifecycle-protocol").SessionActorReducerCommand,
  ) {
    const result = await rpc({
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: { t: "reduce", command },
    });
    return JSON.parse(result.body);
  }
  const enqueue = {
    kind: "delivery" as const,
    commandId: "queue",
    request: {
      op: "enqueue" as const,
      sessionId: id,
      item: { id: "message", content: "private input" },
    },
  };
  expect(
    await reduce({ ...enqueue, access: { principal: 101 } }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("source fence required"),
  });
  expect(
    await reduce({
      kind: "core",
      commandId: "core",
      access: { principal: 101 },
      request: {
        op: "enqueue_effect",
        sessionId: id,
        kind: "human_ask_deliver",
        payload: { askId: "private-ask", skipUi: false },
        effectKey: "private-effect",
      },
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("source fence required"),
  });
  expect(
    await reduce({
      ...enqueue,
      commandId: "authorized",
      access: { principal: 101, fence },
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("binding unavailable"),
  });
  expect(
    await reduce({
      ...enqueue,
      commandId: "unknown",
      request: { ...enqueue.request, sessionId: "unknown-private-target" },
      access: { principal: 101, fence },
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("fence changed"),
  });
  expect(
    await reduce({
      kind: "core",
      commandId: "delete",
      access: { principal: 101, fence },
      request: { op: "tombstone", sessionId: id },
    }),
  ).toMatchObject({ ok: true });
  expect(
    await reduce({
      ...enqueue,
      commandId: "late",
      access: { principal: 101, fence },
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("fence changed"),
  });
});

test("worker read envelopes retain original producer generation; human reads stay separate", async () => {
  const id = "read-fenced",
    principal = { githubAccountId: 101 };
  const doc = JSON.stringify({
    id,
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  await metadata({
    op: "seed_catalog",
    rows: [{ sessionId: id, doc, rev: 1, archived: false, lastActivityMs: 1 }],
  });
  const clock = (await metadata({ op: "scope_fence" })).result;
  const row = (await metadata({ op: "scope_lookup", sessionId: id })).result;
  const fence = {
    sourceSessionId: id,
    owner: 101,
    incarnation: clock.incarnation,
    generation: row.generation,
  };
  await metadata(
    {
      op: "put",
      sessionId: id,
      principal,
      doc,
      requestId: "read-seed",
      expectedRev: null,
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
    fence,
  );
  const stale = { ...fence, generation: fence.generation - 1 };
  expect(
    await metadata({ op: "get", sessionId: id, principal }, stale),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("fence changed"),
  });
  const raw = async (
    access: { principal: number; fence?: PrivateActorFence },
    sessionId = id,
  ) => {
    const result = await rpc({
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: { t: "store", method: "askSnapshot", args: [sessionId], access },
    });
    return JSON.parse(result.body);
  };
  expect(await raw({ principal: 101, fence: stale })).toMatchObject({
    ok: false,
    error: expect.stringContaining("fence changed"),
  });
  expect(await raw({ principal: 101, fence })).toMatchObject({ ok: true });
  expect(await raw({ principal: 101 })).toMatchObject({ ok: true });
  expect(await metadata({ op: "get", sessionId: id, principal })).toMatchObject(
    { ok: true, result: { doc } },
  );
  const absent = "read-missing-actor";
  await metadata({
    op: "seed_catalog",
    rows: [
      {
        sessionId: absent,
        doc: JSON.stringify({
          id: absent,
          accessScope: { kind: "personal", ownerGithubAccountId: 101 },
        }),
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      },
    ],
  });
  expect(await raw({ principal: 101 }, absent)).toMatchObject({ ok: false });
});

test("raw worker reads refuse replaced, missing and malformed actor ownership", async () => {
  const { Database } = await import("bun:sqlite");
  const id = "raw-owner-replacement",
    principal = { githubAccountId: 101 };
  const doc = JSON.stringify({
    id,
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  await metadata({
    op: "seed_catalog",
    rows: [{ sessionId: id, doc, rev: 1, archived: false, lastActivityMs: 1 }],
  });
  const clock = (await metadata({ op: "scope_fence" })).result;
  const row = (await metadata({ op: "scope_lookup", sessionId: id })).result;
  await metadata(
    {
      op: "put",
      sessionId: id,
      principal,
      doc,
      requestId: "raw-owner-seed",
      expectedRev: null,
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
    {
      sourceSessionId: id,
      owner: 101,
      incarnation: clock.incarnation,
      generation: row.generation,
    },
  );
  const read = async () => {
    const response = await rpc({
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "askSnapshot",
        args: [id],
        access: { principal: 101 },
      },
    });
    return JSON.parse(response.body);
  };
  expect(await read()).toMatchObject({ ok: true });
  // Synthetic fault injection models a restored actor whose catalog was replaced.
  const actor = new Database(
    sessionKernelSessionDbPath(id, join(root, "session-kernel-sessions")),
  );
  try {
    for (const accessScope of [
      { kind: "personal", ownerGithubAccountId: 202 },
      { kind: "shared" },
      { kind: "personal", ownerGithubAccountId: "101" },
      null,
    ]) {
      actor.run("UPDATE session_kernel_metadata SET doc=? WHERE session_id=?", [
        JSON.stringify({ id, accessScope }),
        id,
      ]);
      expect(await read()).toMatchObject({ ok: false });
    }
  } finally {
    actor.close();
  }
});

test("captured worker read envelopes cannot survive physical retirement, logical stop or repository revoke", async () => {
  const { personalRepositoryId } =
    await import("../personal-repository-identity");
  const { personalRunConsumerKey, personalRunLineageKey } =
    await import("../personal-run-identity");
  for (const denial of ["physical", "logical", "repository"] as const) {
    const id = `read-${denial}`,
      principal = { githubAccountId: 101 };
    const descriptor = {
      kind: "personal" as const,
      ownerGithubAccountId: 101,
      appRecordId: `app-${denial}`,
      githubAppId: 501,
      installationId: 601,
      repositoryId: 701,
      repositoryOwnerGithubAccountId: 101,
      accessRevision: 1,
      fullName: "owner/repo",
    };
    const binding = {
      registryId: personalRepositoryId(descriptor),
      descriptor,
    };
    const consumer = {
      runKey: id,
      hostId: `host-${id}`,
      sessionId: id,
      binding,
    };
    const repo = {
      id: binding.registryId,
      accessScope: { kind: "personal", ownerGithubAccountId: 101 },
      personalGithub: descriptor,
      consumerSchema: 1,
      activeConsumers: [consumer],
      blocked: false,
    };
    await metadata({
      op: "repository_put",
      repositoryId: binding.registryId,
      principal,
      doc: JSON.stringify(repo),
      expectedRev: null,
    });
    const doc = JSON.stringify({
      id,
      accessScope: repo.accessScope,
      personalRepo: binding,
    });
    await metadata({
      op: "seed_catalog",
      rows: [
        { sessionId: id, doc, rev: 1, archived: false, lastActivityMs: 1 },
      ],
    });
    const clock = (await metadata({ op: "scope_fence" })).result;
    const row = (await metadata({ op: "scope_lookup", sessionId: id })).result;
    const fence = {
      sourceSessionId: id,
      owner: 101,
      incarnation: clock.incarnation,
      generation: row.generation,
      binding,
      consumer,
    };
    await metadata(
      {
        op: "put",
        sessionId: id,
        principal,
        doc,
        requestId: `seed-${id}`,
        expectedRev: null,
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      },
      fence,
    );
    const envelopes: KernelActorTransportEnvelope["request"][] = [
      {
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "askSnapshot",
          args: [id],
          access: { principal: 101, fence },
        },
      },
      {
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "metadata",
            commandId: crypto.randomUUID(),
            request: { op: "get", sessionId: id, principal },
            access: { principal: 101, fence },
          },
        },
      },
    ];
    for (const envelope of envelopes)
      expect(JSON.parse((await rpc(envelope)).body)).toMatchObject({
        ok: true,
      });
    const queueCall = async (
      request: import("./delivery-protocol").DeliveryActorRequest,
      producer = { ...fence, consumer: undefined } as PrivateActorFence,
    ) => {
      const result = await rpc({
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "delivery",
            commandId: crypto.randomUUID(),
            request,
            access: { principal: 101, fence: producer },
          },
        },
      });
      return JSON.parse(result.body);
    };
    expect(
      await queueCall({
        op: "enqueue",
        sessionId: id,
        item: {
          id: "queued-human",
          content: "accepted",
          privateAdmission: { owner: 202, generation: 999 },
        },
      }),
    ).toMatchObject({ ok: true });
    const accepted = (await queueCall({ op: "snapshot", sessionId: id })).result
      .queued[0];
    for (const field of ["images", "files", "attachments"]) {
      for (const payload of [
        null,
        "malformed",
        ["/media?path=%2Fuploads%2Fprivate.png"],
      ]) {
        const before = (await queueCall({ op: "snapshot", sessionId: id }))
          .result;
        for (const request of [
          {
            op: "enqueue",
            sessionId: id,
            item: { id: "forged-media", [field]: payload },
          },
          {
            op: "set",
            sessionId: id,
            slot: "queued",
            value: [{ ...accepted, [field]: payload }],
          },
          {
            op: "claim_dispatch",
            sessionId: id,
            promptEntryId: "bad",
            items: [{ ...accepted, [field]: payload }],
          },
        ] satisfies import("./delivery-protocol").DeliveryActorRequest[]) {
          expect(await queueCall(request)).toMatchObject({ ok: false });
          expect(
            (await queueCall({ op: "snapshot", sessionId: id })).result,
          ).toEqual(before);
        }
      }
    }
    expect(accepted.privateAdmission).toEqual({
      sourceSessionId: id,
      owner: 101,
      incarnation: clock.incarnation,
      generation: row.generation,
      binding,
    });
    expect(
      await queueCall({
        op: "set",
        sessionId: id,
        slot: "queued",
        value: [
          { ...accepted, content: "edited", privateAdmission: { owner: 202 } },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await queueCall({ op: "snapshot", sessionId: id })).result.queued[0]
        .privateAdmission,
    ).toEqual(accepted.privateAdmission);
    expect(
      await queueCall(
        {
          op: "enqueue",
          sessionId: id,
          item: { id: "model-minted", content: "not a human intent" },
        },
        fence,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot mint queue admission"),
    });
    for (const [method, args] of [
      [
        "setDeliverySlot",
        [
          id,
          "queued",
          [{ id: "raw-forged", privateAdmission: accepted.privateAdmission }],
        ],
      ],
      [
        "prepareSteerDelivery",
        [
          id,
          "raw-forged",
          { runId: id, generation: 1 },
          { id: "raw-forged", privateAdmission: accepted.privateAdmission },
        ],
      ],
      [
        "requeueSteerDeliveries",
        [
          id,
          [{ id: "raw-forged", privateAdmission: accepted.privateAdmission }],
        ],
      ],
      [
        "claimDeliveryDispatch",
        [
          {
            sessionId: id,
            items: [
              { id: "raw-forged", privateAdmission: accepted.privateAdmission },
            ],
            promptEntryId: "raw-claim",
          },
        ],
      ],
      [
        "claimNextDeliveryDispatch",
        [{ sessionId: id, promptEntryId: "raw-next" }],
      ],
    ] as Array<[string, unknown[]]>) {
      const response = await rpc({
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method,
          args,
          access: { principal: 101, fence },
        },
      });
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: expect.stringContaining("stamped delivery reducer"),
      });
    }
    expect(
      (await queueCall({ op: "snapshot", sessionId: id })).result.queued,
    ).toHaveLength(1);
    const { Database } = await import("bun:sqlite");
    const actorDb = new Database(
      sessionKernelSessionDbPath(id, join(root, "session-kernel-sessions")),
    );
    const beforeQueue = (await queueCall({ op: "snapshot", sessionId: id }))
      .result.queued;
    try {
      const stale = {
        ...accepted,
        id: "stale-raced",
        privateAdmission: {
          ...accepted.privateAdmission,
          generation: row.generation - 1,
        },
      };
      for (const mixed of [[stale], [...beforeQueue, stale]]) {
        actorDb.run(
          "UPDATE session_kernel_delivery SET queued=? WHERE session_id=?",
          [JSON.stringify(mixed), id],
        );
        expect(
          await queueCall({
            op: "claim_next_dispatch",
            sessionId: id,
            promptEntryId: "must-not-claim",
          }),
        ).toMatchObject({
          ok: false,
          error: expect.stringContaining(
            "original admission authority changed",
          ),
        });
        expect(
          (await queueCall({ op: "snapshot", sessionId: id })).result.queued,
        ).toEqual(mixed);
      }
    } finally {
      actorDb.run(
        "UPDATE session_kernel_delivery SET queued=? WHERE session_id=?",
        [JSON.stringify(beforeQueue), id],
      );
      actorDb.close();
    }
    const stampedConsumer = {
      ...consumer,
      runKey: `admitted-${id}`,
      hostId: `admitted-host-${id}`,
      sourceAuthority: {
        incarnation: clock.incarnation,
        generation: row.generation,
      },
    };
    const admittedRepo = {
      ...repo,
      activeConsumers: [consumer, stampedConsumer],
    };
    expect(
      await metadata({
        op: "repository_put",
        repositoryId: binding.registryId,
        principal,
        expectedRev: 1,
        doc: JSON.stringify(admittedRepo),
        enrollmentSource: { ...fence, consumer: undefined },
      }),
    ).toMatchObject({ ok: true, result: { status: "committed", rev: 2 } });
    const racedConsumer = {
      ...stampedConsumer,
      runKey: `raced-${id}`,
      hostId: `raced-host-${id}`,
      sourceAuthority: {
        ...stampedConsumer.sourceAuthority,
        generation: row.generation + 1,
      },
    };
    expect(
      await metadata({
        op: "repository_put",
        repositoryId: binding.registryId,
        principal,
        expectedRev: 2,
        doc: JSON.stringify({
          ...admittedRepo,
          activeConsumers: [...admittedRepo.activeConsumers, racedConsumer],
        }),
        enrollmentSource: {
          ...fence,
          consumer: undefined,
          generation: row.generation + 1,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("fence changed"),
    });
    if (denial === "repository") {
      await metadata({
        op: "repository_put",
        repositoryId: binding.registryId,
        principal,
        doc: JSON.stringify({ ...admittedRepo, blocked: true }),
        expectedRev: 2,
      });
    } else {
      const result = await rpc({
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "catalog_document",
            commandId: crypto.randomUUID(),
            request: {
              op: "put",
              namespace:
                denial === "physical"
                  ? "personal_run_retirements_v1"
                  : "personal_run_stop_intents_v1",
              key:
                denial === "physical"
                  ? personalRunConsumerKey(consumer)
                  : personalRunLineageKey(consumer),
              expectedRev: null,
              value: JSON.stringify(consumer),
              requestId: `deny-${id}`,
            },
          },
        },
      });
      expect(JSON.parse(result.body)).toMatchObject({ ok: true });
    }
    for (const envelope of envelopes)
      expect(JSON.parse((await rpc(envelope)).body)).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          denial === "repository" ? "revoked" : "stopped or retired",
        ),
      });
    expect(
      await metadata({ op: "get", sessionId: id, principal }),
    ).toMatchObject({ ok: true, result: { doc } });
  }
});
