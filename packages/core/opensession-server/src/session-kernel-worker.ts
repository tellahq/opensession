// Bun can deliver the parent's initialization frame while an async dependency
// (configuration loading) is still evaluating. Install the inbox BEFORE loading
// the actor graph, then replay in order once its real handler is ready.
const startupMessages: MessageEvent[] = [];
self.onmessage = (event: MessageEvent) => {
  if (startupMessages.length >= 64)
    throw new Error("Session kernel worker startup inbox overflow");
  startupMessages.push(event);
};
const { startSessionKernelActorWorker } =
  await import("./server/session-kernel/actor-worker");
startSessionKernelActorWorker();
for (const event of startupMessages) self.onmessage!.call(self, event);
startupMessages.length = 0;

export {};
