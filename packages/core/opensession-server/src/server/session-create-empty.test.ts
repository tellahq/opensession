import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  type CreationOpeningEffectItem,
} from "./session-kernel";
import {
  SessionListStore,
  __setSessionListStoreForTest,
} from "./session-list-store";
import {
  executeCreationOpeningEffect,
  openCreatedSession,
  type ResolvedCreate,
} from "./session-create";
import { snapshotOpeningCreate } from "./session-create-plan";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { transcriptStore } from "./transcript-store";
import { preparingWorkspaces } from "./ws-hub";
import { promptDispatches } from "./queue-state";

let store: SessionKernelStore;
let previous: SessionKernelStore | undefined;
let index: SessionListStore;
let previousIndex: SessionListStore | undefined;

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previous = __setSessionKernelStoreForTest(store);
  index = new SessionListStore(":memory:");
  previousIndex = __setSessionListStoreForTest(index);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previous);
  __setSessionListStoreForTest(previousIndex);
  store.close();
  index.close();
});

function emptyCreate() {
  const id = `os-${crypto.randomUUID()}`;
  const spec: ResolvedCreate = {
    id,
    title: "New session",
    titlePrompt: "",
    displayPrompt: "",
    // A linked workspace can contribute context without asking the agent to run.
    openingPrompt: "Workspace context only",
    deferOpening: true,
    createdBy: "Alex",
    createdAt: new Date().toISOString(),
    mode: "scratch",
    wtPath: OPENSESSION_SESSIONS_DIR,
    persistBranch: "",
    branch: "",
    memoryRepoIds: [],
    sandboxProvider: null,
    volumeWorkspace: false,
    remoteSandbox: false,
    needsWorktree: false,
    openingPromptEntryId: `create-${id}`,
    finish: "drain",
  };
  const effectKey = `opening:${spec.openingPromptEntryId}`;
  const item: CreationOpeningEffectItem = {
    id: 1,
    effectId: `${id}:creation_opening_turn:${effectKey}`,
    effectKey,
    sessionId: id,
    kind: "creation_opening_turn",
    payload: {
      creationIdentity: id,
      creationGeneration: 1,
      openingPromptEntryId: spec.openingPromptEntryId,
      runId: `opening:${id}:${spec.openingPromptEntryId}`,
      runGeneration: 1,
      mode: "adopt_or_launch",
    },
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  };
  return { spec, item };
}

async function prepare(spec: ResolvedCreate, item: CreationOpeningEffectItem) {
  await promptDispatches.set(spec.id, {
    promptEntryId: spec.openingPromptEntryId,
    items: [{ content: spec.openingPrompt }],
    kind: "create",
  });
  store.applyCreationEvent({
    sessionId: spec.id,
    identity: spec.id,
    event: "plan",
  });
  store.applyCreationEvent({
    sessionId: spec.id,
    identity: spec.id,
    event: "preparation_started",
  });
  const decision = store.applyCreationEvent({
    sessionId: spec.id,
    identity: spec.id,
    event: "opening_dispatched",
    openingPlan: snapshotOpeningCreate(spec),
    nextEffectId: item.effectKey,
    effect: {
      kind: item.kind,
      effectKey: item.effectKey,
      payload: item.payload,
    },
  });
  expect(decision.accepted).toBe(true);
}

test("a recovered empty create completes without a transcript or engine run and replays safely", async () => {
  const { spec, item } = emptyCreate();
  await prepare(spec, item);
  preparingWorkspaces.add(spec.id);
  await executeCreationOpeningEffect(item);
  expect(store.creationState(spec.id)?.state).toBe("ready");
  expect(store.deliverySnapshot(spec.id).dispatch).toBeUndefined();
  expect(store.runState(spec.id)?.currentRunId).toBeFalsy();
  expect(preparingWorkspaces.has(spec.id)).toBe(false);
  const saved = JSON.parse(
    await readFile(`${OPENSESSION_SESSIONS_DIR}/${spec.id}.json`, "utf8"),
  );
  expect(saved.title).toBe("New session");
  expect(saved.claudeSessionId).toBe("");
  expect(saved.piSessionId).toBeUndefined();
  expect(transcriptStore().readTail(spec.id).entries).toEqual([]);
  await executeCreationOpeningEffect(item);
  expect(store.creationState(spec.id)?.state).toBe("ready");
  expect(transcriptStore().readTail(spec.id).entries).toEqual([]);
  // There is no phantom opening turn preventing the first real prompt's admission.
  expect(
    store.applyRunEvent({
      sessionId: spec.id,
      event: "prompt",
      runKey: "first-message",
    }).accepted,
  ).toBe(true);
});

test("empty sandbox sessions retain their selection without provisioning compute", async () => {
  const { spec, item } = emptyCreate();
  spec.sandboxProvider = "daytona";
  spec.remoteSandbox = true;
  await prepare(spec, item);
  await executeCreationOpeningEffect(item);
  const saved = JSON.parse(
    await readFile(`${OPENSESSION_SESSIONS_DIR}/${spec.id}.json`, "utf8"),
  );
  expect(saved.sandbox).toEqual({ provider: "daytona", workspace: "volume" });
  expect(store.creationState(spec.id)?.state).toBe("ready");
  expect(store.runState(spec.id)?.currentRunId).toBeFalsy();
});

test("an empty create setup failure releases the composer without starting a run", async () => {
  const { spec, item } = emptyCreate();
  await prepare(spec, item);
  spec.needsWorktree = true;
  spec.materializeWorktree = async () => {
    throw new Error("Checkout unavailable");
  };
  preparingWorkspaces.add(spec.id);
  const frames: Record<string, unknown>[] = [];
  await openCreatedSession(
    spec,
    {
      announce: () => {},
      emit: (frame) => frames.push(frame),
      fail: (message) => {
        throw new Error(message);
      },
    },
    spec.id,
    item.effectKey,
  );
  expect(store.creationState(spec.id)?.state).toBe("failed");
  expect(store.deliverySnapshot(spec.id).dispatch).toBeUndefined();
  expect(store.runState(spec.id).currentRunId).toBeFalsy();
  expect(preparingWorkspaces.has(spec.id)).toBe(false);
  expect(frames).toContainEqual({
    type: "error",
    message: "Checkout unavailable",
  });
  expect(frames).toContainEqual({ type: "workspace_status", ready: true });
  expect(frames).not.toContainEqual({ type: "stream_start" });
});
