import { expect, test } from "bun:test";
import {
  createPersonalConsumerControl,
  type PersonalHostStopReceipt,
} from "./personal-consumer-control";
import {
  personalRunConsumerKey,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import { personalRepositoryId } from "./personal-repository-coordinator";

function consumer(): PersonalRunConsumer {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 41,
    repositoryOwnerGithubAccountId: 41,
    appRecordId: "app-original",
    githubAppId: 101,
    installationId: 201,
    repositoryId: 301,
    accessRevision: 1,
    fullName: "fixture/private",
  };
  return {
    runKey: "dispatch-original",
    hostId: "rh-original",
    sessionId: "session-original",
    binding: { registryId: personalRepositoryId(descriptor), descriptor },
  };
}

test("readiness requires a real control and propagates helper incompatibility", async () => {
  expect(() => createPersonalConsumerControl({} as never)).toThrow(
    "unavailable",
  );
  let probes = 0;
  const control = createPersonalConsumerControl({
    stopAndConfirm: async (original) => ({
      state: "absent",
      consumer: original,
    }),
    verifyHelper: async () => {
      probes++;
      throw new Error("old helper");
    },
  });
  await expect(control.assertRuntimeReady()).rejects.toThrow("old helper");
  expect(probes).toBe(1);
});

test("queued dispatch/cancel remains pending until physical control proves completion", async () => {
  const dispatchSettled = Promise.withResolvers<void>();
  const physicalAbsent = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let confirmed = false;
  const control = createPersonalConsumerControl({
    stopAndConfirm: async (original) => {
      entered.resolve();
      await dispatchSettled.promise;
      await physicalAbsent.promise;
      return { state: "absent", consumer: original };
    },
  });
  const stopping = control.cancelAndConfirm(consumer()).then(() => {
    confirmed = true;
  });
  await entered.promise;
  expect(confirmed).toBe(false);
  dispatchSettled.resolve();
  await Promise.resolve();
  expect(confirmed).toBe(false);
  physicalAbsent.resolve();
  await stopping;
  expect(confirmed).toBe(true);
});

test("unknown, latch-only, or empty-cache receipts are not confirmation", async () => {
  for (const receipt of [
    undefined,
    true,
    { state: "unknown", consumer: consumer() },
    { state: "completed", consumer: consumer() },
  ]) {
    const control = createPersonalConsumerControl({
      stopAndConfirm: async () => receipt as unknown as PersonalHostStopReceipt,
    });
    await expect(control.cancelAndConfirm(consumer())).rejects.toThrow();
  }
});

test("physical observation failure propagates so enrollment remains retryable", async () => {
  const control = createPersonalConsumerControl({
    stopAndConfirm: async () => {
      throw new Error("observation unavailable");
    },
  });
  await expect(control.cancelAndConfirm(consumer())).rejects.toThrow(
    "observation unavailable",
  );
});

test("proof for a successor or different binding never acknowledges the original", async () => {
  for (const change of [
    (v: PersonalRunConsumer) => {
      v.hostId = "rh-successor";
    },
    (v: PersonalRunConsumer) => {
      v.runKey = "dispatch-successor";
    },
    (v: PersonalRunConsumer) => {
      v.sessionId = "session-successor";
    },
    (v: PersonalRunConsumer) => {
      v.binding = {
        ...v.binding,
        descriptor: { ...v.binding.descriptor, accessRevision: 2 },
      };
    },
  ]) {
    const successor = consumer();
    change(successor);
    const control = createPersonalConsumerControl({
      stopAndConfirm: async () => ({ state: "absent", consumer: successor }),
    });
    await expect(control.cancelAndConfirm(consumer())).rejects.toThrow(
      "unconfirmed",
    );
  }
});

test("captures immutable identity before awaiting and allows display-only rename", async () => {
  const input = consumer();
  const key = personalRunConsumerKey(input);
  const pending = Promise.withResolvers<void>();
  const control = createPersonalConsumerControl({
    stopAndConfirm: async (original) => {
      expect(Object.isFrozen(original)).toBe(true);
      expect(Object.isFrozen(original.binding.descriptor)).toBe(true);
      await pending.promise;
      expect(personalRunConsumerKey(original)).toBe(key);
      return {
        state: "absent",
        consumer: {
          ...original,
          binding: {
            ...original.binding,
            descriptor: {
              ...original.binding.descriptor,
              fullName: "fixture/renamed",
            },
          },
        },
      };
    },
  });
  const stopping = control.cancelAndConfirm(input);
  input.hostId = "rh-successor";
  pending.resolve();
  await stopping;
});
