import { SESSION_KERNEL_ACTOR_VERSION } from "../actor-protocol";

/** Answers the handshake, then never answers a catalog-lane mutation: the
 *  service must fail-stop rather than retry an ambiguous placement write. */
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
    request.request.method === "clearAskRecords"
  )
    return;
  self.postMessage({
    t: "error",
    rpcId: request.rpcId,
    error: `Unexpected test request ${String(request.t)}`,
  });
});
