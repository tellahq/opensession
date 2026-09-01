import { expect, test } from "bun:test";

async function source(relativePath: string) {
  return Bun.file(new URL(relativePath, import.meta.url)).text();
}

function interfaceBody(sourceText: string, name: string) {
  const start = sourceText.indexOf(`export interface ${name} {`);
  const end = sourceText.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}

test("SessionViewer receives app-owned composer wiring through one binding", async () => {
  const [viewer, app, binding] = await Promise.all([
    source("../SessionViewer.tsx"),
    source("../../App.tsx"),
    source("../../lib/session-viewer-bindings.ts"),
  ]);

  const props = interfaceBody(binding, "SessionViewerProps");
  expect(viewer).toContain(
    'import type { SessionViewerProps } from "../lib/session-viewer-bindings";',
  );
  expect(props).toContain("composer: ComposerBinding;");
  for (const oldProp of [
    "setTyping:",
    "newSessionSeq?:",
    "autoFocusComposer?:",
    "composerPrefillExternal?:",
    "onComposerPrefillConsumed?:",
  ]) {
    expect(props).not.toContain(oldProp);
  }

  expect(binding).toContain("export interface ComposerBinding {");
  expect(binding).toContain(
    "setTyping: (sessionId: string, active: boolean) => void;",
  );
  expect(binding).toContain("resetSeq?: number;");
  expect(binding).toContain("autoFocus?: boolean;");
  expect(binding).toContain("prefill?: { seq: number; text: string } | null;");
  expect(binding).toContain("onPrefillConsumed?: (seq: number) => void;");

  const invocationStart = app.indexOf("<SessionViewer\n");
  const invocationEnd = app.indexOf("\n        />", invocationStart);
  const invocation = app.slice(invocationStart, invocationEnd);
  expect(invocationStart).toBeGreaterThanOrEqual(0);
  expect(invocationEnd).toBeGreaterThan(invocationStart);
  expect(invocation).toContain("composer={{");
  expect(invocation).toContain("setTyping: socket.setTyping,");
  expect(invocation).toContain("resetSeq: focused ? newSessionSeq : 0,");
  expect(invocation).toContain("autoFocus: focused && focusComposerOnOpen,");
  expect(invocation).toContain(
    "prefill: sessionComposerPrefills[viewerSession.id] ?? null,",
  );
  expect(invocation).toContain("onPrefillConsumed: (seq) =>");
  for (const oldProp of [
    "setTyping=",
    "newSessionSeq=",
    "autoFocusComposer=",
    "composerPrefillExternal=",
    "onComposerPrefillConsumed=",
  ]) {
    expect(invocation).not.toContain(oldProp);
  }
});
