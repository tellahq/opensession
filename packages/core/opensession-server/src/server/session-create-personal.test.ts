import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUIDv7, type ServerWebSocket } from "bun";
import { SessionKernelStore } from "./session-kernel/store";
import * as kernel from "./session-kernel";
import {
  startSessionAudiences,
  revokeSessionPublications,
  sessionPublicationAllowed,
} from "./session-audience";
import {
  currentExecutionAccess,
  withSessionExecutionAccess,
} from "./application-access";
import { reservePersonalSession } from "./personal-session-reservation";
import {
  personalRepositoryId,
  readPersonalRepository,
} from "./personal-repository-coordinator";
import {
  createPersonalRepoRuntime,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import {
  handlePersonalCreateSessionMessage,
  mergeCreatedSessionDefaults,
  openingCreateTrustPolicy,
  openCreatedSession,
  withPersonalOpeningPublication,
  type PersonalCreateDependencies,
  type CreateSessionMessage,
  type ResolvedCreate,
} from "./session-create";
import type { WSClientData } from "./ws-hub";

let store: SessionKernelStore;
let previous: ReturnType<typeof kernel.__setSessionKernelStoreForTest>;
let bindings: PersonalRepoBinding[];
let starts: ResolvedCreate[];
let prepGate: (() => Promise<void>) | undefined;
let denied: boolean;
let deps: PersonalCreateDependencies;
let prepared: string[];
const ownerA = 41,
  ownerB = 42;
function socket(owner?: number, name = "same-name") {
  const frames: Record<string, unknown>[] = [];
  const ws = {
    data: {
      privacyProtocol: "personal-v1",
      expectedGithubAccountId: owner,
      authGithubAccountId: owner,
      authLogin: name,
      authUser: name,
    },
    send: (s: string) => frames.push(JSON.parse(s)),
  } as unknown as ServerWebSocket<WSClientData>;
  return { ws, frames };
}
function message(index = 0): CreateSessionMessage {
  return {
    repo: bindings[index]!.registryId,
    prompt: "private prompt",
    branch: "feature",
    mode: "code",
    model: "claude-fable-5-1",
    requestId: "same-request",
  };
}
beforeEach(async () => {
  store = new SessionKernelStore(":memory:");
  previous = kernel.__setSessionKernelStoreForTest(store);
  starts = [];
  prepared = [];
  denied = false;
  prepGate = undefined;
  bindings = [ownerA, ownerB].map((owner) => {
    const descriptor = {
      kind: "personal" as const,
      ownerGithubAccountId: owner,
      repositoryOwnerGithubAccountId: owner,
      appRecordId: `app-${owner}`,
      githubAppId: owner + 100,
      installationId: owner + 200,
      repositoryId: owner + 300,
      accessRevision: 1,
      fullName: `same-name/repo-${owner}`,
    };
    return { registryId: personalRepositoryId(descriptor), descriptor };
  });
  for (const b of bindings)
    await kernel.sessionMetadata({
      op: "repository_put",
      repositoryId: b.registryId,
      expectedRev: null,
      principal: { githubAccountId: b.descriptor.ownerGithubAccountId },
      doc: JSON.stringify({
        id: b.registryId,
        accessScope: {
          kind: "personal",
          ownerGithubAccountId: b.descriptor.ownerGithubAccountId,
        },
        personalGithub: b.descriptor,
        blocked: false,
        consumerSchema: 1,
        activeConsumers: [],
      }),
    });
  await startSessionAudiences();
  const runtime = createPersonalRepoRuntime({
    root: "/fixture/private-runtime",
    now: () => 1000,
    async readPersonalRepository(owner, id) {
      if (denied) throw new Error("revoked");
      return readPersonalRepository(owner, id);
    },
    async resolveCredential(owner, d, kind) {
      if (denied) throw new Error("revoked");
      return {
        ok: true,
        credential: {
          ownerGithubAccountId: owner,
          appRecordId: d.appRecordId,
          repositoryId: d.repositoryId,
          installationId: d.installationId,
          accessRevision: d.accessRevision,
          fullName: d.fullName,
          kind,
          token: "fixture-token",
          expiresAt: 500_000,
        },
      };
    },
    git: {
      async defaultBranch() {
        return "main";
      },
      async validate() {},
      async prepare(input) {
        prepared.push(input.cwd);
        await prepGate?.();
      },
    },
  });
  deps = {
    ready: async () => {},
    readBinding: readPersonalRepository,
    reserve: reservePersonalSession,
    runtime: async () => runtime,
    replay: async () => false,
    async start(spec, io) {
      starts.push(spec);
      await runtime.assertWorkspace(
        spec.personalRepo!.descriptor.ownerGithubAccountId,
        spec.personalRepo!,
        spec.id,
        spec.wtPath,
      );
      expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(
        spec.personalRepo!.descriptor.ownerGithubAccountId,
      );
      // The consumer, not just a generator's creation, owns publication ALS.
      async function* events() {
        await Promise.resolve();
        yield "private body";
      }
      for await (const body of events()) {
        expect(sessionPublicationAllowed(spec.id)).toBe(true);
        io.emit({ type: "stream_text", text: body });
      }
      io.announce({
        id: spec.id,
        newWorkspace: false,
        preparingWorkspace: false,
        createdBy: spec.createdBy,
        createdAt: spec.createdAt,
      });
    },
  };
});
afterEach(() => {
  kernel.__setSessionKernelStoreForTest(previous);
  store.close();
});

test("real numeric reservation and injected runtime use the actual canonical session id", async () => {
  const s = socket(ownerA);
  const result = await handlePersonalCreateSessionMessage(
    s.ws,
    message(),
    deps,
  );
  expect(result?.type).toBe("session_created");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.id).toBe(String(result!.id));
  expect(starts[0]!.wtPath).toBe(prepared[0]);
  expect(starts[0]!.persistBranch).toBe("feature");
  expect(starts[0]!.personalRepo).toEqual(bindings[0]);
  expect(starts[0]!.runMcpServers).toEqual([]);
  expect(starts[0]!.persistMcpServers).toEqual([]);
  const row = await kernel.sessionMetadata({
    op: "catalog_get",
    sessionId: String(result!.id),
    principal: { githubAccountId: ownerA },
  });
  expect(JSON.parse(row!.doc).accessScope).toEqual({
    kind: "personal",
    ownerGithubAccountId: ownerA,
  });
  expect(JSON.stringify(starts)).not.toContain("fixture-token");
  const persisted = mergeCreatedSessionDefaults(
    starts[0]!,
    JSON.parse(row!.doc),
  );
  expect(persisted.branch).toBe("feature");
  expect(persisted.worktreeDir).toBe(prepared[0]);
  expect(persisted.personalRepo).toEqual(bindings[0]);
  expect(
    (persisted as unknown as Record<string, unknown>).personalCreateIdentity,
  ).toBeDefined();
});

