export type TimerActorRequest =
  | {
      op: "schedule";
      sessionId: string;
      timerId: string;
      kind: string;
      dueAt: number;
      payload: unknown;
    }
  | { op: "cancel"; sessionId: string; timerId: string }
  | {
      /** Move a not-yet-due timer earlier, only if it still carries `token`. */
      op: "pull_forward";
      sessionId: string;
      timerId: string;
      token: string;
      dueAt: number;
    }
  | {
      op: "begin";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "complete";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "fail";
      sessionId: string;
      timerId: string;
      token: string;
      error: string;
      maxAttempts: number;
    }
  | {
      op: "record_runtime_failure";
      sessionId: string;
      timerId: string;
      token: string;
      error: string;
      maxAttempts: number;
      observedAttempts: number;
    };

export type TimerActorResult<T extends TimerActorRequest> = T extends {
  op: "schedule" | "cancel";
}
  ? void
  : T extends { op: "begin" }
    ? "execute" | "completed" | "missing"
    : T extends { op: "complete" | "pull_forward" }
      ? boolean
      : T extends { op: "fail" | "record_runtime_failure" }
        ? { updated: boolean; deadLetteredNow: boolean }
        : never;
