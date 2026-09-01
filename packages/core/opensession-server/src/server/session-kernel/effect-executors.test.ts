import { describe, expect, test } from "bun:test";
import { SessionEffectExecutorRegistry } from "./effect-executors";
import type { DurableOutboxItem } from "./store";

function outbox(
  payload: unknown,
  kind = "human_ask_deliver",
): DurableOutboxItem {
  return {
    id: 1,
    effectId: "session:human_ask_deliver:ask",
    effectKey: "ask",
    sessionId: "session",
    kind,
    payload,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

describe("session effect executor registry", () => {
  test("decodes typed payloads before execution", async () => {
    const registry = new SessionEffectExecutorRegistry();
    let delivered: { askId: string; skipUi: boolean } | undefined;
    registry.register("human_ask_deliver", (item) => {
      delivered = item.payload;
    });

    expect(
      await registry.execute(outbox({ askId: "ask-one", skipUi: false })),
    ).toBe(true);
    expect(delivered).toEqual({ askId: "ask-one", skipUi: false });
  });

  test("decodes fenced interrupt cancellation effects", async () => {
    const registry = new SessionEffectExecutorRegistry();
    let cancel: unknown;
    registry.register("delivery_interrupt_cancel", (item) => {
      cancel = item.payload;
    });
    expect(
      await registry.execute(
        outbox(
          {
            interruptId: "interrupt-one",
            runIds: ["session-one", "engine-one"],
            runGeneration: 4,
          },
          "delivery_interrupt_cancel",
        ),
      ),
    ).toBe(true);
    expect(cancel).toEqual({
      interruptId: "interrupt-one",
      runIds: ["session-one", "engine-one"],
      runGeneration: 4,
    });
  });

  test("decodes generation-fenced turn cancellation effects", async () => {
    const registry = new SessionEffectExecutorRegistry();
    let cancel: unknown;
    registry.register("turn_cancel", (item) => {
      cancel = item.payload;
    });
    expect(
      await registry.execute(
        outbox(
          {
            cancelId: "cancel-one",
            dispatchId: "dispatch-one",
            runGeneration: 4,
          },
          "turn_cancel",
        ),
      ),
    ).toBe(true);
    expect(cancel).toEqual({
      cancelId: "cancel-one",
      dispatchId: "dispatch-one",
      runGeneration: 4,
    });
  });

  test("decodes creation references without forwarding durable secrets or bodies", async () => {
    const registry = new SessionEffectExecutorRegistry();
    let credential: unknown;
    let branch: unknown;
    let sandbox: unknown;
    let attachment: unknown;
    registry.register("creation_credential_resolve", (item) => {
      credential = item.payload;
    });
    registry.register("creation_branch_prepare", (item) => {
      branch = item.payload;
    });
    registry.register("creation_sandbox_prepare", (item) => {
      sandbox = item.payload;
    });
    registry.register("creation_attachment_stage", (item) => {
      attachment = item.payload;
    });
    const fence = { creationIdentity: "create-one", creationGeneration: 2 };
    expect(
      await registry.execute(
        outbox(
          {
            ...fence,
            principal: "github:alice",
            scope: "repo:read",
            mode: "resolve_current",
            token: "must-not-cross",
          },
          "creation_credential_resolve",
        ),
      ),
    ).toBe(true);
    expect(credential).toEqual({
      ...fence,
      principal: "github:alice",
      scope: "repo:read",
      mode: "resolve_current",
    });
    expect(
      await registry.execute(
        outbox(
          {
            ...fence,
            project: "opensession",
            branch: "feature/create-one",
            worktreePath: "/worktrees/create-one",
            // Older clean-install creates persisted an empty optional stack base.
            // It means "branch from the repo default", not an invalid effect.
            baseBranch: "",
            isolated: true,
            existingBranch: true,
            credentialPrincipal: "user:alice",
            mode: "adopt_or_create",
            gitEnv: { GIT_ASKPASS: "must-not-cross" },
          },
          "creation_branch_prepare",
        ),
      ),
    ).toBe(true);
    expect(branch).toEqual({
      ...fence,
      project: "opensession",
      branch: "feature/create-one",
      worktreePath: "/worktrees/create-one",
      isolated: true,
      existingBranch: true,
      credentialPrincipal: "user:alice",
      mode: "adopt_or_create",
    });
    expect(
      await registry.execute(
        outbox(
          {
            ...fence,
            provider: "modal",
            sandboxKey: "session-one",
            repo: "opensession",
            branch: "feature/create-one",
            sessionMode: "code",
            cwd: "/worktrees/create-one",
            attachedDirs: ["/worktrees/attached"],
            trustProfile: "interactive",
            egressAllowlist: ["github.com"],
            mode: "adopt_or_create",
            token: "must-not-cross",
          },
          "creation_sandbox_prepare",
        ),
      ),
    ).toBe(true);
    expect(sandbox).toEqual({
      ...fence,
      provider: "modal",
      sandboxKey: "session-one",
      repo: "opensession",
      branch: "feature/create-one",
      sessionMode: "code",
      cwd: "/worktrees/create-one",
      attachedDirs: ["/worktrees/attached"],
      trustProfile: "interactive",
      egressAllowlist: ["github.com"],
      mode: "adopt_or_create",
    });
    expect(
      await registry.execute(
        outbox(
          {
            ...fence,
            attachmentId: "attachment-one",
            name: "brief.pdf",
            sourceRef: "staged:attachment-one",
            digest: "sha256:digest",
            mode: "reconcile_or_stage",
            dataUrl: "data:image/png;base64,must-not-cross",
          },
          "creation_attachment_stage",
        ),
      ),
    ).toBe(true);
    expect(attachment).toEqual({
      ...fence,
      attachmentId: "attachment-one",
      name: "brief.pdf",
      sourceRef: "staged:attachment-one",
      digest: "sha256:digest",
      mode: "reconcile_or_stage",
    });
  });

  test("rejects malformed known effects and ignores unknown versions", async () => {
    const registry = new SessionEffectExecutorRegistry();
    registry.register("human_ask_deliver", () => {});

    await expect(
      registry.execute(outbox({ askId: "ask-one" })),
    ).rejects.toThrow("Invalid human_ask_deliver effect payload");
    registry.register("creation_opening_turn", () => {});
    await expect(
      registry.execute(
        outbox(
          {
            creationIdentity: "create-one",
            creationGeneration: 1,
            openingPromptEntryId: "entry-one",
            runId: "run-one",
            runGeneration: 0,
            mode: "adopt_or_launch",
          },
          "creation_opening_turn",
        ),
      ),
    ).rejects.toThrow("opening fence");
    expect(await registry.execute(outbox(null, "future_effect"))).toBe(false);
  });

  test("allows exactly one executor per effect kind", () => {
    const registry = new SessionEffectExecutorRegistry();
    const unregister = registry.register("human_ask_deliver", () => {});
    expect(() => registry.register("human_ask_deliver", () => {})).toThrow(
      "already registered",
    );
    unregister();
    expect(registry.kinds()).toEqual([]);
  });
});
