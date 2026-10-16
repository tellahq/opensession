import { isPersonalCredentialKind } from "./personal-github/repository-coordinator";
import { randomUUID } from "node:crypto";
import { workerEntry } from "../runner-host/exe";
import type { PersonalCredentialKind } from "./personal-github/repository-coordinator";
import type { personalHostCredentialKind } from "./personal-repo-runtime-kind";
type Input = Parameters<typeof personalHostCredentialKind>[0];
let singleton: ReturnType<typeof createPersonalPolicyClient> | undefined;

export function createPersonalPolicyClient(env?: Record<string, string>) {
  const worker = new Worker(
    workerEntry(
      "personal-repo-runtime-policy-worker.js",
      new URL("./personal-repo-runtime-policy-worker.ts", import.meta.url).href,
    ),
    { type: "module", ...(env ? { env } : {}) },
  );
  let failed = false;
  const pending = new Map<
    string,
    {
      resolve(kind: PersonalCredentialKind): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    failed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Personal run classification unavailable"));
    }
    pending.clear();
  };
  worker.onerror = fail;
  worker.addEventListener("close", fail);
  worker.onmessage = (
    event: MessageEvent<{
      id: string;
      kind?: PersonalCredentialKind;
      error?: boolean;
    }>,
  ) => {
    const item = pending.get(event.data.id);
    if (!item) return;
    pending.delete(event.data.id);
    clearTimeout(item.timer);
    if (event.data.error || !isPersonalCredentialKind(event.data.kind))
      item.reject(new Error("Personal run classification unavailable"));
    else item.resolve(event.data.kind);
  };
  return {
    close() {
      fail();
      worker.terminate();
    },
    classify(spec: Input): Promise<PersonalCredentialKind> {
      if (failed || pending.size >= 64)
        return Promise.reject(
          new Error("Personal run classification unavailable"),
        );
      // No prompt, images, credential, or arbitrary run-body fields cross here.
      const input: Input = {
        mode: spec.mode,
        user: spec.user,
        author: spec.author,
        journalKind: spec.journalKind,
        deniedTools: spec.deniedTools,
        confirmTools: spec.confirmTools,
      };
      if (Buffer.byteLength(JSON.stringify(input)) > 65_536)
        return Promise.reject(
          new Error("Personal run classification unavailable"),
        );
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Personal run classification timed out"));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, spec: input });
      });
    },
  };
}
export function personalHostCredentialKindAsync(spec: Input) {
  singleton ??= createPersonalPolicyClient();
  return singleton.classify(spec);
}

export function closePersonalPolicyClient() {
  singleton?.close();
  singleton = undefined;
}
