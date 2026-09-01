import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useRunningCloseConfirmation.ts", import.meta.url),
).text();
const lifecycleSource = await Bun.file(
  new URL("useSessionLifecycle.ts", import.meta.url),
).text();
const workspaceMutationsSource = await Bun.file(
  new URL("useWorkspaceMutations.ts", import.meta.url),
).text();
const dialogSource = await Bun.file(
  new URL("../components/RunningCloseDialog.tsx", import.meta.url),
).text();

describe("running close confirmation ownership", () => {
  test("delegates the controller once and renders its dialog in App", () => {
    expect(appSource.match(/useRunningCloseConfirmation\(\)/g)).toHaveLength(1);
    expect(appSource).toContain("dialog: runningCloseDialog");
    expect(appSource).toContain(
      "<RunningCloseDialog {...runningCloseDialog} />",
    );
    expect(appSource).not.toContain("setRunningCloseConfirmation");
    expect(appSource).not.toContain("Close running session");
  });

  test("keeps the existing running-session gates at their owners", () => {
    expect(lifecycleSource).toContain(
      "confirmRunningClose(s, () => void closeSessionNow(s))",
    );
    expect(lifecycleSource).toContain(
      "confirmRunningClose(s, () => void archive())",
    );
    expect(lifecycleSource).toContain(
      "confirmRunningCloses(sessions, () => void archive())",
    );
    expect(workspaceMutationsSource).toContain(
      "confirmRunningCloses(members, () => {",
    );
    expect(workspaceMutationsSource).toContain(
      "confirmRunningCloses(sessions, () => void archive())",
    );
  });

  test("confirms synchronously when no session is running", () => {
    expect(hookSource).toContain(
      "if (!runningCount) {\n      onConfirm();\n      return;\n    }",
    );
  });

  test("retains the command-enter listener and clear-first ordering", () => {
    expect(hookSource).toContain('event.key !== "Enter"');
    expect(hookSource).toContain("event.metaKey || event.ctrlKey");
    expect(hookSource).toContain(
      'window.addEventListener("keydown", onKeyDown)',
    );
    expect(hookSource).toContain(
      "setRunningCloseConfirmation(null);\n      confirmation.onConfirm();",
    );
    expect(hookSource).toContain(
      "setRunningCloseConfirmation(null);\n    confirmation?.onConfirm();",
    );
  });

  test("keeps the dialog copy and keyboard hint", () => {
    expect(dialogSource).toContain('{runningCount === 1 ? "" : "s"}?');
    expect(dialogSource).toContain(
      "This session is currently running. Closing it will cancel its current run.",
    );
    expect(dialogSource).toContain(
      "These ${runningCount ?? 0} sessions are currently running. Closing them will cancel their current runs.",
    );
    expect(dialogSource).toContain("⌘↵");
  });

  test("keeps both new modules single-export", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain(
      "export function useRunningCloseConfirmation()",
    );
    expect(dialogSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(dialogSource).toContain("export function RunningCloseDialog(");
  });
});
