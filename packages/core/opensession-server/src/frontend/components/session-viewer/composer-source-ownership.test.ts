import { expect, test } from "bun:test";

const frontendRoot = new URL("../../", import.meta.url);

async function source(relativePath: string) {
  return Bun.file(new URL(relativePath, frontendRoot)).text();
}

function interfaceMemberCount(sourceText: string, name: string) {
  const start = sourceText.indexOf(`interface ${name} {`);
  const end = sourceText.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end).split(";").length - 1;
}

test("SessionViewer composer owners stay bounded", async () => {
  const [viewer, controller, send] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("hooks/useSessionComposerController.ts"),
    source("lib/session-viewer-send.ts"),
  ]);

  for (const [path, text] of [
    ["components/SessionViewer.tsx", viewer],
    ["hooks/useSessionComposerController.ts", controller],
    ["lib/session-viewer-send.ts", send],
  ] as const) {
    const lineCount = text.split("\n").length;
    expect(
      lineCount,
      `${path} has ${lineCount} physical lines`,
    ).toBeLessThanOrEqual(1_999);
  }

  for (const [text, names] of [
    [
      controller,
      [
        "SessionComposerDraftOptions",
        "SessionPromptOutboxOptions",
        "PendingReconciliationOptions",
        "SessionAttachmentDropOptions",
      ],
    ],
    [send, ["SendSessionMessageOptions"]],
  ] as const) {
    for (const name of names)
      expect(interfaceMemberCount(text, name), name).toBeLessThanOrEqual(15);
  }
  expect(controller).not.toMatch(/\buse(?:Memo|Callback)\(/);
});

test("SessionViewer keeps memo wrappers and delegates composer bodies", async () => {
  const [viewer, viewState, conversation] = await Promise.all([
    source("components/SessionViewer.tsx"),
    source("hooks/useSessionViewStateController.ts"),
    source("hooks/useSessionConversationState.ts"),
  ]);
  expect(viewState.indexOf("useSessionComposerDraft({")).toBeLessThan(
    viewState.indexOf("useSessionRuntime({"),
  );
  expect(conversation).toContain(
    "return sendSessionMessage(raw, opts, isolatedImages, message);",
  );
  expect(viewer).not.toContain("const sendStartedAt = performance.now();");
  expect(conversation).toContain(
    "const editSentMessageInComposer = useCallback(",
  );
  expect(conversation).toContain("[hasDraft],");
});
