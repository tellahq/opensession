import { expect, test } from "bun:test";
import * as Runtime from "./turn-checkpoint-runtime";
const preview = {
  patch: "diff",
  restorePatch: "restore",
  files: ["file"],
  currentTree: "a".repeat(40),
  canRestore: true,
  reason: null,
  canUndo: false,
  interrupted: false,
};
test("Effect runtime decodes previews and routes undo previews independently", async () => {
  const ready = Promise.withResolvers<Runtime.TurnCheckpointState>();
  let requested = "";
  const runtime = Runtime.makeTurnCheckpointRuntime({
    changed: (state) => {
      if (state.preview) ready.resolve(state);
    },
    completed: () => {},
    send: async (path: string) => {
      requested = path;
      return preview;
    },
  });
  try {
    runtime.load("os-test", "turn-1", true);
    const state = await ready.promise;
    expect(state.preview?.files).toEqual(["file"]);
    expect(requested).toEndWith("?undo=true");
    expect(state.undo).toBe(true);
    expect(state.loading).toBe(false);
  } finally {
    runtime.stop();
  }
});
test("invalid payload is a visible decoding error, not a usable destructive preview", async () => {
  const failed = Promise.withResolvers<Runtime.TurnCheckpointState>();
  const runtime = Runtime.makeTurnCheckpointRuntime({
    changed: (state) => {
      if (state.error) failed.resolve(state);
    },
    completed: () => {},
    send: async () => ({ ...preview, canRestore: "yes" }),
  });
  try {
    runtime.load("os-test", "turn-1");
    const state = await failed.promise;
    expect(state.preview).toBeNull();
    expect(state.error).toContain("Could not read");
  } finally {
    runtime.stop();
  }
});
test("destructive transport failures never retry automatically", async () => {
  const failed = Promise.withResolvers<Runtime.TurnCheckpointState>();
  let calls = 0;
  const runtime = Runtime.makeTurnCheckpointRuntime({
    changed: (state) => {
      if (state.error) failed.resolve(state);
    },
    completed: () => {
      throw new Error("unexpected success");
    },
    send: async () => {
      calls++;
      throw new Error("connection lost");
    },
  });
  try {
    runtime.act("os-test", "turn-1", "revert", preview.currentTree);
    expect((await failed.promise).error).toBe("connection lost");
    expect(calls).toBe(1);
  } finally {
    runtime.stop();
  }
});
test("disposing a component scope aborts its pending request", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const runtime = Runtime.makeTurnCheckpointRuntime({
    changed: () => {},
    completed: () => {},
    send: (_: string, options: { signal?: AbortSignal }) => {
      started.resolve(options.signal!);
      return new Promise<never>((_, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    },
  });
  runtime.load("os-test", "turn-1");
  const signal = await started.promise;
  runtime.stop();
  await aborted.promise;
  expect(signal.aborted).toBe(true);
});
