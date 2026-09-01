import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWorkspace, getWorkspace } from "../workspaces";
import { createWorktree, listWorktrees } from "../worktree";
import {
  CreationEffectIndeterminateError,
  executeCreationAttachmentStage,
  executeCreationBranchPrepare,
  executeCreationCredentialResolve,
  executeCreationOpeningTurn,
  executeCreationSandboxPrepare,
  executeCreationWorkspacePrepare,
  type CreationAttachmentEffectItem,
  type CreationBranchEffectItem,
  type CreationCredentialEffectItem,
  type CreationOpeningEffectItem,
  type CreationSandboxEffectItem,
  type CreationWorkspaceEffectItem,
} from "./creation-effect-executors";

const roots: string[] = [];
const previousStateDir = process.env.OPENSESSION_STATE_DIR;

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function item(): CreationWorkspaceEffectItem {
  return {
    id: 1,
    effectId: "session:creation_workspace_prepare:workspace-effect",
    effectKey: "workspace-effect",
    sessionId: "session-one",
    kind: "creation_workspace_prepare",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      workspaceId: "ws-create-one",
      dedupeKey: "session-create:create-one",
      name: "Workspace one",
      createdBy: "Alice",
      project: "opensession",
      branch: "feature/create-one",
      mode: "adopt_or_create",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function branchItem(): CreationBranchEffectItem {
  return {
    id: 2,
    effectId: "session:creation_branch_prepare:branch-effect",
    effectKey: "branch-effect",
    sessionId: "session-one",
    kind: "creation_branch_prepare",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      project: "opensession",
      branch: "feature/create-one",
      worktreePath: "/worktrees/create-one",
      baseBranch: "main",
      isolated: true,
      mode: "adopt_or_create",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function credentialItem(): CreationCredentialEffectItem {
  return {
    id: 3,
    effectId: "session:creation_credential_resolve:credential-effect",
    effectKey: "credential-effect",
    sessionId: "session-one",
    kind: "creation_credential_resolve",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      principal: "user:alice",
      scope: "git:opensession",
      mode: "resolve_current",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function sandboxItem(): CreationSandboxEffectItem {
  return {
    id: 4,
    effectId: "session:creation_sandbox_prepare:sandbox-effect",
    effectKey: "sandbox-effect",
    sessionId: "session-one",
    kind: "creation_sandbox_prepare",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      provider: "modal",
      sandboxKey: "session-one",
      repo: "opensession",
      branch: "feature/create-one",
      sessionMode: "code",
      cwd: "/worktrees/create-one",
      base: "main",
      attachedDirs: ["/worktrees/attached"],
      trustProfile: "interactive",
      egressAllowlist: ["github.com"],
      mode: "adopt_or_create",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function attachmentItem(): CreationAttachmentEffectItem {
  return {
    id: 5,
    effectId: "session:creation_attachment_stage:attachment-effect",
    effectKey: "attachment:attachment-one",
    sessionId: "session-one",
    kind: "creation_attachment_stage",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      attachmentId: "attachment-one",
      name: "brief.pdf",
      sourceRef: "uploads:staged%2Fbrief.pdf",
      digest: "sha256:brief",
      mode: "reconcile_or_stage",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function openingItem(): CreationOpeningEffectItem {
  return {
    id: 5,
    effectId: "session:creation_opening_turn:opening-effect",
    effectKey: "opening:opening-prompt-one",
    sessionId: "session-one",
    kind: "creation_opening_turn",
    payload: {
      creationIdentity: "create-one",
      creationGeneration: 1,
      openingPromptEntryId: "opening-prompt-one",
      runId: "opening:session-one:opening-prompt-one",
      runGeneration: 1,
      mode: "adopt_or_launch",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
  };
}

function useTempState(): void {
  const root = mkdtempSync(join(tmpdir(), "creation-workspace-effect-"));
  roots.push(root);
  process.env.OPENSESSION_STATE_DIR = root;
}

describe("creation workspace effect executor", () => {
  test("adopts the destination after a crash before result acknowledgement", async () => {
    useTempState();
    let creates = 0;
    let results = 0;
    const create: typeof createWorkspace = (input) => {
      creates += 1;
      return createWorkspace(input);
    };
    await expect(
      executeCreationWorkspacePrepare(item(), {
        getWorkspace,
        createWorkspace: create,
        result: () => {
          results += 1;
          return { accepted: true, to: "preparing" };
        },
        afterDestinationAccepted: () => {
          throw new Error("injected crash after destination acceptance");
        },
      }),
    ).rejects.toThrow("injected crash after destination acceptance");
    expect(getWorkspace("ws-create-one")).toMatchObject({
      key: "session-create:create-one",
      branch: "feature/create-one",
    });
    await executeCreationWorkspacePrepare(item(), {
      getWorkspace,
      createWorkspace: create,
      result: () => {
        results += 1;
        return { accepted: true, to: "preparing" };
      },
    });
    expect(creates).toBe(1);
    expect(results).toBe(1);
  });

  test("treats replay after actor result acceptance as an acknowledged stale no-op", async () => {
    useTempState();
    let calls = 0;
    const dependencies = {
      getWorkspace,
      createWorkspace,
      result: () => {
        calls += 1;
        return calls === 1
          ? { accepted: true, to: "preparing" as const }
          : {
              accepted: false,
              reason: "stale_effect" as const,
              state: {
                identity: "create-one",
                generation: 1,
                state: "preparing" as const,
                completedEffectIds: ["workspace-effect"],
                changeSeq: 3,
                updatedAt: 1,
              },
            };
      },
    };
    await executeCreationWorkspacePrepare(item(), dependencies);
    await executeCreationWorkspacePrepare(item(), dependencies);
    expect(calls).toBe(2);
  });

  test("fails closed when the fixed destination belongs to another identity", async () => {
    useTempState();
    createWorkspace({
      id: "ws-create-one",
      key: "another-create",
      name: "Existing",
      createdBy: "Bob",
      repo: "opensession",
      branch: "feature/create-one",
    });
    await expect(
      executeCreationWorkspacePrepare(item(), {
        getWorkspace,
        createWorkspace,
        result: () => {
          throw new Error("result must not be sent");
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
  });
});

describe("creation branch effect executor", () => {
  test("adopts the exact branch destination without creating it again", async () => {
    let creates = 0;
    let results = 0;
    await executeCreationBranchPrepare(branchItem(), {
      listWorktrees: (async () => [
        { branch: "feature/create-one", path: "/worktrees/create-one" },
      ]) as typeof listWorktrees,
      createWorktree: (async () => {
        creates += 1;
        return "/worktrees/create-one";
      }) as typeof createWorktree,
      result: () => {
        results += 1;
        return { accepted: true, to: "preparing" };
      },
    });
    expect(creates).toBe(0);
    expect(results).toBe(1);
  });

  test("adopts after a crash between worktree acceptance and actor result", async () => {
    const worktrees: Array<{ branch: string; path: string }> = [];
    let creates = 0;
    let results = 0;
    const list = (async () => worktrees) as typeof listWorktrees;
    const create = (async (branch: string) => {
      creates += 1;
      worktrees.push({ branch, path: "/worktrees/create-one" });
      return "/worktrees/create-one";
    }) as typeof createWorktree;
    await expect(
      executeCreationBranchPrepare(branchItem(), {
        listWorktrees: list,
        createWorktree: create,
        result: () => {
          results += 1;
          return { accepted: true, to: "preparing" };
        },
        afterDestinationAccepted: () => {
          throw new Error("injected crash after branch acceptance");
        },
      }),
    ).rejects.toThrow("injected crash after branch acceptance");
    await executeCreationBranchPrepare(branchItem(), {
      listWorktrees: list,
      createWorktree: create,
      result: () => {
        results += 1;
        return { accepted: true, to: "preparing" };
      },
    });
    expect(creates).toBe(1);
    expect(results).toBe(1);
  });

  test("materializes an existing remote branch through its explicit adapter", async () => {
    const effect = branchItem();
    effect.payload.existingBranch = true;
    effect.payload.credentialPrincipal = "user:alice";
    let existingCalls = 0;
    await executeCreationBranchPrepare(effect, {
      listWorktrees: (async () => []) as typeof listWorktrees,
      createWorktree: (async () => {
        throw new Error("must not create a new branch");
      }) as typeof createWorktree,
      createWorktreeForExistingBranch: async (_branch, _project, gitEnv) => {
        existingCalls += 1;
        expect(gitEnv).toEqual({ GIT_ASKPASS: "/private/helper" });
        return "/worktrees/create-one";
      },
      resolveCredential: async () => ({
        kind: "user",
        principal: "user:alice",
        env: { GIT_ASKPASS: "/private/helper" },
      }),
      result: () => ({ accepted: true, to: "preparing" }),
    });
    expect(existingCalls).toBe(1);
  });

  test("resolves an ephemeral Git capability only when creation is necessary", async () => {
    const effect = branchItem();
    effect.payload.credentialPrincipal = "user:alice";
    const secretEnv = { GIT_ASKPASS: "/private/helper" };
    let receivedOptions: Record<string, unknown> | undefined;
    await executeCreationBranchPrepare(effect, {
      listWorktrees: (async () => []) as typeof listWorktrees,
      createWorktree: (async (_branch, _project, options) => {
        receivedOptions = options;
        return "/worktrees/create-one";
      }) as typeof createWorktree,
      resolveCredential: async () => ({
        kind: "user",
        principal: "user:alice",
        env: secretEnv,
      }),
      result: () => ({ accepted: true, to: "preparing" }),
    });
    expect(receivedOptions).toMatchObject({ gitEnv: secretEnv });
    expect(effect.payload).not.toHaveProperty("gitEnv");
  });

  test("adopts a configured shared checkout without requiring a branch worktree", async () => {
    const effect = branchItem();
    effect.payload.worktreePath = "/projects/opensession";
    effect.payload.credentialPrincipal = "user:alice";
    let results = 0;
    await executeCreationBranchPrepare(effect, {
      listWorktrees: (async () => []) as typeof listWorktrees,
      destinationExists: () => true,
      isSharedCheckoutDestination: async () => true,
      createWorktree: (async () => {
        throw new Error("must not create inside a shared checkout");
      }) as typeof createWorktree,
      resolveCredential: async () => {
        throw new Error("must not resolve Git credentials for adoption");
      },
      result: () => {
        results += 1;
        return { accepted: true, to: "preparing" };
      },
    });
    expect(results).toBe(1);
  });

  test("fails indeterminate on an unregistered destination after a crash", async () => {
    await expect(
      executeCreationBranchPrepare(branchItem(), {
        listWorktrees: (async () => []) as typeof listWorktrees,
        destinationExists: () => true,
        createWorktree: (async () => {
          throw new Error("must not overwrite an ambiguous destination");
        }) as typeof createWorktree,
        result: () => {
          throw new Error("must not result");
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
  });

  test("fails closed when branch and worktree identity disagree", async () => {
    await expect(
      executeCreationBranchPrepare(branchItem(), {
        listWorktrees: (async () => [
          { branch: "feature/create-one", path: "/worktrees/other" },
        ]) as typeof listWorktrees,
        createWorktree: (async () => {
          throw new Error("must not create");
        }) as typeof createWorktree,
        result: () => {
          throw new Error("must not result");
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
  });
});

describe("creation sandbox effect executor", () => {
  test("adopts after a crash between provider acceptance and actor result", async () => {
    let ensures = 0;
    let results = 0;
    const ensure = async (_provider: string, spec: any) => {
      ensures += 1;
      expect(spec).toMatchObject({
        sessionId: "session-one",
        repo: "opensession",
        branch: "feature/create-one",
        mode: "code",
        trustProfile: "interactive",
      });
      return { id: "sandbox-one", provider: "modal" as const };
    };
    await expect(
      executeCreationSandboxPrepare(sandboxItem(), {
        ensure,
        result: () => {
          results += 1;
          return { accepted: true, to: "preparing" };
        },
        afterDestinationAccepted: () => {
          throw new Error("injected crash after sandbox acceptance");
        },
      }),
    ).rejects.toThrow("injected crash after sandbox acceptance");
    await executeCreationSandboxPrepare(sandboxItem(), {
      ensure,
      result: (_effect, sandboxId) => {
        results += 1;
        expect(sandboxId).toBe("sandbox-one");
        return { accepted: true, to: "preparing" };
      },
    });
    expect(ensures).toBe(2);
    expect(results).toBe(1);
  });

  test("rejects sandbox key or provider crossover before actor result", async () => {
    const crossed = sandboxItem();
    crossed.payload.sandboxKey = "another-session";
    await expect(
      executeCreationSandboxPrepare(crossed, {
        ensure: async () => {
          throw new Error("must not ensure");
        },
        result: () => {
          throw new Error("must not result");
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);

    await expect(
      executeCreationSandboxPrepare(sandboxItem(), {
        ensure: async () => ({ id: "sandbox-one", provider: "docker" }),
        result: () => {
          throw new Error("must not result");
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
  });
});

describe("creation attachment effect executor", () => {
  test("adopts a staged destination after a crash before actor settlement", async () => {
    let stages = 0;
    let results = 0;
    const dependencies = {
      stage: (_sessionId: string, source: any) => {
        stages += 1;
        expect(source).toMatchObject({
          attachmentId: "attachment-one",
          name: "brief.pdf",
          digest: "sha256:brief",
        });
        return {
          name: "brief.pdf",
          path: "/uploads/session-one/attachment-one-brief.pdf",
        };
      },
      result: () => {
        results += 1;
        return results === 1
          ? { accepted: false as const, reason: "invalid_transition" as const }
          : { accepted: true as const };
      },
    };
    await expect(
      executeCreationAttachmentStage(attachmentItem(), dependencies),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
    await executeCreationAttachmentStage(attachmentItem(), dependencies);
    expect(stages).toBe(2);
    expect(results).toBe(2);
  });
});

describe("creation opening effect executor", () => {
  test("launches the exact session-keyed opening fence", async () => {
    const launched: CreationOpeningEffectItem[] = [];
    const input = openingItem();
    await executeCreationOpeningTurn(input, {
      launch: async (item) => {
        launched.push(item);
      },
    });
    expect(launched).toEqual([input]);
  });

  test("settles a stopped opening before any physical launch", async () => {
    let launches = 0;
    await executeCreationOpeningTurn(openingItem(), {
      cancel: () => true,
      launch: async () => {
        launches += 1;
      },
    });
    expect(launches).toBe(0);
  });

  test("rejects an opening run id that crosses session ownership", async () => {
    const input = openingItem();
    input.payload.runId = "opening:another-session:opening-prompt-one";
    await expect(
      executeCreationOpeningTurn(input, { launch: async () => {} }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
  });
});

describe("creation credential effect executor", () => {
  test("returns only a fenced receipt after resolving a process-local capability", async () => {
    let resultCalls = 0;
    const secretEnv = { GIT_ASKPASS: "/private/helper" };
    await executeCreationCredentialResolve(credentialItem(), {
      resolveCredential: async () => ({
        kind: "user",
        principal: "user:alice",
        env: secretEnv,
      }),
      afterResolved: (credential) => expect(credential.env).toBe(secretEnv),
      result: (effect) => {
        resultCalls += 1;
        expect(effect.payload).not.toHaveProperty("env");
        expect(effect.payload).not.toHaveProperty("token");
        return { accepted: true, to: "preparing" };
      },
    });
    expect(resultCalls).toBe(1);
  });

  test("rejects identity crossover before reporting a result", async () => {
    let resultCalls = 0;
    await expect(
      executeCreationCredentialResolve(credentialItem(), {
        resolveCredential: async () => ({
          kind: "service",
          principal: "service",
          env: { SECRET: "hidden" },
        }),
        result: () => {
          resultCalls += 1;
          return { accepted: true, to: "preparing" };
        },
      }),
    ).rejects.toBeInstanceOf(CreationEffectIndeterminateError);
    expect(resultCalls).toBe(0);
  });
});
