/**
 * A steer that the engine bounces back (`steer_failed`) has to be undone on
 * BOTH sides: the receipt says the running turn already has the message, the
 * queue says a future turn will, and only one of those can be true at a time.
 * These pin the take-back half.
 */
import { afterEach, expect, test } from "bun:test";
import { steeredReceipts, takeSteerReceiptForText } from "./queue-state";

const SESSION = "bks-steer-failed-test";

afterEach(async () => {
  await steeredReceipts.clear();
});

test("takes back the receipt a bounced steer echoes, keeping content raw", async () => {
  await steeredReceipts.set(SESSION, [
    {
      id: "r1",
      content: "we also have webhooks so maybe similar?",
      user: "Michiel",
    },
  ]);
  // What the host echoes is the attributed string steerQueuedPrompt composed.
  const item = await takeSteerReceiptForText(
    SESSION,
    "[Michiel] we also have webhooks so maybe similar?",
    false,
  );
  expect(item?.id).toBe("r1");
  // The prefix must NOT come back as part of content: a multi-item drain
  // attributes the batch again, which would send "[Michiel] [Michiel] ...".
  expect(item?.content).toBe("we also have webhooks so maybe similar?");
  expect(item?.user).toBe("Michiel");
  expect(steeredReceipts.has(SESSION)).toBe(false);
});

test("matches an unattributed steer by its raw text", async () => {
  await steeredReceipts.set(SESSION, [
    { id: "r1", content: "no attribution here" },
  ]);
  expect(
    (await takeSteerReceiptForText(SESSION, "no attribution here", false))?.id,
  ).toBe("r1");
  expect(steeredReceipts.has(SESSION)).toBe(false);
});

test("leaves unrelated receipts in place", async () => {
  await steeredReceipts.set(SESSION, [
    { id: "r1", content: "first", user: "Michiel" },
  ]);
  expect(
    await takeSteerReceiptForText(SESSION, "[Michiel] second", false),
  ).toBeUndefined();
  expect(steeredReceipts.get(SESSION)?.map((i) => i.id)).toEqual(["r1"]);
});

test("retires exactly one of two identical steers", async () => {
  await steeredReceipts.set(SESSION, [
    { id: "r1", content: "same message", user: "Michiel" },
    { id: "r2", content: "same message", user: "Michiel" },
  ]);
  expect(
    (await takeSteerReceiptForText(SESSION, "[Michiel] same message", false))
      ?.id,
  ).toBe("r1");
  expect(steeredReceipts.get(SESSION)?.map((i) => i.id)).toEqual(["r2"]);
});

test("reports nothing for a session with no receipts", async () => {
  expect(
    await takeSteerReceiptForText(SESSION, "anything", false),
  ).toBeUndefined();
});