test("same display name/request scopes replay ids by verified numeric owner", async () => {
  const a = await handlePersonalCreateSessionMessage(
    socket(ownerA).ws,
    message(0),
    deps,
  );
  const b = await handlePersonalCreateSessionMessage(
    socket(ownerB).ws,
    message(1),
    deps,
  );
  expect(a?.id).toBeDefined();
  expect(b?.id).toBeDefined();
  expect(a!.id).not.toBe(b!.id);
});

test("cross-owner repository and numeric-looking unverified login cannot create", async () => {
  expect(
    await handlePersonalCreateSessionMessage(
      socket(ownerB).ws,
      message(0),
      deps,
    ),
  ).toBeUndefined();
  expect(
    await handlePersonalCreateSessionMessage(
      socket(undefined, "41").ws,
      message(0),
      deps,
    ),
  ).toBeUndefined();
  expect(starts).toHaveLength(0);
  expect(prepared).toHaveLength(0);
});

test("canonical client id cannot be claimed by another owner", async () => {
  const id = `os-${randomUUIDv7()}`;
  const a = await handlePersonalCreateSessionMessage(
    socket(ownerA).ws,
    { ...message(0), clientSessionId: id },
    deps,
  );
  const b = await handlePersonalCreateSessionMessage(
    socket(ownerB).ws,
    { ...message(1), clientSessionId: id },
    deps,
  );
  expect(a?.id).toBe(id);
  expect(b).toBeUndefined();
  expect(starts).toHaveLength(1);
});

test("replay is stable across a display rename and changed payload cannot adopt it", async () => {
  const a = await handlePersonalCreateSessionMessage(
    socket(ownerA).ws,
    message(),
    deps,
  );
  deps.replay = async () => true;
  const b = await handlePersonalCreateSessionMessage(
    socket(ownerA, "renamed").ws,
    message(),
    deps,
  );
  expect(a?.id).toBe(b?.id);
  const changed = await handlePersonalCreateSessionMessage(
    socket(ownerA).ws,
    { ...message(), prompt: "different" },
    deps,
  );
  expect(changed).toBeUndefined();
  expect(starts).toHaveLength(1);
});

