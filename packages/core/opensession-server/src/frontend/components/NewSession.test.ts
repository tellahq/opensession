import { expect, test } from "bun:test";

test("a long phone prompt scrolls without moving the title bar or send button", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const motionStart = source.indexOf(
    "<motion.div",
    source.indexOf("const card ="),
  );
  const promptStart = source.indexOf("<NewSessionPrompt", motionStart);
  const layout = source.slice(motionStart, promptStart);

  expect(motionStart).toBeGreaterThan(-1);
  expect(layout).toContain('"relative flex min-h-0 flex-col"');
  expect(layout).toContain('"flex min-h-0 flex-1 flex-col"');
});

test("the phone footer drops the covered safe-area inset while the keyboard is open", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const footerStart = source.indexOf("const FOOTER =");
  const footerEnd = source.indexOf(";", footerStart);
  const footer = source.slice(footerStart, footerEnd);

  expect(footerStart).toBeGreaterThan(-1);
  expect(footer).toContain(
    "phone:pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
  );
  expect(footer).toContain("phone:[body.kb-open_&]:pb-3");
});

test("the phone title bar's project trigger carries no surface of its own", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const triggerStart = source.indexOf("const MOBILE_TRIGGER =");
  const triggerEnd = source.indexOf(";", triggerStart);
  const trigger = source.slice(triggerStart, triggerEnd);

  expect(triggerStart).toBeGreaterThan(-1);
  expect(trigger).not.toContain("phone:bg-");
  expect(trigger).not.toContain("phone:border");
  // Still a 44px target, even without a surface to show for it.
  expect(trigger).toContain("phone:min-h-11");
});

test("the new composer keeps the full model name ahead of its effort suffix", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const pillStart = source.indexOf("const MODEL_PILL");
  const pillEnd = source.indexOf(");", pillStart);
  const pill = source.slice(pillStart, pillEnd);

  expect(pillStart).toBeGreaterThan(-1);
  expect(pill).toContain("max-w-none");
  expect(pill).toContain("phone:[&_[data-effort]]:hidden");
  expect(pill).not.toContain("max-w-[150px]");
});

test("the new composer uses the shared model settings component with every axis", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const pickerStart = source.indexOf("<ModelEffortSelect");
  const pickerEnd = source.indexOf("/>", pickerStart);
  const picker = source.slice(pickerStart, pickerEnd);

  expect(pickerStart).toBeGreaterThan(-1);
  expect(picker).toContain("effort,");
  expect(picker).toContain("changeEffort: setEffort");
  expect(picker).toContain("fastMode,");
  expect(picker).toContain("changeFastMode: setFastMode");
  expect(picker).toContain("accounts,");
  expect(picker).toContain("accountId,");
  expect(picker).toContain("changeAccount: setAccountId");
});

test("the new session payload persists fast mode", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf('type: "create_session"');
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createPayload = source.slice(createStart, createEnd);

  expect(createStart).toBeGreaterThan(-1);
  expect(createEnd).toBeGreaterThan(createStart);
  expect(createPayload).toContain("...(fastMode ? { fastMode: true } : {})");
});

test("a new session sends the person's checkout preference", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf('type: "create_session"');
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createPayload = source.slice(createStart, createEnd);

  expect(createPayload).toContain(
    'checkoutMode: startPoint.kind === "new" ? checkoutPref : "worktree"',
  );
  expect(source).toContain("!startsInLocalCheckout");
});

test("a pull request start checks out its existing branch and adopts its workspace", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf("function handleCreate()");
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createHandler = source.slice(createStart, createEnd);

  expect(source).toContain("<NewSessionPrPicker");
  expect(createHandler).toContain("findPrWorkspaceId(workspaces, sessions");
  expect(createHandler).toContain("startPoint.pullRequest.branch");
  expect(createHandler).toContain(
    "selectedPullRequest ? { fromPr: true } : {}",
  );
  expect(createHandler).toContain("PR #${selectedPullRequest.number}");
});

test("the default create exposes its deterministic session id immediately", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf("function handleCreate()");
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createHandler = source.slice(createStart, createEnd);

  expect(createHandler).toContain(
    "const clientSessionId = newClientSessionId()",
  );
  expect(createHandler).toContain("id: clientSessionId");
  expect(createHandler).toContain(
    'createAction === "open" ? { openImmediately: true }',
  );
  expect(createHandler).toContain("onCreateStarted?.(optimisticCreate)");
});

test("immediate create consumes the sent draft before opening the session", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf("function handleCreate()");
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createHandler = source.slice(createStart, createEnd);

  const sent = createHandler.indexOf("send(createMessage)");
  const drop = createHandler.indexOf("dropPendingDraftWrite()");
  const clear = createHandler.indexOf("clearDraft(DRAFT_KEY)");
  const empty = createHandler.indexOf('setText("")');
  const handoff = createHandler.indexOf("onCreateStarted?.(optimisticCreate)");
  expect(sent).toBeGreaterThan(-1);
  expect(sent).toBeLessThan(drop);
  expect(drop).toBeLessThan(clear);
  expect(clear).toBeLessThan(empty);
  expect(empty).toBeLessThan(handoff);
  expect(createHandler).not.toContain("saveDraft(DRAFT_KEY, { text: prompt })");
});

