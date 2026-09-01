import { SESSION_KERNEL_ACTOR_VERSION } from "../actor-protocol";

self.addEventListener("message", (event: MessageEvent<Record<string, any>>) => {
  const request = event.data;
  if (request.t === "hello") {
    self.postMessage({
      t: "ready",
      rpcId: request.rpcId,
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    return;
  }
  if (
    request.t === "call" &&
    request.request?.t === "store" &&
    request.request.method === "askEntries"
  )
    return;
  self.postMessage({
    t: "error",
    rpcId: request.rpcId,
    error: `Unexpected test request ${String(request.t)}`,
  });
});