test("unsupported shared/private combinations fail before reservation/preparation", async () => {
  for (const patch of [
    { workspaceId: "shared" },
    { attachRepos: ["shared"] },
    { sandbox: true },
    { runner: "remote" },
    { forkFrom: { sourceId: "other" } },
    { checkoutMode: "shared" },
    { files: [{ name: "x" }] },
  ]) {
    expect(
      await handlePersonalCreateSessionMessage(
        socket(ownerA).ws,
        { ...message(), ...patch },
        deps,
      ),
    ).toBeUndefined();
  }
  expect(starts).toHaveLength(0);
  expect(prepared).toHaveLength(0);
});

test("denied preparation never publishes or launches", async () => {
  prepGate = async () => {
    throw new Error("fixture-sensitive-error");
  };
  const s = socket(ownerA);
  expect(
    await handlePersonalCreateSessionMessage(s.ws, message(), deps),
  ).toBeUndefined();
  expect(starts).toHaveLength(0);
  expect(JSON.stringify(s.frames)).not.toContain("fixture-sensitive-error");
  expect(s.frames.some((f) => f.type === "session_created")).toBe(false);
});

test("revocation during delayed preparation blocks late publication and launch", async () => {
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  prepGate = async () => {
    entered.resolve();
    await gate.promise;
  };
  const s = socket(ownerA);
  const pending = handlePersonalCreateSessionMessage(s.ws, message(), deps);
  await entered.promise;
  denied = true;
  gate.resolve();
  expect(await pending).toBeUndefined();
  expect(starts).toHaveLength(0);
  expect(
    s.frames.some(
      (f) => f.type === "session_created" || f.type === "stream_text",
    ),
  ).toBe(false);
});

test("original publication revocation survives the delayed preparation await", async () => {
  const entered = Promise.withResolvers<string>(),
    gate = Promise.withResolvers<void>();
  deps.reserve = async (input) => {
    const result = await reservePersonalSession(input);
    entered.resolve(input.sessionId);
    return result;
  };
  const preparing = Promise.withResolvers<void>();
  prepGate = async () => {
    preparing.resolve();
    await gate.promise;
  };
  const s = socket(ownerA);
  const pending = handlePersonalCreateSessionMessage(s.ws, message(), deps);
  const id = await entered.promise;
  // Wait for the fake Git boundary, not a timer or live process.
  await preparing.promise;
  revokeSessionPublications([id]);
  gate.resolve();
  expect(await pending).toBeUndefined();
  expect(starts).toHaveLength(0);
});

test("same-owner pending replay joins one preparation without duplicate opening", async () => {
  const entered = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let reservations = 0;
  deps.reserve = async (input) => {
    const value = await reservePersonalSession(input);
    if (++reservations === 2) joined.resolve();
    return value;
  };
  prepGate = async () => {
    entered.resolve();
    await gate.promise;
  };
  const a = socket(ownerA),
    b = socket(ownerA, "renamed");
  const first = handlePersonalCreateSessionMessage(a.ws, message(), deps);
  await entered.promise;
  const second = handlePersonalCreateSessionMessage(b.ws, message(), deps);
  await joined.promise;
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  expect(one?.id).toBe(two?.id);
  expect(prepared).toHaveLength(1);
  expect(starts).toHaveLength(1);
  expect(b.frames.filter((f) => f.type === "session_created")).toHaveLength(1);
});

test("principal replacement during preparation cannot send the old result to the replacement", async () => {
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  prepGate = async () => {
    entered.resolve();
    await gate.promise;
  };
  const s = socket(ownerA);
  const pending = handlePersonalCreateSessionMessage(s.ws, message(), deps);
  await entered.promise;
  s.ws.data.authGithubAccountId = ownerB;
  s.ws.data.expectedGithubAccountId = ownerB;
  gate.resolve();
  expect(await pending).toBeUndefined();
  expect(starts).toHaveLength(0);
  expect(s.frames).toEqual([]);
});

test("unavailable physical readiness fails before reservation or credential work", async () => {
  deps.ready = async () => {
    throw new Error("old helper");
  };
  deps.reserve = async () => {
    throw new Error("must not reserve");
  };
  const s = socket(ownerA);
  expect(
    await handlePersonalCreateSessionMessage(s.ws, message(), deps),
  ).toBeUndefined();
  expect(prepared).toHaveLength(0);
  expect(starts).toHaveLength(0);
});

