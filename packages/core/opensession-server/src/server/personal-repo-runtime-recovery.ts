import type { ActiveRunRecord } from "./run-journal";
import type { HostedEventPublication } from "./host-event-publication";
import {
  bindPersonalRunRecovery,
  personalRunConsumerKey,
  personalRunLineageKey,
  personalRunRetired,
  snapshotPersonalRunConsumer,
} from "./personal-run-consumers";
import { sessionPublicationAllowed } from "./session-audience";

type RecoveryIdentity = Pick<
  ActiveRunRecord,
  "runKey" | "hostId" | "osSessionId" | "personalRepo"
>;
export function personalRecoveryConsumer(run: RecoveryIdentity) {
  if (!run.hostId || !run.osSessionId || !run.personalRepo)
    throw new Error("Private recovery identity unavailable");
  return snapshotPersonalRunConsumer({
    runKey: run.runKey,
    hostId: run.hostId,
    sessionId: run.osSessionId,
    binding: run.personalRepo,
  });
}
/** Exact durable enrollment is the authority. No fresh alias/owner/stamp is
 * inferred for pre-event recovery transitions or late error callbacks. */
export async function capturePersonalRecoveryContext(
  run: RecoveryIdentity,
): Promise<HostedEventPublication> {
  const consumer = personalRecoveryConsumer(run);
  const scope = await bindPersonalRunRecovery(consumer, (work: () => void) =>
    work(),
  );
  return Object.freeze({
    personal: true,
    consumer,
    alive() {
      let allowed = false;
      try {
        scope(() => {
          allowed = sessionPublicationAllowed(consumer.sessionId);
        });
      } catch {
        return false;
      }
      return allowed;
    },
    run<T>(work: () => T): T {
      let result!: T;
      scope(() => {
        result = work();
      });
      return result;
    },
  });
}
export function samePersonalRecoveryLineage(
  run: RecoveryIdentity,
  context: HostedEventPublication,
): boolean {
  try {
    return (
      !!context.consumer &&
      personalRunLineageKey(personalRecoveryConsumer(run)) ===
        personalRunLineageKey(context.consumer)
    );
  } catch {
    return false;
  }
}
/** Call for bounded control/terminal work, not per token. Every invocation
 * retains its captured physical producer; a new host needs its own event tag. */
export async function withPersonalRecoveryContext<T>(
  run: RecoveryIdentity,
  context: HostedEventPublication,
  work: () => Promise<T>,
): Promise<T> {
  const source = context.consumer;
  const matches = () =>
    !!source &&
    personalRunConsumerKey(personalRecoveryConsumer(run)) ===
      personalRunConsumerKey(source);
  if (
    !source ||
    !matches() ||
    !context.alive() ||
    (await personalRunRetired(source))
  )
    throw new Error("Private recovery source expired");
  if (!matches() || !context.alive())
    throw new Error("Private recovery source changed");
  return context.run(work);
}
