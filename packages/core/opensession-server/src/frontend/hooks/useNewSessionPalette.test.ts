import { expect, test } from "bun:test";

const appSource = await Promise.all([
  Bun.file(new URL("../AppContent.tsx", import.meta.url)).text(),
  Bun.file(new URL("useAppGlobalHotkeys.ts", import.meta.url)).text(),
  Bun.file(new URL("useSessionTabs.tsx", import.meta.url)).text(),
  Bun.file(new URL("useNewSessionCreateStart.ts", import.meta.url)).text(),
]).then((sources) => sources.join("\n"));
const hookSource = await Bun.file(
  new URL("./useNewSessionPalette.ts", import.meta.url),
).text();

test("App delegates palette state and keyboard ownership to one hook", () => {
  expect(appSource.match(/= useNewSessionPalette\(\{/g)).toHaveLength(1);
  expect(appSource).not.toContain("setPaletteState");
  expect(appSource).not.toContain("primeSoftKeyboard");

  const closeStart = appSource.indexOf("const closePalette = () =>");
  const closeEnd = appSource.indexOf("const startNewSessionCreate", closeStart);
  const close = appSource.slice(closeStart, closeEnd);

  expect(closeStart).toBeGreaterThan(-1);
  expect(close).toContain("hidePalette();");
  expect(close).toContain('stripBasePath(location.pathname) === "/new"');
  expect(close).toContain("goBack()");
});

test("the hook owns lazy route initialization and every replacement open", () => {
  expect(hookSource).toContain(
    "const [palette, setPaletteState] = useState<NewSessionPaletteState>(() =>",
  );
  expect(hookSource).toContain("initiallyOpen");
  expect(hookSource).toContain("prompt: initialPrompt");

  const openStart = hookSource.indexOf("const openPalette =");
  const openEnd = hookSource.indexOf("const hidePalette =", openStart);
  const opens = hookSource.slice(openStart, openEnd);

  expect(openStart).toBeGreaterThan(-1);
  expect(opens.match(/setPalette\(/g)).toHaveLength(2);
  expect(opens).not.toContain("setPaletteState");
  expect(opens).not.toContain("workspaceId: modelWorkspaceId");
  expect(opens).toContain("setPalette({ open: true, ...prefill })");
});

test("hide and failure restoration preserve state with the right keyboard behavior", () => {
  const hideStart = hookSource.indexOf("const hidePalette =");
  const restoreStart = hookSource.indexOf("const restorePalette =", hideStart);
  const returnStart = hookSource.indexOf("return {", restoreStart);
  const hide = hookSource.slice(hideStart, restoreStart);
  const restore = hookSource.slice(restoreStart, returnStart);

  expect(hide).toContain(
    "setPaletteState((current) => ({ ...current, open: false }))",
  );
  expect(hide).not.toContain("primeSoftKeyboard");
  expect(restore).toContain("primeSoftKeyboard();");
  expect(restore).toContain(
    "setPaletteState((current) => ({ ...current, open: true }))",
  );
  expect(restore.indexOf("primeSoftKeyboard()")).toBeLessThan(
    restore.indexOf("setPaletteState"),
  );
});

test("paletteOpenRef is layout-synchronized and the module exports only the hook", () => {
  expect(hookSource).toContain("const paletteOpenRef = useRef(palette.open)");
  expect(hookSource).toContain("useLayoutEffect(() => {");
  expect(hookSource).toContain("paletteOpenRef.current = palette.open");
  expect(hookSource.match(/\bexport\b/g)).toHaveLength(1);
  expect(hookSource).toContain("export function useNewSessionPalette");
});

test("App keeps Escape dismissal and workspace prefills on the controller", () => {
  const hotkeyStart = appSource.indexOf("const hotkeyOpenPalette");
  const hotkeyEnd = appSource.indexOf(
    "// The list is the live slice",
    hotkeyStart,
  );
  const hotkeys = appSource.slice(hotkeyStart, hotkeyEnd);
  expect(hotkeys).toContain(
    "else if (paletteOpenRef.current) hotkeyClosePalette()",
  );

  const workspaceOpenStart = appSource.indexOf(
    "function openNewSessionInWorkspace",
  );
  const workspaceOpenEnd = appSource.indexOf(
    "const siblingCreateRef",
    workspaceOpenStart,
  );
  const workspaceOpen = appSource.slice(workspaceOpenStart, workspaceOpenEnd);
  expect(workspaceOpen).toContain("openPrefilledSession(prefill);");
  expect(workspaceOpen).toContain("prefill.workspaceId = src.workspaceId");
  expect(workspaceOpen).toContain("prefill.modelWorkspaceId = src.workspaceId");
});