test("private opening policy never inherits shared MCP or AWS defaults", () => {
  const policy = openingCreateTrustPolicy({
    personalRepo: bindings[0],
    branch: "feature",
    user: "same-name",
    createdByLogin: "same-name",
    runMcpServers: "all",
  });
  expect(policy.mcpServers).toEqual([]);
  expect(policy.mcpGrantUser).toBeUndefined();
  expect(policy.aws).toBe(false);
});

test("explicit nonempty or malformed MCP overrides deny before reservation", async () => {
  let reservations = 0;
  deps.reserve = async () => {
    reservations++;
    throw new Error("must not reserve");
  };
  for (const mcpServers of [["shared-default"], "all", { enabled: true }]) {
    expect(
      await handlePersonalCreateSessionMessage(
        socket(ownerA).ws,
        { ...message(), mcpServers },
        deps,
      ),
    ).toBeUndefined();
  }
  expect(reservations).toBe(0);
  expect(prepared).toHaveLength(0);
});

test("explicit UI host sentinel is accepted without applying a provider default", async () => {
  expect(
    (
      await handlePersonalCreateSessionMessage(
        socket(ownerA).ws,
        { ...message(), sandbox: "local", mcpServers: [] },
        deps,
      )
    )?.type,
  ).toBe("session_created");
  expect(starts[0]?.sandboxProvider).toBeNull();
  expect(starts[0]?.runMcpServers).toEqual([]);
});

test("an unscoped opening effect restores the original lease around generator consumption", async () => {
  const outside = new AsyncResource("unscoped-private-opening-test");
  const originalStart = deps.start;
  deps.start = async (spec, io, identity) => {
    await outside.runInAsyncScope(() =>
      withPersonalOpeningPublication(spec, identity, async () => {
        await originalStart(spec, io, identity);
      }),
    );
  };
  const result = await handlePersonalCreateSessionMessage(
    socket(ownerA).ws,
    message(),
    deps,
  );
  expect(result?.type).toBe("session_created");
  outside.emitDestroy();
});

test("an unscoped late effect cannot renew an expired admission lease", async () => {
  const outside = new AsyncResource("unscoped-private-opening-revoke-test");
  let consumed = false;
  deps.start = async (spec, _io, identity) => {
    revokeSessionPublications([spec.id]);
    await outside.runInAsyncScope(() =>
      withPersonalOpeningPublication(spec, identity, async () => {
        consumed = true;
      }),
    );
  };
  expect(
    await handlePersonalCreateSessionMessage(
      socket(ownerA).ws,
      message(),
      deps,
    ),
  ).toBeUndefined();
  expect(consumed).toBe(false);
  outside.emitDestroy();
});

test("missing private binding cannot downgrade an opening into shared execution", async () => {
  await handlePersonalCreateSessionMessage(socket(ownerA).ws, message(), deps);
  const original = starts[0]!;
  const io = {
    announce() {
      throw new Error("must not announce");
    },
    emit() {
      throw new Error("must not emit");
    },
    fail() {
      throw new Error("must not fail through shared path");
    },
  };
  for (const repoId of [original.repoId, undefined]) {
    await expect(
      openCreatedSession(
        { ...original, personalRepo: undefined, repoId },
        io,
        "irrelevant",
      ),
    ).rejects.toThrow("Private opening binding missing");
  }
});

for (const [label, images] of Object.entries({
  "other owner's staged image": [
    "/media?path=%2Fuploads%2Fother-owner%2Fa.png",
  ],
  "shared staged image": ["/media?path=%2Fuploads%2Fstaged%2Fa.png"],
  "unsafe path": ["/media?path=%2Fetc%2Fpasswd"],
  "missing staged image": ["/media?path=%2Fuploads%2Fmissing.png"],
  "inline image": ["data:image/png;base64,aGVsbG8="],
  "malformed inline": ["data:image/png;base64,"],
  "missing entry": [null],
  "malformed list": "data:image/png;base64,aGVsbG8=",
  "null list": null,
})) {
  test(`private image admission rejects ${label} before all effects`, async () => {
    const s = socket(ownerA);
    const effects: string[] = [];
    const guarded = { ...deps };
    for (const key of [
      "ready",
      "readBinding",
      "reserve",
      "runtime",
      "replay",
      "start",
    ] as const)
      (guarded as any)[key] = async () => {
        effects.push(key);
        throw new Error("unexpected effect");
      };
    await handlePersonalCreateSessionMessage(
      s.ws,
      { ...message(), images } as CreateSessionMessage,
      guarded,
    );
    expect(effects).toEqual([]);
    expect(prepared).toEqual([]);
    expect(starts).toEqual([]);
    expect(s.frames.map((f) => f.type)).toEqual(["error"]);
  });
}

