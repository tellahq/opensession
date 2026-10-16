import type { StreamEvent } from "./agent-runner";

export interface HostedEventPublication {
  readonly consumer?: import("./personal-run-consumers").PersonalRunConsumer;
  readonly personal: boolean;
  readonly alive: () => boolean;
  run<T>(work: () => T): T;
}
// Internal only: JSON omits symbols while normal object spread preserves this
// tag through stream adapters. Never infer a new owner from an untagged event.
const publication = Symbol.for("opensession.host-event-publication.v1");
type Tagged = StreamEvent & { [publication]?: HostedEventPublication };
export function tagHostedEvent(
  event: StreamEvent,
  context: HostedEventPublication,
): StreamEvent {
  return { ...event, [publication]: context } as Tagged;
}
export function hostedEventPublication(
  event: StreamEvent,
): HostedEventPublication | undefined {
  return (event as Tagged)[publication];
}
export function withHostedEventPublication<T>(
  event: StreamEvent,
  work: () => T,
  requirePersonal = false,
): T | undefined {
  const context = (event as Tagged)[publication];
  if (!context) {
    if (requirePersonal)
      throw new Error("Private hosted event has no source context");
    return work();
  }
  if (requirePersonal && !context.personal)
    throw new Error("Private hosted event has a shared source");
  if (!context.alive()) return undefined;
  return context.run(work);
}
