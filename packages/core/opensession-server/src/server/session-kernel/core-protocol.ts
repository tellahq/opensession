import type {
  SessionActorEffectFor,
  SessionActorEffectKind,
} from "./lifecycle-protocol";

export type CoreActorRequest =
  | {
      op: "enqueue_effect";
      sessionId: string;
      kind: SessionActorEffectKind;
      payload: SessionActorEffectFor<SessionActorEffectKind>["payload"];
      effectKey: string;
    }
  | { op: "ack_outbox"; id: number; sessionId: string }
  | { op: "defer_outbox"; id: number; sessionId: string }
  | {
      op: "fail_outbox";
      id: number;
      sessionId: string;
      error: string;
      maxAttempts: number;
    }
  | { op: "clear"; sessionId: string }
  | { op: "tombstone"; sessionId: string };

export type CoreActorResult<T extends CoreActorRequest> = T extends {
  op: "enqueue_effect";
}
  ? number
  : T extends { op: "fail_outbox" }
    ? { updated: boolean; deadLetteredNow: boolean }
    : void;
