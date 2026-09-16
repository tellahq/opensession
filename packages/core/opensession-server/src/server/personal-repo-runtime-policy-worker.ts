/** Owns existing run-policy classification, whose roster/persona helpers read
 * config synchronously. Never do that work on the HTTP gateway thread. */
import { isMainThread } from "node:worker_threads";
import { personalHostCredentialKind } from "./personal-repo-runtime-kind";

declare const self: Worker;
if (!isMainThread) {
  self.onmessage = (
    event: MessageEvent<{
      id: string;
      spec: Parameters<typeof personalHostCredentialKind>[0];
    }>,
  ) => {
    try {
      self.postMessage({
        id: event.data.id,
        kind: personalHostCredentialKind(event.data.spec),
      });
    } catch {
      self.postMessage({ id: event.data.id, error: true });
    }
  };
}
