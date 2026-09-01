import { expect, test } from "bun:test";

test("the Desk modal keeps its full conversation until Clear chat", async () => {
  const conversation = await Bun.file(
    new URL("./DeskConversation.tsx", import.meta.url),
  ).text();
  const overlay = await Bun.file(
    new URL("./DeskOverlay.tsx", import.meta.url),
  ).text();

  // The expanded session and the modal now share one durable conversation.
  // Only the explicit clear marker may hide rows in the modal.
  expect(conversation).not.toContain("staleAfterMs");
  expect(conversation).not.toContain("staleCutoff");
  expect(conversation).not.toContain("Show earlier conversation");
  expect(overlay).not.toContain("staleAfterMs");
  // Transcript virtualization must bind to the modal's own scrolling pane.
  expect(conversation).toContain(
    '"viewer-messages min-h-0 flex-1 overflow-y-auto',
  );
  expect(conversation).toContain(
    "entries.filter((e) => !e.timestamp || e.timestamp > hideBefore)",
  );
});