test("a failed immediate create restores the submitted composer payload", async () => {
  const source = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
  const errorStart = source.indexOf('if (msg.type === "error")');
  const errorEnd = source.indexOf(
    'if (msg.type === "pins_changed")',
    errorStart,
  );
  const recovery = source.slice(errorStart, errorEnd);

  expect(recovery).toContain("saveDraft(NEW_SESSION_DRAFT_KEY, {");
  expect(recovery).toContain("text: draft.prompt");
  expect(recovery).toContain("images: draft.images ?? []");
  expect(recovery).toContain("files: draft.files ?? []");
  expect(recovery).toContain("restorePalette()");
  expect(recovery.indexOf("saveDraft(NEW_SESSION_DRAFT_KEY")).toBeLessThan(
    recovery.indexOf("restorePalette()"),
  );
});

test("the new session title uses the visible names of pasted session links", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf('type: "create_session"');
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createPayload = source.slice(createStart, createEnd);

  expect(createPayload).toContain(
    "titlePrompt: projectComposerSessions(prompt).displayText",
  );
});

test("the floating composer owns app-wide file drops", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();

  expect(source).toContain('data-global-file-composer="new-session"');
  expect(source).toContain("foregroundFileComposerOwns(composer)");
  expect(source).toContain("const addDroppedAttachments = useEffectEvent");
  expect(source).toContain("addDroppedAttachments(dropped)");
  expect(source).toContain(
    "<FullPageFileDropOverlay active={fileDragActive} />",
  );
});

test("dismissing a nonempty composer parks it without an explicit draft action", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const closeStart = source.indexOf("onOpenChange={(next) =>");
  const closeEnd = source.indexOf('modal="trap-focus"', closeStart);
  const closeHandler = source.slice(closeStart, closeEnd);

  expect(closeStart).toBeGreaterThan(-1);
  expect(closeHandler).toContain("if (next || busy) return;");
  expect(closeHandler).toContain("void parkDraftOnExit();");
  expect(closeHandler.indexOf("void parkDraftOnExit();")).toBeLessThan(
    closeHandler.indexOf("onBack();"),
  );
  const createStart = source.indexOf("function handleCreate()");
  const sendStart = source.indexOf("send({", createStart);
  const createHandler = source.slice(createStart, sendStart);
  expect(createHandler).toContain(
    "consumePendingDraftParks(prompt, workspaceId, createWorkspaceId);",
  );
  expect(source).not.toContain('action: "draft"');
  expect(source).not.toContain("Save as draft");
});

test("the phone composer keeps its buttons concentric with the sheet corner", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();

  expect(source).toContain("<PhoneTopBar");
  expect(source).toContain("<PhoneTopBarAction");
  expect(source).toContain("phone:rounded-t-[calc(40px*var(--rf))]");
  expect(source).toContain("phone:px-[18px] phone:pb-3 phone:pt-[18px]");
});

test("a parked draft keeps the composer copy and carries its attachments", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const parkStart = source.indexOf("async function parkDraftOnExit()");
  const parkEnd = source.indexOf("const createRef", parkStart);
  const park = source.slice(parkStart, parkEnd);

  expect(parkStart).toBeGreaterThan(-1);
  // Leaving copies the draft, it never empties the composer.
  expect(park).not.toContain('saveDraft(DRAFT_KEY, { text: "" })');
  // The workspace composer reads staged files from its own draft key.
  expect(park).toContain("saveDraft(workspaceDraftKey(workspace.id), {");
  expect(park).toContain("images: staged.images,");
  expect(park).toContain("files: staged.files,");
  // Closing twice updates the workspace the first close made.
  expect(park).toContain("getParkedNewSessionWorkspaceId()");
  expect(park).toContain("rememberParkedNewSessionWorkspace(workspace.id)");
});

test("creating a reopened composer consumes its parked draft workspace", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const createStart = source.indexOf("function handleCreate()");
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createHandler = source.slice(createStart, createEnd);
  const successStart = source.indexOf("const handleCreationMessage");
  const successEnd = source.indexOf(
    "// Re-send the same client-minted id",
    successStart,
  );
  const successHandler = source.slice(successStart, successEnd);

  expect(createHandler).toContain("getParkedNewSessionWorkspaceId()");
  expect(createHandler).toContain(
    "{ workspaceId: createWorkspaceId, worktreeMode }",
  );
  expect(createHandler).toContain("{ workspaceId: createWorkspaceId }");
  expect(successHandler).toContain(
    "consumeNewSessionWorkspaceDraft(consumedWorkspaceId)",
  );
});

test("a late re-park clears rather than deletes an adopted workspace", async () => {
  const source = await Bun.file(
    new URL("./NewSession.tsx", import.meta.url),
  ).text();
  const parkStart = source.indexOf("async function parkDraftOnExit()");
  const parkEnd = source.indexOf("function handleCreate()", parkStart);
  const park = source.slice(parkStart, parkEnd);

  expect(park).toContain("operation.consumedIntoWorkspaceId === workspace.id");
  expect(
    park.indexOf("updateWorkspaceApi(workspace.id, { draft: null })"),
  ).toBeLessThan(park.indexOf("deleteWorkspaceApi(workspace.id)"));
});