for (const boundary of ["ready", "readBinding"] as const) {
  for (const nextOwner of [ownerB, undefined]) {
    test(`private create fences identity replacement after ${boundary} to ${nextOwner}`, async () => {
      const s = socket(ownerA);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = deps[boundary];
      (deps as any)[boundary] = async (...args: any[]) => {
        reached.resolve();
        await release.promise;
        return (original as any)(...args);
      };
      let reservations = 0;
      const reserve = deps.reserve;
      deps.reserve = async (input) => {
        reservations++;
        return reserve(input);
      };
      const work = handlePersonalCreateSessionMessage(s.ws, message(), deps);
      await reached.promise;
      s.ws.data.authGithubAccountId = nextOwner;
      s.ws.data.expectedGithubAccountId = nextOwner;
      release.resolve();
      expect(await work).toBeUndefined();
      expect(reservations).toBe(0);
      expect(prepared).toEqual([]);
      expect(starts).toEqual([]);
      expect(s.frames).toEqual([]);
    });
  }
}

test("an explicitly empty private image list remains admissible", async () => {
  const s = socket(ownerA);
  const result = await handlePersonalCreateSessionMessage(
    s.ws,
    { ...message(), images: [] },
    deps,
  );
  expect(result?.type).toBe("session_created");
  expect(starts[0]?.images).toBeUndefined();
});

for (const nextOwner of [ownerB, undefined]) {
  test(`identity replacement during reservation to ${nextOwner} cannot launch or publish`, async () => {
    const s = socket(ownerA);
    const reserve = deps.reserve;
    deps.reserve = async (input) => {
      const result = await reserve(input);
      s.ws.data.authGithubAccountId = nextOwner;
      s.ws.data.expectedGithubAccountId = nextOwner;
      return result;
    };
    expect(
      await handlePersonalCreateSessionMessage(s.ws, message(), deps),
    ).toBeUndefined();
    expect(prepared).toEqual([]);
    expect(starts).toEqual([]);
    expect(s.frames).toEqual([]);
  });
}

test("private opening ask adopts the actor's committed answer without shared boot restoration", async () => {
  const { makeAskHandler, pendingAskTimers } = await import("./asks");
  const question = {
    header: "Choice",
    question: "Which option?",
    options: [{ label: "One" }, { label: "Two" }],
  };
  const s = socket(ownerA);
  const originalStart = deps.start;
  let answer: unknown;
  deps.start = async (spec, io, identity) => {
    expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(ownerA);
    await (
      await import("./run-state")
    ).transitionRunState(spec.id, "run_registered", {
      run_key: "private-ask-fixture",
    });
    store.markAskMigrationComplete();
    store.setAskRecord(spec.id, {
      questionId: "private-opening-question",
      durable: true,
      questions: [question],
      askedAt: 1,
    });
    expect(
      await kernel.sessionAsk({
        op: "answer",
        sessionId: spec.id,
        questionId: "private-opening-question",
        answers: { "Which option?": "One" },
        answeredVia: "private-opening-answer",
      }),
    ).toEqual({ matched: true });
    // No restorePendingAsks call: the live private callback adopts actor state.
    answer = await makeAskHandler(spec.id)({ questions: [question] });
    expect(pendingAskTimers.has(spec.id)).toBe(false);
    expect(store.askSnapshot(spec.id)).toMatchObject({
      questionId: "private-opening-question",
      answer: { requestId: "private-opening-answer" },
    });
    await originalStart(spec, io, identity);
  };
  const result = await handlePersonalCreateSessionMessage(
    s.ws,
    message(),
    deps,
  );
  expect(result?.type).toBe("session_created");
  expect(answer).toEqual({
    behavior: "allow",
    updatedInput: {
      questions: [question],
      answers: { "Which option?": "One" },
    },
  });
});

