import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useNavigation } from "../hooks/useNavigation";
import type { NavigationActions } from "../lib/navigation";
import { NavigationProvider } from "./NavigationProvider";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const providerSource = await Bun.file(
  new URL("./NavigationProvider.tsx", import.meta.url),
).text();

function navigationFixture(openPrs: () => void): NavigationActions {
  return {
    goBack() {},
    openNextChat() {},
    openPrs,
    openFeed() {},
    openSettings() {},
    openTasks() {},
    openAutomation() {},
    async openPrItem() {},
    openPlain() {},
    openSupportTinder() {},
    openReports() {},
    openAnalytics() {},
    openArchived() {},
    openCatchUp() {},
    openSession() {},
    openWorkspace() {},
    openSessionReview() {},
    async openTicket() {},
    async openFeedItem() {},
    openPr() {},
    openNewWorkspace() {},
    openNewSessionInRepo() {},
    openDraft() {},
    async openNewSessionInWorkspace() {},
    async duplicateSession() {},
    startNewChat() {},
    openPrefilledSession() {},
    openReview() {},
    openStaging() {},
    openPreview() {},
    openPortal() {},
    openAssets() {},
    openTerminal() {},
    openCurrentWorkspace() {},
  };
}

function OpenPrsConsumer() {
  useNavigation().openPrs();
  return <span>Opened</span>;
}

function ConsumerWithoutProvider() {
  useNavigation();
  return null;
}

describe("NavigationProvider", () => {
  test("App provides one compiler-stabilized typed actions object", () => {
    const actionsStart = appSource.indexOf("  const navigationActions = {");
    const actionsEnd = appSource.indexOf("\n\n  const content =", actionsStart);

    expect(actionsStart).toBeGreaterThan(-1);
    expect(actionsEnd).toBeGreaterThan(actionsStart);
    expect(appSource.slice(actionsStart, actionsEnd)).toContain(
      "} satisfies NavigationActions;",
    );
    expect(appSource.match(/<NavigationProvider\b/g)).toHaveLength(1);
    expect(appSource).toContain(
      "<NavigationProvider actions={navigationActions}>",
    );
  });

  test("forwards actions directly without a hand-built stable proxy", () => {
    expect(providerSource).toMatch(
      /<NavigationContext value=\{actions\}>\{children\}<\/NavigationContext>/,
    );
    expect(providerSource).not.toContain("actions.");
    expect(providerSource).not.toContain("actionsRef");
    expect(providerSource).not.toContain("stableActions");
    expect(providerSource).not.toContain("value={{");

    for (const hook of [
      "useLayoutEffect",
      "useMemo",
      "useCallback",
      "React.memo",
      "useState",
      "useRef",
    ]) {
      expect(providerSource).not.toContain(hook);
    }
  });

  test("forwards actions to children", () => {
    let calls = 0;
    const actions = navigationFixture(() => {
      calls += 1;
    });

    expect(
      renderToStaticMarkup(
        <NavigationProvider actions={actions}>
          <OpenPrsConsumer />
        </NavigationProvider>,
      ),
    ).toBe("<span>Opened</span>");
    expect(calls).toBe(1);
  });

  test("fails closed outside the provider", () => {
    expect(() => renderToStaticMarkup(<ConsumerWithoutProvider />)).toThrow(
      "useNavigation must be used within NavigationProvider",
    );
  });
});
