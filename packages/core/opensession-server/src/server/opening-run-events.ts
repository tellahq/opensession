import type { StreamEvent } from "./agent-runner";
import { withHostedEventPublication } from "./host-event-publication";

/** Consume before advancing the host generator, retaining each physical source's
 * authority through terminal metadata/settlement, not the opening admission's.
 */
export async function consumeOpeningRunEvents(
  events: AsyncIterable<StreamEvent>,
  personal: boolean,
  consume: (event: StreamEvent) => Promise<void>,
): Promise<void> {
  for await (const event of events)
    await withHostedEventPublication(event, () => consume(event), personal);
}
