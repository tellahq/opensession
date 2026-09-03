import { describe, expect, test } from "bun:test";
import {
  isCreationEffectPendingError,
  patchCreationSetupPlan,
  requestCreationAttachment,
  requestCreationBranch,
  requestCreationCredential,
  requestCreationOpening,
  requestCreationSandbox,
  requestCreationWorkspace,
  settleCreationCancelled,
  settleCreationFailed,
} from "./creation-intents";
import { SessionKernelStore, type CreationEventDecision } from "./store";

function harness(sessionId: string) {
  const store = new SessionKernelStore(":memory:");
  return {
    store,
    kernel: {
      creationState: () => store.creationState(sessionId),
      applyCreationEvent: (input: Omit<CreationEventDecision, "sessionId">) =>
        store.applyCreationEvent({ ...input, sessionId }),
    },
  };
}

const input = {
  sessionId: "create-intent",
  identity: "request-intent",
  workspaceId: "ws-create-intent",
  dedupeKey: "session-create:request-intent",
  name: "Creation intent",
  createdBy: "Alice",
  project: "opensession",
  branch: "feature/intent",
  worktreeDir: "/worktrees/intent",
};

const branchInput = {
  sessionId: "create-branch-intent",
  identity: "request-branch-intent",
  project: "opensession",
  branch: "feature/branch-intent",
  worktreePath: "/worktrees/branch-intent",
  baseBranch: "main",
  isolated: true,
  credentialPrincipal: "user:alice",
};

describe("creation setup plan", () => {
  test("persists write-once setup decisions in the actor", async () => {
    const sessionId = "create-setup-plan";
    const identity = "create-setup-request";
    const { store, kernel } = harness(sessionId);
    try {
      expect(
        await patchCreationSetupPlan(
          sessionId,
          identity,
          { branch: "feature/stable" },
          kernel,
        ),
      ).toEqual({ branch: "feature/stable" });
      expect(
        await patchCreationSetupPlan(
          sessionId,
          identity,
          { workspaceId: "ws-stable" },
          kernel,
        ),
      ).toEqual({ branch: "feature/stable", workspaceId: "ws-stable" });
      await expect(
        patchCreationSetupPlan(
          sessionId,
          identity,
          { branch: "feature-crossover" },
          kernel,
        ),
      ).rejects.toThrow("setup_plan_conflict");
      expect(store.creationState(sessionId)?.setupPlan).toEqual({
        branch: "feature/stable",
        workspaceId: "ws-stable",
      });
      expect(
        store.applyCreationEvent({
          sessionId,
          identity,
          event: "plan",
          planPatch: { resolved: { gitEnv: { GH_TOKEN: "secret" } } },
        }),
      ).toMatchObject({ accepted: false, reason: "invalid_setup_plan" });
    } finally {
      store.close();
    }
  });
});

describe("creation lifecycle intents", () => {
  test("records terminal setup failure without launching an opening", async () => {
    const { store, kernel } = harness("create-failed-lifecycle");
    try {
      const failed = await settleCreationFailed(
        "create-failed-lifecycle",
        "request-failed",
        new Error("workspace refused"),
        kernel,
      );
      expect(failed.state).toBe("failed");
      expect(
        (
          await settleCreationFailed(
            "create-failed-lifecycle",
            "request-failed",
            "duplicate",
            kernel,
          )
        ).state,
      ).toBe("failed");
    } finally {
      store.close();
    }
  });
});

