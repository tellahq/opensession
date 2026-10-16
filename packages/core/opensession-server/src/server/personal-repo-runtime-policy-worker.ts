/** Owns existing run-policy classification, whose roster/persona helpers read
 * config synchronously. Never do that work on the HTTP gateway thread. */
import { isMainThread } from "node:worker_threads";

declare const self: Worker;
if (!isMainThread) {
  // Register the handler before the policy graph loads: its config module
  // evaluates asynchronously, and a request posted during that window would
  // otherwise arrive before any handler and be dropped.
  const policy = import("./personal-repo-runtime-kind");
  self.onmessage = async (
    event: MessageEvent<{
      id: string;
      spec: Parameters<
        typeof import("./personal-repo-runtime-kind").personalHostCredentialKind
      >[0];
    }>,
  ) => {
    try {
      const { personalHostCredentialKind } = await policy;
      self.postMessage({
        id: event.data.id,
        kind: personalHostCredentialKind(event.data.spec),
      });
    } catch {
      self.postMessage({ id: event.data.id, error: true });
    }
  };
}
