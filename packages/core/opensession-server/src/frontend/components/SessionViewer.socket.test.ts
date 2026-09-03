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

function invocation(sourceText: string, component: string, from = 0) {
  const start = sourceText.indexOf(`<${component}`, from);
  const end = sourceText.indexOf("\n", sourceText.indexOf("/>", start));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}

test("SessionViewer receives its socket capabilities from context", async () => {
  const [viewer, pane, appContent, bindings] = await Promise.all([
    source("./SessionViewer.tsx"),
    source("./AppSessionPane.tsx"),
    source("../AppContent.tsx"),
    source("../lib/session-viewer-bindings.ts"),
  ]);
  const app = `${pane}\n${appContent}`;
  const props = interfaceBody(bindings, "SessionViewerProps");
  const lifecycle = interfaceBody(bindings, "SessionViewerLifecycleBinding");
  expect(props).not.toContain("send:");
  expect(props).not.toContain("addHandler:");
  expect(props).not.toContain("setTyping:");
  expect(props).toContain("composer: ComposerBinding;");
  expect(bindings).toContain(
    "setTyping: (sessionId: string, active: boolean) => void;",
  );
  expect(props).toContain("lifecycle: SessionViewerLifecycleBinding;");
  expect(lifecycle).toContain("connected: boolean;");
  expect(viewer).toContain(
    'import { useSessionSocket } from "../hooks/useSessionSocket";',
  );
  expect(viewer).toContain("const { send, addHandler } = useSessionSocket();");

  const viewerInvocation = invocation(app, "SessionViewer");
  expect(viewerInvocation).not.toContain("send=");
  expect(viewerInvocation).not.toContain("addHandler=");
  expect(viewerInvocation).not.toContain("setTyping=");
  expect(viewerInvocation).toContain("composer={{");
  expect(viewerInvocation).toContain("setTyping: socket.setTyping,");
  expect(viewerInvocation).toContain("lifecycle={{");
  expect(viewerInvocation).toContain(
    "connected: socket.connected && !pendingSocket,",
  );
  expect(app).toContain(
    "const pendingSocket = surfaceId === pendingSessionId;",
  );
  expect(app).toContain("socket={sessionSocket}");
  expect(app).toContain("<SessionPaneProviders");
  expect(app).toContain(
    "const sessionSocket = pendingSocket\n    ? socket.sessionSocketIgnoringMessages\n    : socket.sessionSocket;",
  );
  expect(app).toMatch(/renderSessionPane\(\s*session,\s*socket,/);
  expect(app).toMatch(/renderSessionPane\(\s*currentSession,\s*mainSocket,/);
});

test("SessionViewer delegates its session subscription once", async () => {
  const [viewer, subscription] = await Promise.all([
    source("./SessionViewer.tsx"),
    source("../hooks/useSessionViewerSubscription.ts"),
  ]);

  expect(viewer.match(/useSessionViewerSubscription\(/g)).toHaveLength(1);
  expect(viewer).not.toContain('case "transcript_init"');
  expect(viewer).not.toContain('type: "watch"');
  expect(subscription).toContain('case "transcript_init"');
  expect(subscription).toContain('case "transcript_append"');
  const register = subscription.indexOf("const unsubscribe = addHandler(");
  const watch = subscription.indexOf('type: "watch"');
  expect(register).toBeGreaterThanOrEqual(0);
  expect(watch).toBeGreaterThan(register);
});

test("SessionViewer descendants no longer receive socket props", async () => {
  const [viewerSource, mainRegion, sidePanelHost, terminal] = await Promise.all(
    [
      source("./SessionViewer.tsx"),
      source("./session-viewer/SessionViewerMainRegion.tsx"),
      source("./session/SidePanelHost.tsx"),
      source("./TerminalPanel.tsx"),
    ],
  );
  const viewer = `${viewerSource}\n${mainRegion}`;
  const prPanel = invocation(viewer, "PrPanel");
  expect(prPanel).not.toContain("send=");
  expect(prPanel).not.toContain("addHandler=");

  for (const host of [viewer, sidePanelHost]) {
    const shellPanel = invocation(host, "ShellPanel");
    expect(shellPanel).not.toContain("send=");
    expect(shellPanel).not.toContain("addHandler=");
  }

  expect(terminal).toContain(
    "const { send, addHandler } = useSessionSocket();",
  );
  const shellProps = terminal.slice(
    terminal.indexOf("export function ShellPanel"),
    terminal.indexOf(") {", terminal.indexOf("export function ShellPanel")),
  );
  expect(shellProps).not.toContain("send:");
  expect(shellProps).not.toContain("addHandler:");
});

test("the side panel shell stays mounted while another panel tab is active", async () => {
  const sidePanelHost = await source("./session/SidePanelHost.tsx");

  expect(sidePanelHost).toContain("hasWorkspace && terminalMounted");
  expect(sidePanelHost).toMatch(
    /page === "terminal"\s*\? "flex h-full min-h-0 flex-col"\s*: "hidden"/,
  );
  expect(sidePanelHost).toContain('visible={page === "terminal"}');
});

test("PrPanel keeps explicit socket injection for other hosts", async () => {
  const [prPanel, queue, reviews, workspace] = await Promise.all([
    source("./PrPanel.tsx"),
    source("./PrQueuePreview.tsx"),
    source("./Reviews.tsx"),
    source("./WorkspacePane.tsx"),
  ]);
  expect(prPanel).toContain(
    "const sessionSocket = useOptionalSessionSocket();",
  );
  expect(prPanel).toContain("const send = sendProp ?? sessionSocket?.send;");
  expect(prPanel).toContain(
    "const addHandler = addHandlerProp ?? sessionSocket?.addHandler;",
  );
  for (const host of [queue, reviews, workspace]) {
    const call = invocation(host, "PrPanel");
    expect(call).toContain("send={send}");
    expect(call).toContain("addHandler={addHandler}");
  }
});

test("useWebSocket exposes stable live and message-ignoring contexts", async () => {
  const hook = await source("../hooks/useWebSocket.ts");
  expect(hook).toContain(
    "const [sessionSocket] = useState<SessionSocket>(() => ({ send, addHandler }));",
  );
  expect(hook).toContain("const [sessionSocketIgnoringMessages]");
  expect(hook).toContain("addHandler: IGNORE_WS_MESSAGES");
  expect(hook).toContain("sessionSocketIgnoringMessages,");
});
