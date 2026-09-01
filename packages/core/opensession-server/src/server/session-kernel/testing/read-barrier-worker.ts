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
    request.request.method === "turnSnapshot"
  ) {
    setTimeout(() => {
      const body = JSON.stringify({ ok: true, result: undefined });
      self.postMessage({
        t: "call_result",
        rpcId: request.rpcId,
        status: 1,
        length: Buffer.byteLength(body),
        body,
      });
    }, 300);
    return;
  }
  if (request.t === "runtime_catalog_work") {
    self.postMessage({
      t: "runtime_catalog_work_result",
      rpcId: request.rpcId,
      sessionIds: ["runtime-session"],
      timers: [],
      outbox: [],
    });
    return;
  }
  if (request.t === "runtime_session_work") {
    self.postMessage({
      t: "runtime_session_work_result",
      rpcId: request.rpcId,
      timers: [],
      outbox: [],
    });
    return;
  }
  self.postMessage({
    t: "error",
    rpcId: request.rpcId,
    error: `Unexpected test request ${String(request.t)}`,
  });
});
