import { expect, test } from "bun:test";

const bindingMembers = [
  ["session", "UnifiedSession"],
  ["composer", "ComposerBinding"],
  ["availability", "SessionViewerAvailabilityBinding"],
  ["lifecycle", "SessionViewerLifecycleBinding"],
  ["chrome", "SessionViewerChromeBinding"],
  ["workspace", "SessionViewerWorkspaceBinding"],
  ["viewTabs", "SessionViewerViewTabsBinding"],
  ["subagents", "SessionViewerSubagentsBinding"],
] as const;

function interfaceBody(sourceText: string, name: string) {
  const start = sourceText.indexOf(`export interface ${name} {`);
  const end = sourceText.indexOf("\n}", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}

test("session-viewer-bindings owns the bounded SessionViewer prop API", async () => {
  const [viewer, bindings, app] = await Promise.all([
    Bun.file(
      new URL("../components/SessionViewer.tsx", import.meta.url),
    ).text(),
    Bun.file(new URL("./session-viewer-bindings.ts", import.meta.url)).text(),
    Bun.file(
      new URL("../components/AppSessionPane.tsx", import.meta.url),
    ).text(),
  ]);
  const props = interfaceBody(bindings, "SessionViewerProps");
  const topLevelMembers = props
    .split("\n")
    .filter((line) => /^  [a-zA-Z][a-zA-Z0-9]*\??[:(]/.test(line));

  expect(topLevelMembers).toHaveLength(bindingMembers.length);
  expect(topLevelMembers.length).toBeLessThanOrEqual(15);
  for (const [member, type] of bindingMembers) {
    expect(props).toContain(`  ${member}: ${type};`);
  }

  expect(viewer).toContain(
    'import type { SessionViewerProps } from "../lib/session-viewer-bindings";',
  );
  expect(viewer).toContain("}: SessionViewerProps) {");
  expect(viewer).not.toContain("interface Props {");

  const invocationStart = app.indexOf("<SessionViewer\n");
  const invocationEnd = app.indexOf("\n      />", invocationStart);
  expect(invocationStart).toBeGreaterThanOrEqual(0);
  expect(invocationEnd).toBeGreaterThan(invocationStart);
  const invocation = app.slice(invocationStart, invocationEnd);
  for (const [member] of bindingMembers.slice(1)) {
    expect(invocation).toContain(`${member}={{`);
  }
});