for (const revoke of [false, true, "during-write"] as const) {
  test(`private opening answer restores its original source across a different caller${revoke ? ` and denies after revocation (${revoke})` : ""}`, async () => {
    const { makeAskHandler, pendingAsks, pendingAskTimers } =
      await import("./asks");
    const outside = new AsyncResource("different-ask-caller");
    const question = {
      header: "Choice",
      question: "Which option?",
      options: [{ label: "One" }],
    };
    const originalStart = deps.start;
    let checked = false;
    deps.start = async (spec, io, identity) => {
      await (
        await import("./run-state")
      ).transitionRunState(spec.id, "run_registered", {
        run_key: "private-ask-fixture",
      });
      const ready = Promise.withResolvers<void>();
      const originalSet = pendingAsks.set.bind(pendingAsks);
      pendingAsks.set = async (id, value) => {
        const result = await originalSet(id, value);
        if (id === spec.id) ready.resolve();
        return result;
      };
      let resolved = false;
      let ask: ReturnType<ReturnType<typeof makeAskHandler>>;
      try {
        ask = makeAskHandler(spec.id)({ questions: [question] });
        void ask.then(
          () => {
            resolved = true;
          },
          () => {},
        );
        await ready.promise;
      } finally {
        pendingAsks.set = originalSet;
      }
      const pending = await pendingAsks.getAsync(spec.id);
      expect(pending?.resolve).toBeFunction();
      expect(pendingAskTimers.has(spec.id)).toBe(false);
      const before = store.askSnapshot(spec.id);
      if (revoke === true) revokeSessionPublications([spec.id]);
      const answerFromOtherCaller = () =>
        outside.runInAsyncScope(() =>
          withSessionExecutionAccess(
            {
              id: "other-caller",
              accessScope: { kind: "personal", ownerGithubAccountId: ownerB },
              personalRepo: bindings[1],
            },
            async () => {
              expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(
                ownerB,
              );
              await pending!.resolve({ "Which option?": "One" });
              expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(
                ownerB,
              );
            },
          ),
        );
      if (revoke === "during-write") {
        const written = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        pendingAsks.set = async (id, value) => {
          const result = await originalSet(id, value);
          if (id === spec.id && value.answerReceived) {
            written.resolve();
            await release.promise;
          }
          return result;
        };
        try {
          const finishing = answerFromOtherCaller();
          void finishing.catch(() => {});
          await written.promise;
          // The receipt committed while A was live. Retain that evidence, but
          // do not resolve or publish after A is revoked during the await.
          const committed = store.askSnapshot(spec.id);
          expect(committed).toMatchObject({ answerReceived: true });
          revokeSessionPublications([spec.id]);
          release.resolve();
          await expect(finishing).rejects.toThrow();
          await expect(ask!).rejects.toThrow();
          expect(store.askSnapshot(spec.id)).toEqual(committed);
          expect(resolved).toBe(false);
        } finally {
          release.resolve();
          pendingAsks.set = originalSet;
        }
      } else if (revoke) {
        await expect(answerFromOtherCaller()).rejects.toThrow();
        await expect(ask!).rejects.toThrow();
        expect(store.askSnapshot(spec.id)).toEqual(before);
        expect(resolved).toBe(false);
      } else {
        await answerFromOtherCaller();
        expect(await ask!).toEqual({
          behavior: "allow",
          updatedInput: {
            questions: [question],
            answers: { "Which option?": "One" },
          },
        });
        expect(store.askSnapshot(spec.id)).toMatchObject({
          answerReceived: true,
          earlyAnswer: { "Which option?": "One" },
        });
        await originalStart(spec, io, identity);
      }
      checked = true;
    };
    const s = socket(ownerA);
    await handlePersonalCreateSessionMessage(
      s.ws,
      { ...message(), requestId: `ask-source-${revoke}` },
      deps,
    );
    expect(checked).toBe(true);
  });
}

test("restored private opening cannot inherit shared attachment paths", async () => {
  await handlePersonalCreateSessionMessage(socket(ownerA).ws, message(), deps);
  const original = starts[0]!;
  const effects: string[] = [];
  const io = {
    announce() {
      effects.push("announce");
    },
    emit() {
      effects.push("emit");
    },
    fail() {
      effects.push("fail");
    },
  };
  for (const attachments of [
    null,
    "malformed",
    [{ name: "private", path: "/unavailable/shared-upload" }],
  ]) {
    await expect(
      openCreatedSession(
        { ...original, attachments } as typeof original,
        io,
        "irrelevant",
      ),
    ).rejects.toThrow("File attachments are unavailable");
    expect(effects).toEqual([]);
  }
});