describe("creation attachment intents", () => {
  test("emits one source-ref effect and waits for its durable receipt", async () => {
    const attachment = {
      sessionId: "create-attachment-intent",
      identity: "request-attachment-intent",
      attachmentId: "attachment-one",
      name: "brief.pdf",
      sourceRef: "uploads:staged%2Fbrief.pdf",
      digest: "sha256:brief",
    };
    const { store, kernel } = harness(attachment.sessionId);
    try {
      const pending = requestCreationAttachment(attachment, {
        kernel,
        timeoutMs: 1_000,
        pollMs: 5,
      });
      await Bun.sleep(5);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_attachment_stage",
          effectKey: "attachment:attachment-one",
          payload: {
            creationIdentity: attachment.identity,
            creationGeneration: 1,
            attachmentId: "attachment-one",
            name: "brief.pdf",
            sourceRef: "uploads:staged%2Fbrief.pdf",
            digest: "sha256:brief",
            mode: "reconcile_or_stage",
          },
        },
      ]);
      expect(
        store.applyCreationEvent({
          sessionId: attachment.sessionId,
          identity: attachment.identity,
          event: "preparation_started",
          effectId: "attachment:attachment-one",
        }).accepted,
      ).toBe(true);
      expect((await pending).completedEffectIds).toContain(
        "attachment:attachment-one",
      );
      expect(
        await requestCreationAttachment(attachment, { kernel }),
      ).toMatchObject({ state: "preparing" });
      expect(store.pendingOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("creation opening intents", () => {
  const opening = {
    sessionId: "create-opening-intent",
    identity: "request-opening-intent",
    openingPromptEntryId: "opening-prompt-one",
    runId: "opening:create-opening-intent:opening-prompt-one",
    runGeneration: 1,
    openingPlan: {
      id: "create-opening-intent",
      openingPrompt: "durable opening",
      openingPromptEntryId: "opening-prompt-one",
    },
  };

  test("waits for an accepted preparation effect before dispatching", async () => {
    const pending = {
      ...opening,
      sessionId: "create-pending-opening",
      identity: "request-pending-opening",
    };
    const { store, kernel } = harness(pending.sessionId);
    try {
      store.applyCreationEvent({
        sessionId: pending.sessionId,
        identity: pending.identity,
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: pending.sessionId,
        identity: pending.identity,
        event: "preparation_started",
        nextEffectId: "prepare-pending",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "prepare-pending",
          payload: {
            creationIdentity: pending.identity,
            creationGeneration: 1,
            workspaceId: "ws-pending",
            dedupeKey: "create:pending",
            name: "Pending",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      });
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: pending.sessionId,
          identity: pending.identity,
          event: "preparation_started",
          effectId: "prepare-pending",
        });
      }, 5);
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: pending.sessionId,
          identity: pending.identity,
          event: "succeeded",
          effectId: `opening:${pending.openingPromptEntryId}`,
        });
      }, 15);
      const state = await requestCreationOpening(pending, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.state).toBe("ready");
      expect(state.completedEffectIds).toEqual([
        "prepare-pending",
        `opening:${pending.openingPromptEntryId}`,
      ]);
    } finally {
      store.close();
    }
  });

  test("emits one durable opening launch and waits for terminal settlement", async () => {
    const { store, kernel } = harness(opening.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: opening.sessionId,
          identity: opening.identity,
          event: "succeeded",
          effectId: `opening:${opening.openingPromptEntryId}`,
        });
      }, 5);
      const state = await requestCreationOpening(opening, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.state).toBe("ready");
      expect(state.completedEffectIds).toContain(
        `opening:${opening.openingPromptEntryId}`,
      );
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_opening_turn",
          effectKey: `opening:${opening.openingPromptEntryId}`,
          payload: {
            openingPromptEntryId: opening.openingPromptEntryId,
            runId: opening.runId,
            runGeneration: 1,
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("settles an opening Stop without allowing a later launch result", async () => {
    const cancelled = {
      ...opening,
      sessionId: "create-cancelled-opening",
      identity: "request-cancelled-opening",
    };
    const { store, kernel } = harness(cancelled.sessionId);
    try {
      setTimeout(async () => {
        await settleCreationCancelled(
          cancelled.sessionId,
          cancelled.identity,
          kernel,
          `opening:${cancelled.openingPromptEntryId}`,
        );
      }, 5);
      await expect(
        requestCreationOpening(cancelled, {
          kernel,
          timeoutMs: 200,
          pollMs: 1,
        }),
      ).rejects.toThrow("was cancelled while opening was pending");
      expect(store.creationState(cancelled.sessionId)).toMatchObject({
        state: "cancelled",
        currentEffectId: undefined,
        completedEffectIds: [`opening:${cancelled.openingPromptEntryId}`],
      });
    } finally {
      store.close();
    }
  });

  test("Stop racing a terminal opening result stays idempotent", async () => {
    const raced = {
      ...opening,
      sessionId: "create-raced-opening",
      identity: "request-raced-opening",
    };
    const { store, kernel } = harness(raced.sessionId);
    try {
      // The opening effect settles a terminal between Stop's snapshot and its
      // reducer write. The cancellation must no-op on the terminal receipt
      // instead of throwing and failing an already-committed Stop.
      store.applyCreationEvent({
        sessionId: raced.sessionId,
        identity: raced.identity,
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: raced.sessionId,
        identity: raced.identity,
        event: "preparation_started",
      });
      store.applyCreationEvent({
        sessionId: raced.sessionId,
        identity: raced.identity,
        event: "opening_dispatched",
        openingPlan: { prompt: "opening" },
        nextEffectId: `opening:${raced.openingPromptEntryId}`,
        effect: {
          kind: "creation_opening_turn",
          effectKey: `opening:${raced.openingPromptEntryId}`,
          payload: {
            creationIdentity: raced.identity,
            creationGeneration: 1,
            openingPromptEntryId: raced.openingPromptEntryId,
            runId: raced.runId,
            runGeneration: 1,
            mode: "adopt_or_launch" as const,
          },
        },
      });
      store.applyCreationEvent({
        sessionId: raced.sessionId,
        identity: raced.identity,
        event: "succeeded",
        effectId: `opening:${raced.openingPromptEntryId}`,
      });
      expect(
        (
          await settleCreationCancelled(
            raced.sessionId,
            raced.identity,
            kernel,
            `opening:${raced.openingPromptEntryId}`,
          )
        ).state,
      ).toBe("ready");
    } finally {
      store.close();
    }

    const failed = {
      ...opening,
      sessionId: "create-raced-failed",
      identity: "request-raced-failed",
    };
    const failedHarness = harness(failed.sessionId);
    try {
      await settleCreationFailed(
        failed.sessionId,
        failed.identity,
        new Error("setup failed"),
        failedHarness.kernel,
      );
      expect(
        (
          await settleCreationCancelled(
            failed.sessionId,
            failed.identity,
            failedHarness.kernel,
            `opening:${failed.openingPromptEntryId}`,
          )
        ).state,
      ).toBe("failed");
    } finally {
      failedHarness.store.close();
    }
  });

  test("keeps a timed-out opening durable without emitting another launch", async () => {
    const { store, kernel } = harness(opening.sessionId);
    try {
      const timeout = await requestCreationOpening(opening, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      }).catch((error) => error);
      expect(isCreationEffectPendingError(timeout)).toBe(true);
      expect(timeout).toMatchObject({
        retryable: true,
        sessionId: opening.sessionId,
        effectId: `opening:${opening.openingPromptEntryId}`,
      });
      await expect(
        requestCreationOpening(opening, {
          kernel,
          timeoutMs: 5,
          pollMs: 1,
        }),
      ).rejects.toThrow("remains durably pending");
      expect(store.creationState(opening.sessionId)?.openingPlan).toEqual(
        opening.openingPlan,
      );
      expect(store.pendingOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("creation workspace intents", () => {
  test("waits for the actor receipt rather than destination evidence", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `workspace:${input.workspaceId}`,
        });
      }, 5);
      const state = await requestCreationWorkspace(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `workspace:${input.workspaceId}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          effectKey: `workspace:${input.workspaceId}`,
          payload: { worktreeDir: "/worktrees/intent" },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("does not re-emit work after its durable receipt", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      const effectId = `workspace:${input.workspaceId}`;
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        nextEffectId: effectId,
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: effectId,
          payload: {
            creationIdentity: input.identity,
            creationGeneration: 1,
            workspaceId: input.workspaceId,
            dedupeKey: input.dedupeKey,
            name: input.name,
            createdBy: input.createdBy,
            project: input.project,
            branch: input.branch,
            worktreeDir: input.worktreeDir,
            mode: "adopt_or_create",
          },
        },
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        effectId,
      });
      const [settled] = store.pendingOutbox();
      store.ackOutbox(settled.id);
      await requestCreationWorkspace(input, {
        kernel,
        timeoutMs: 20,
        pollMs: 1,
      });
      expect(store.pendingOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("fails closed on identity crossover", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: "another-request",
        event: "plan",
      });
      await expect(
        requestCreationWorkspace(input, { kernel, timeoutMs: 20, pollMs: 1 }),
      ).rejects.toThrow("identity crossed");
    } finally {
      store.close();
    }
  });
});

describe("creation branch intents", () => {
  test("persists stable branch identity and waits for its actor receipt", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branchInput.sessionId,
          identity: branchInput.identity,
          event: "preparation_started",
          effectId: `branch:${branchInput.project}:${branchInput.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `branch:${branchInput.project}:${branchInput.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: {
            worktreePath: "/worktrees/branch-intent",
            baseBranch: "main",
            isolated: true,
            credentialPrincipal: "user:alice",
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("leaves timed-out branch work durable and does not re-emit it", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      await expect(
        requestCreationBranch(branchInput, {
          kernel,
          timeoutMs: 5,
          pollMs: 1,
        }),
      ).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
      await expect(
        requestCreationBranch(branchInput, {
          kernel,
          timeoutMs: 5,
          pollMs: 1,
        }),
      ).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("creation credential intents", () => {
  test("persists only a stable selector and scope before receipt", async () => {
    const input = {
      sessionId: "create-credential-intent",
      identity: "request-credential-intent",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `credential:${input.principal}:${input.scope}`,
        });
      }, 5);
      const state = await requestCreationCredential(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${input.principal}:${input.scope}`,
      ]);
      const [effect] = store.pendingOutbox();
      expect(effect).toMatchObject({
        kind: "creation_credential_resolve",
        payload: {
          principal: "user:alice",
          scope: "git:opensession",
        },
      });
      expect(JSON.stringify(effect)).not.toContain("gitEnv");
      expect(JSON.stringify(effect)).not.toContain("token");
    } finally {
      store.close();
    }
  });

  test("continues from a credential receipt to one credential-bound branch", async () => {
    const credential = {
      sessionId: "credential-branch-sequence",
      identity: "request-credential-branch",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const branch = {
      ...branchInput,
      sessionId: credential.sessionId,
      identity: credential.identity,
    };
    const { store, kernel } = harness(credential.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: credential.sessionId,
          identity: credential.identity,
          event: "preparation_started",
          effectId: `credential:${credential.principal}:${credential.scope}`,
        });
      }, 5);
      await requestCreationCredential(credential, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      const [credentialEffect] = store.pendingOutbox();
      store.ackOutbox(credentialEffect.id);
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branch.sessionId,
          identity: branch.identity,
          event: "preparation_started",
          effectId: `branch:${branch.project}:${branch.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branch, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${credential.principal}:${credential.scope}`,
        `branch:${branch.project}:${branch.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: { credentialPrincipal: "user:alice" },
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("creation sandbox intents", () => {
  test("persists one session-keyed provider spec and waits for its receipt", async () => {
    const input = {
      sessionId: "create-sandbox-intent",
      identity: "request-sandbox-intent",
      provider: "modal",
      repo: "opensession",
      branch: "feature/sandbox-intent",
      sessionMode: "code" as const,
      cwd: "/worktrees/sandbox-intent",
      base: "main",
      attachedDirs: ["/worktrees/attached"],
      trustProfile: "interactive" as const,
      egressAllowlist: ["github.com"],
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `sandbox:${input.provider}:${input.sessionId}`,
        });
      }, 5);
      const state = await requestCreationSandbox(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `sandbox:${input.provider}:${input.sessionId}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_sandbox_prepare",
          payload: {
            sandboxKey: input.sessionId,
            provider: "modal",
            repo: "opensession",
            sessionMode: "code",
            attachedDirs: ["/worktrees/attached"],
            egressAllowlist: ["github.com"],
          },
        },
      ]);
    } finally {
      store.close();
    }
  });
});
