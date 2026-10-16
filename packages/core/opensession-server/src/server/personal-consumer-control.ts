import { verifyPersonalRunHostHelper } from "../executor/host-unit";
import {
  personalRunConsumerKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-consumers";

export interface PersonalHostStopReceipt {
  readonly state: "absent";
  readonly consumer: PersonalRunConsumer;
}

export interface PersonalConsumerControlDependencies {
  /** Must fence queued dispatch and positively observe the exact original
   * physical host. A cancellation latch or an empty process cache is not proof.
   * This callback must not enter the credential broker, including via post-run
   * publication/cleanup: the revoker can already own that broker's lane. */
  stopAndConfirm(
    consumer: PersonalRunConsumer,
  ): Promise<PersonalHostStopReceipt>;
  /** Test seam; production uses the fixed privileged helper capability probe. */
  verifyHelper?: () => Promise<void>;
}

/** Deliberately requires a real physical implementation. There is no legacy
 * cancelAgentRunAndWait, shared-host fallback, or default successful no-op. */
export function createPersonalConsumerControl(
  dependencies: PersonalConsumerControlDependencies,
) {
  if (typeof dependencies.stopAndConfirm !== "function")
    throw new Error("Personal physical run control unavailable");
  const stopAndConfirm = dependencies.stopAndConfirm;
  return {
    async assertRuntimeReady(): Promise<void> {
      await (dependencies.verifyHelper ?? verifyPersonalRunHostHelper)();
    },
    async cancelAndConfirm(consumer: PersonalRunConsumer): Promise<void> {
      const original = snapshotPersonalRunConsumer(consumer);
      const key = personalRunConsumerKey(original);
      const receipt = await stopAndConfirm(original);
      if (
        !receipt ||
        receipt.state !== "absent" ||
        personalRunConsumerKey(receipt.consumer) !== key
      )
        throw new Error("Personal physical run completion unconfirmed");
      // The catalog owner persists completion before dropping cleanup
      // enrollment. This adapter neither retires authority nor rewrites journals.
    },
  };
}
