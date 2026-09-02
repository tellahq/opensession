import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
const serverDir = resolve(import.meta.dir, "..");
const read = (relative: string) =>
  readFileSync(join(serverDir, relative), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("single session ownership", () => {
  test("runtime metadata readers do not run the synchronous full-history scanner", () => {
    for (const file of [
      "runner-portals.ts",
      "session-control-wiring.ts",
      "transcript-orphan-sweep.ts",
      "routes/mention-palette.ts",
      "routes/sessions.ts",
      "routes/workspace.ts",
    ]) {
      expect(read(file)).not.toContain("getAllSessions(");
    }
  });

  test("production has no legacy gateway mailbox", () => {
    const production = sourceFiles(serverDir)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toContain(".dispatchLegacy(");
    expect(production).not.toContain("legacyGatewayEffect(");
    expect(production).not.toContain(".runExclusive(");
    expect(read("session-kernel/actor-protocol.ts")).not.toContain(
      't: "begin"',
    );
    expect(read("session-kernel/actor-worker.ts")).not.toContain("waiters");
  });

  test("request-path health never scans every session actor database", () => {
    const kernel = read("session-kernel/kernel.ts");
    const health = kernel.slice(
      kernel.indexOf("export async function sessionKernelHealth"),
      kernel.indexOf("export async function maintainSessionKernel"),
    );
    expect(health).toContain("sessionKernelReadinessSnapshot()");
    expect(health).not.toContain("statsAsync");
    expect(health).not.toContain(".stats()");
  });

  test("online kernel code cannot fan out across every actor database", () => {
    const host = read("session-kernel/store-host.ts");
    const routing = read("session-kernel/store-routing.ts");
    for (const helper of [
      "mapIsolatedReadStores",
      "mapReadStores",
      "mapIsolatedStores",
      "mapStores",
    ])
      expect(host).not.toContain(helper);
    expect(host).not.toContain("isolatedSessionPlacements(");
    expect(host).not.toContain("repairSparseProjections");
    const maintenance = host.slice(
      host.indexOf("  maintain(): boolean"),
      host.indexOf("  private openTranscript"),
    );
    expect(maintenance).not.toContain("openIsolated");
    expect(maintenance).not.toContain("storeForSession");
    expect(maintenance).not.toContain("isolatedOutboxRoutes");
    expect(read("session-kernel/store.ts")).not.toContain(
      "isolatedSessionPlacements(",
    );
    for (const legacyGlobal of [
      '"runStates"',
      '"dueTimers"',
      '"pendingOutbox"',
      '"retryCompatibleCreationBranchDeadLetters"',
    ])
      expect(routing).not.toContain(legacyGlobal);
  });

  test("runtime work claims on session lanes without a fleet barrier", () => {
    const service = read("session-kernel/actor-service.ts");
    const worker = read("session-kernel/actor-worker.ts");
    const host = read("session-kernel/store-host.ts");
    expect(service).toContain('request.t === "runtime_work"');
    expect(service).toContain("runtimeWorkRequest(request");
    expect(service).toMatch(/enqueueSession\(\s*sessionId,/);
    expect(worker).toContain('request.t === "runtime_session_work"');
    expect(host).toContain("runtimeCatalogWork(");
    expect(host).toContain("runtimeSessionWork(");
    expect(host).not.toContain("runtimeWork(");
  });

  test("workflow agents cannot execute inside the gateway control plane", () => {
    const workflow = read("workflow-execute.ts");
    expect(workflow).toContain("runAuxiliaryAgentHosted");
    expect(workflow).toContain('transcriptTarget: "none"');
    expect(workflow).not.toContain("runAgent(");
  });

  test("run, queue, ask and session-file state delegate to SessionKernel", () => {
    expect(read("run-state.ts")).toContain("sessionKernel(sessionId)");
    expect(read("queue-state.ts")).toContain("new DeliveryOwnedMap");
    expect(read("queue-state.ts")).toContain("sessionDelivery");
    expect(read("queue-state.ts")).not.toContain("new SessionOwnedMap");
    expect(read("queue-state.ts")).toContain("new EphemeralSessionSet");
    expect(read("asks.ts")).toContain("new AskOwnedMap");
    expect(read("asks.ts")).toContain("new EphemeralSessionMap");
    // A committed durable answer survives restore: the projection maps it
    // to answered state and the rewrite carries its retry identity.
    expect(read("asks.ts")).toContain(
      "saved.answer ? { answer: saved.answer }",
    );
    expect(read("queue-state.ts") + read("asks.ts")).not.toContain(
      "SessionOwnedMap",
    );
    expect(read("session-kernel/kernel.ts")).not.toContain("getRuntime<");
    expect(read("session-kernel/kernel.ts")).not.toContain("setRuntime<");
    expect(read("session-cache.ts")).toContain("sessionGatewayCommand");
    expect(read("session-cache.ts")).toContain("sessionDeliveryProjection");
    expect(read("session-cache.ts")).not.toContain("__promptQueues");
  });

  test("delivery and ask JSON are one-time imports, never post-migration writers", () => {
    const queue = read("queue-state.ts");
    const asks = read("asks.ts");
    expect(queue).toContain("removeLegacyQueueStore(storePath)");
    expect(queue).toContain("sessionDeliveryMigrationComplete()");
    expect(asks).toContain("removeLegacyAskStore(storePath)");
    expect(asks).toContain("sessionAskMigrationComplete()");
    // Once the actor acknowledges either one-time import, production JSON
    // persistence stays fail-closed instead of becoming a second writer.
    expect(queue).toContain("queueMigrationState.complete");
    expect(asks).toContain("askMigrationState.complete");
  });

  test("delivery and ask writes fail closed without the actor in production", () => {
    const kernel = read("session-kernel/kernel.ts");
    expect(kernel).toContain("compatibilityStoreForTest");
    expect(kernel).toContain('process.env.NODE_ENV !== "test"');
    expect(kernel).toContain("requires the authoritative actor");
    expect(kernel).toContain("actor.decideAskAsync(request)");
    expect(kernel).toContain("actor.decideDeliveryAsync(request)");
    expect(kernel).not.toContain(
      'actor.decideDelivery({ op: "snapshot", sessionId: request.sessionId })',
    );
  });

  test("creation decisions enter a typed actor reducer", () => {
    const protocol = read("session-kernel/lifecycle-protocol.ts");
    const creationEffects = read("session-kernel/creation-effect-protocol.ts");
    const actor = read("session-kernel/actor-worker.ts");
    const store = read("session-kernel/store.ts");
    expect(protocol).toContain('kind: "creation_event"');
    expect(actor).toContain('command.kind === "creation_event"');
    expect(actor).toContain("store.applyCreationEvent(command.decision)");
    expect(read("session-kernel/creation-state-machine.ts")).toContain(
      "export function nextCreationState",
    );
    for (const kind of [
      "creation_workspace_prepare",
      "creation_branch_prepare",
      "creation_sandbox_prepare",
      "creation_credential_resolve",
      "creation_attachment_stage",
      "creation_opening_turn",
    ])
      expect(creationEffects).toContain(`kind: "${kind}"`);
    expect(creationEffects).not.toContain("dataUrl");
    expect(creationEffects).not.toContain("token:");
    const creationReduction = store.slice(
      store.indexOf("applyCreationEvent("),
      store.indexOf("applyRunEvent("),
    );
    expect(creationReduction).toContain("this.enqueueOutbox(");
    expect(creationReduction).toContain(
      "completedEffectIds.push(input.effectId!)",
    );
    expect(creationReduction).toContain(
      'input.event === "opening_dispatched" && !effect',
    );
    expect(store).toContain("SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS");
    expect(creationReduction.indexOf("this.enqueueOutbox(")).toBeLessThan(
      creationReduction.indexOf("tx.immediate()"),
    );
    expect(read("session-kernel/kernel.ts")).toContain(
      'msg: "session_creation_stale_result_rejected"',
    );
    const creationExecutors = read(
      "session-kernel/creation-effect-executors.ts",
    );
    expect(creationExecutors).toContain(
      'registerSessionEffectExecutor(\n      "creation_workspace_prepare"',
    );
    expect(creationExecutors).toContain(
      'registerSessionEffectExecutor(\n      "creation_branch_prepare"',
    );
    expect(creationExecutors).toContain(
      '"creation_sandbox_prepare",\n      executeCreationSandboxPrepare',
    );
    expect(creationExecutors).toContain(
      '"creation_credential_resolve",\n      executeCreationCredentialResolve',
    );
    expect(creationExecutors).toContain(
      '"creation_attachment_stage",\n      executeCreationAttachmentStage',
    );
    expect(creationExecutors).toContain(
      '"creation_opening_turn",\n      executeCreationOpeningTurn',
    );
    expect(creationExecutors).toContain(
      "payload.sandboxKey !== item.sessionId",
    );
    expect(creationExecutors).toContain("resolveCurrentCredential");
    expect(creationExecutors).toContain("stageCreationAttachment");
    expect(creationExecutors).not.toContain("payload.gitEnv");
    expect(read("session-create.ts")).not.toContain("stageFileAttachments(");
    expect(read("session-control-wiring.ts")).not.toContain(
      "stageFileAttachments(",
    );
    expect(creationExecutors).toContain(
      "assertAdoptableWorkspace(workspace, item)",
    );
    expect(
      creationExecutors.indexOf("dependencies.result(item)"),
    ).toBeGreaterThan(
      creationExecutors.indexOf("dependencies.createWorkspace({"),
    );
  });

  test("queue selection and dispatch claim execute atomically inside the actor", () => {
    const run = read("run-session.ts");
    const queue = read("queue-state.ts");
    const actor = read("session-kernel/actor-worker.ts");
    expect(run).toMatch(/beginNextPromptDispatch\(\s*sessionId/);
    expect(run).not.toContain("selectQueueBatch(queue");
    expect(run).not.toContain("interruptMarks");
    expect(actor).toContain('delivery.op === "prepare_interrupt"');
    expect(actor).toContain('delivery.op === "begin_interrupt_effect"');
    expect(actor).toContain('delivery.op === "settle_interrupt"');
    expect(actor).toContain('delivery.op === "claim_next_dispatch"');
    expect(actor).toContain("store.claimNextDeliveryDispatch(delivery)");
    expect(queue).toMatch(
      /failPromptDispatch\(\s*sessionId,\s*dispatch\.promptEntryId,\s*false\s*\)/,
    );
    expect(run).toContain(
      'registerSessionEffectExecutor("delivery_interrupt_cancel"',
    );
    const beginEffect = run.indexOf("beginPromptInterruptEffect(");
    const cancel = run.indexOf("cancelAgentRunToken(dispatchId)", beginEffect);
    const settle = run.indexOf("settlePromptInterrupt(", cancel);
    expect(run).toMatch(/preparePromptInterrupt\(\s*sessionId,/);
    expect(beginEffect).toBeGreaterThan(-1);
    expect(beginEffect).toBeLessThan(cancel);
    expect(cancel).toBeLessThan(settle);
  });

  test("run-state decisions execute atomically inside the actor", () => {
    const facade = read("run-state.ts");
    const actor = read("session-kernel/actor-worker.ts");
    expect(facade).toContain(".applyRunEvent({");
    expect(actor).toContain('request.t === "reduce"');
    expect(actor).toContain('command.kind === "run_event"');
    expect(actor).toContain("store.applyRunEvent(command.decision)");
    expect(read("session-kernel/run-state-machine.ts")).toContain(
      "export function nextRunState",
    );
  });

  test("every transcript mutation enters the session owner", () => {
    const source = read("transcript-store.ts");
    expect(source).toContain("executeDestinationIdempotentSessionProjection(");
    expect(source).toContain('"transcript_destination_append"');
    for (const operation of [
      "transcript_append",
      "transcript_import",
      "transcript_replace",
      "transcript_delete",
    ]) {
      expect(source).toContain(
        `executeSessionProjection(sessionId, "${operation}"`,
      );
    }
    expect(read("session-kernel/kernel.ts")).not.toContain("applySync");
  });

  test("all shared prompt delivery uses the typed delivery actor", () => {
    const control = read("session-control-wiring.ts");
    expect(control).not.toContain('legacyGatewayEffect("submit_prompt"');
    expect(control).toContain('op: "request_submit_command"');
    expect(control).toContain('op: "complete_submit_command"');
    expect(control).toContain('op: "fail_submit_command"');
    expect(read("routes/sessions.ts")).not.toContain("promptReceipt(");
    expect(existsSync(join(serverDir, "prompt-receipts.ts"))).toBe(false);
    const steerEligibility = control.indexOf('opts?.busy !== "queue"');
    const steerItem = control.indexOf("const steerItem = durableQueueItem(id");
    expect(steerEligibility).toBeGreaterThan(-1);
    expect(steerItem).toBeGreaterThan(steerEligibility);
    expect(
      control.indexOf("await prepareAndSteerQueuedPrompt({", steerItem),
    ).toBeGreaterThan(steerItem);
    const queuedSteer = read("queued-steer.ts");
    expect(queuedSteer).toContain("await deps.prepare(");
    expect(queuedSteer).toContain("steerAgentRunToken");
    expect(queuedSteer).toContain("interruptAndSteerAgentRunToken");
    const runSession = read("run-session.ts");
    expect(runSession).toContain("await prepareAndInterruptQueuedPrompt({");
    expect(runSession).not.toContain("!interruptAndSteerAgentRun(");
  });

  test("sandbox prompts are visible before remote startup can fail", () => {
    const source = read("run-session.ts");
    expect(source).toContain("if (content?.trim()) {");
    expect(source).not.toContain("if (!session.sandbox && content?.trim()) {");
  });

  test("interactive remote runs do not launch host-only external MCP servers", () => {
    expect(read("run-session.ts")).toContain(
      "mcpServers: opts.isAutomationSession ? (opts.mcpServers ?? []) : []",
    );
  });

  test("no server module writes session JSON outside the owner facade", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(serverDir)) {
      const relative = path.slice(serverDir.length + 1);
      if (relative === "session-cache.ts") continue;
      const source = readFileSync(path, "utf8");
      if (
        /writeJsonAtomic\(`\$\{(?:OPENSESSION_)?SESSIONS_DIR\}/.test(source) ||
        /writeFileSync\(`\$\{(?:OPENSESSION_)?SESSIONS_DIR\}/.test(source)
      ) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the gateway boots an IPC actor before hydrating session projections", () => {
    const entry = read("../../opensession.ts");
    expect(entry.indexOf("await startSessionKernelActor()")).toBeLessThan(
      entry.indexOf("initHumanAsks()"),
    );
    expect(entry).toContain("await restorePendingAsks()");
    expect(entry).toContain("await hydratePersistedQueueState()");
    expect(entry).toContain("await restorePromptQueues(new Set(resumedIds))");
    const queueRestore = entry.indexOf(
      "await restorePromptQueues(new Set(resumedIds))",
    );
    expect(queueRestore).toBeLessThan(
      entry.indexOf("reconcileSessionKernelOwnership(", queueRestore),
    );
    const actor = read("session-kernel/actor-worker.ts");
    expect(actor).toContain("const host = new SessionKernelStoreHost()");
    expect(actor).not.toContain("const store = new SessionKernelStore()");
    const forbidden = [
      "Atomics.wait",
      "SharedArrayBuffer",
      "callSync",
      "KernelActorSyncRequest",
    ];
    const offenders: string[] = [];
    for (const path of sourceFiles(serverDir)) {
      if (path.endsWith(".test.ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const token of forbidden) {
        if (source.includes(token)) offenders.push(`${path}:${token}`);
      }
    }
    const transport = read("../session-kernel-transport-worker.ts");
    for (const token of forbidden) {
      if (transport.includes(token))
        offenders.push(`session-kernel-transport-worker.ts:${token}`);
    }
    expect(offenders).toEqual([]);
  });

  test("Slack ask delivery is a durable production outbox effect", () => {
    const source = read("human-asks.ts");
    expect(source).toContain(
      'registerSessionEffectExecutor("human_ask_deliver"',
    );
    expect(source).toContain('"human_ask_deliver",');
    expect(source.match(/deliverAsk\(/g)?.length).toBe(2);
  });

  test("creation uses its FSM without nesting inside a legacy mailbox", () => {
    const ws = read("ws-handlers.ts");
    expect(ws).toContain('operation: "websocket_command"');
    expect(ws).toContain("sessionIdForRequest");
    expect(ws).toContain('typeof msg.sessionId === "string"');
    const mailboxCommands = ws.slice(
      ws.indexOf("const kernelCommands"),
      ws.indexOf("const requestId"),
    );
    const routes = read("routes/sessions.ts");
    const wiring = read("session-control-wiring.ts");
    expect(mailboxCommands).not.toContain('"create_session"');
    expect(routes).not.toContain('legacyGatewayEffect("create_session"');
    expect(wiring).not.toContain('legacyGatewayEffect("create_session"');
    expect(routes).toContain("id: targetId");
    expect(read("../../../protocol/src/session.ts")).toContain(
      'type: "cancel"; sessionId?: string; requestId?: string',
    );
  });

  test("interrupted creates resume their environment setup, not only their prompt", () => {
    const create = read("session-create.ts");
    expect(create).toContain("let recoveringSession = findSession(bksId)");
    expect(create).toContain(
      'existingBranch: restored.worktreeKind === "existing"',
    );
    expect(create).toContain("const actorPlan =");
    expect(create).toContain("creation?.setupPlan?.resolved");
    expect(create).toContain("const identity = actorPlan");
    expect(
      create.indexOf("openingPromptEntryId = beginPromptDispatch"),
    ).toBeLessThan(create.indexOf("await persist()"));
    // The detached host run must use the create dispatch's stable transcript
    // id. Otherwise every cold recovery mints another row for one prompt.
    expect(create).toMatch(
      /runAgentHosted\(\{[\s\S]*?prompt: openingPromptForRun,[\s\S]*?promptEntryId: openingPromptEntryId,/,
    );
    expect(create).not.toContain("if (requeuePromptDispatch(bksId))");
    const routes = read("routes/sessions.ts");
    expect(routes).not.toContain("requeuePromptDispatch(targetId)");
  });

  test("create replay waits for a resolvable projection before success", () => {
    const create = read("session-create.ts");
    const wiring = read("session-control-wiring.ts");
    for (const source of [create, wiring]) {
      expect(source).toContain("waitForCreatedSessionProjection(");
      expect(
        source.indexOf("sessionKernel(bksId).creationState()"),
      ).toBeLessThan(
        source.indexOf("actorCreationSetupPlan(bksId, createIdentity)"),
      );
    }
    // A stale create replay for any completed engine must return before setup
    // planning mutates the actor. Pi owns a distinct session-id slot.
    expect(create.indexOf("recoveringSession?.piSessionId")).toBeLessThan(
      create.indexOf("actorCreationSetupPlan(bksId, createIdentity)"),
    );
    expect(wiring.indexOf("completedCreate?.piSessionId")).toBeLessThan(
      wiring.indexOf("actorCreationSetupPlan(bksId, createIdentity)"),
    );
    expect(create).toContain("failCreate(error instanceof Error");
    expect(create).toContain("if (projected) return projected");
    expect(create.indexOf("if (projected) return projected")).toBeLessThan(
      create.indexOf('if (state.state === "failed")'),
    );
    const ws = read("ws-handlers.ts");
    expect(ws).toContain(
      "const kernelDispatchErrors = new Map<string, Error>()",
    );
    expect(ws).toContain("if (dispatchError) throw dispatchError");
    expect(ws).toContain("kernelDispatchErrors.set(");
  });

  test("actor setup plans and MCP controls retain stable request identity", () => {
    const wiring = read("session-control-wiring.ts");
    expect(wiring).toContain("patchCreationSetupPlan(bksId, createIdentity");
    expect(wiring).toContain("createPlan.resolved");
    expect(wiring).toContain("actorCreationSetupPlan(bksId, createIdentity)");
    expect(wiring).toContain("createdByLogin,");
    expect(wiring).not.toContain(
      "createdByLogin: parentSession?.createdByLogin",
    );
    for (const route of [
      read("routes/sessions.ts"),
      read("routes/reports.ts"),
      read("routes/security.ts"),
    ]) {
      expect(route).toContain("createdByLogin: ctx.authUser?.login");
    }
    expect(read("report-sessions.ts")).toContain(
      "createdByLogin: input.createdByLogin",
    );
    expect(wiring).not.toContain("updateCreatePlan(");
    expect(wiring).toContain("await requestCreationWorkspace({");
    expect(wiring.match(/await requestCreationCredential\(\{/g)?.length).toBe(
      2,
    );
    expect(wiring.match(/await requestCreationBranch\(\{/g)?.length).toBe(2);
    expect(wiring).toContain("baseBranch: baseRef || repo.defaultBranch");
    expect(wiring).toContain("restoredSpec.worktreeBaseRef ||");
    expect(wiring).toContain("getRepo(restoredSpec.repoId!).defaultBranch");
    expect(wiring).not.toMatch(/\bcreateWorkspace\(/);
    expect(wiring).not.toMatch(/\bcreateWorktree\(/);
    const create = read("session-create.ts");
    expect(create).toContain("createPlan.resolved");
    expect(create).toContain("patchCreationSetupPlan(bksId, createIdentity");
    expect(create).not.toContain("updateCreatePlan(");
    expect(read("session-create-plan.ts")).not.toContain(
      "function updateCreatePlan",
    );
    expect(create.match(/await requestCreationWorkspace\(\{/g)?.length).toBe(2);
    expect(create).toContain("actorWorktreeMaterializer({");
    expect(create).toContain("await requestCreationCredential({");
    expect(create).toContain("await requestCreationBranch({");
    expect(create).not.toContain("requestCreationSandbox");
    // The opening effect holds the creation fence, so provisioning rides
    // the launch-time idempotent provider.ensure instead of a second
    // durable effect that could never be admitted.
    expect(create).not.toContain("markCreationOpeningDispatched");
    expect(create).toMatch(
      /executeCreationOpeningEffect\([\s\S]*?openCreatedSession\(/,
    );
    expect(create).toContain("settleCreationSucceeded(");
    expect(create).toContain("settleCreationFailed(");
    expect(create).toContain("creationEffectId,");
    expect(create).toContain(
      "baseBranch: input.baseBranch || getRepo(input.project).defaultBranch",
    );
    expect(create).not.toMatch(/\bcreateWorkspace\(/);
    expect(create).not.toMatch(/\bcreateWorktree\(/);
    expect(create).not.toMatch(/\bcreateWorktreeForExistingBranch\(/);
    expect(create).toContain("spec.openingPromptEntryId");
    expect(wiring).not.toContain('legacyGatewayEffect("cancel_session"');
    expect(wiring).toContain('op: "request_cancel_command"');
    // Ask answers settle through the typed actor aggregate, not the
    // compatibility mailbox.
    expect(wiring).not.toContain('legacyGatewayEffect("answer_question"');
    expect(wiring).toContain('op: "answer",');
    expect(wiring).not.toContain('legacyGatewayEffect("submit_prompt"');
    expect(wiring).toContain('op: "request_submit_command"');
    expect(wiring).toContain('op: "complete_submit_command"');
    expect(wiring).toContain('op: "fail_submit_command"');
    const tools = read("../agents/slack/sessions-tools.ts");
    expect(tools).toContain("durableToolRequestId");
    expect(tools).toMatch(
      /durableToolRequestId\(\s*ctx,\s*"create_session",\s*extra,/,
    );
    const native = readFileSync(
      resolve(
        serverDir,
        "../../../../clients/ios/OS1/Networking/SessionCreateIntent.swift",
      ),
      "utf8",
    );
    expect(native).toContain('identityBody.removeValue(forKey: "requestId")');
  });

  test("unresolved client and automation intents are never silently replaced", () => {
    const web = read("../frontend/lib/ws-command-outbox.ts");
    expect(web).not.toContain("RETENTION_MS");
    expect(web).not.toContain("MAX_ITEMS");
    const chrome = readFileSync(
      resolve(serverDir, "../../../../clients/chrome/sidepanel.js"),
      "utf8",
    );
    expect(chrome).toContain("version: 3, id");
    const workflow = read("workflow-runner.ts");
    expect(workflow).toContain("`workflow:${snap.runId}:${snap.status}`");
  });

  test("durable client replay is negotiated before commands are resent", () => {
    expect(read("ws-handlers.ts")).toContain(
      "capabilities: { commandResults: true }",
    );
    const hook = read("../frontend/hooks/useWebSocket.ts");
    expect(hook).toContain("commandResultsRef.current = false");
    expect(hook).toContain("msg.capabilities?.commandResults === true");
  });

  test("taking back a steer is receipt-idempotent on every client", () => {
    expect(read("ws-handlers.ts")).toContain('"take_steered_prompt",');
    expect(read("../frontend/lib/ws-request-id.ts")).toContain(
      '"take_steered_prompt",',
    );
    const native = readFileSync(
      resolve(
        serverDir,
        "../../../../clients/ios/OS1/Networking/SocketMutationOutbox.swift",
      ),
      "utf8",
    );
    expect(native).toContain('"take_steered_prompt",');
  });

  test("run-targeting retries and deletion cannot cross generations", () => {
    const ws = read("ws-handlers.ts");
    expect(ws).toContain("const targetRunId =");
    expect(ws).toContain(
      "The run targeted by this command has already changed",
    );
    expect(ws).toContain("sessionId: commandSessionId");
    expect(ws).toContain("`stop-${msg.requestId}`");
    expect(ws).toContain("requestTurnCancel(sessionId, session");
    expect(ws.indexOf("const persistedCancel =")).toBeLessThan(
      ws.indexOf('operation: "websocket_command"'),
    );
    expect(ws.indexOf("durableSessionCommand(")).toBeLessThan(
      ws.indexOf('operation: "websocket_command"'),
    );
    expect(ws.indexOf("const persistedInterrupt =")).toBeLessThan(
      ws.indexOf('operation: "websocket_command"'),
    );
    expect(ws).not.toContain("cancelAgentRun(");
    const runSession = read("run-session.ts");
    expect(runSession).toContain('registerSessionEffectExecutor("turn_cancel"');
    expect(runSession).toContain("cancelAgentRunToken(dispatchId)");
    expect(runSession).toContain("cancelAgentRunTokenAndWait(dispatchId)");
    expect(runSession).toContain(
      "journalRetireCancelledAbnormalAfterSettlement(",
    );
    const turnExecutor = runSession.indexOf(
      'registerSessionEffectExecutor("turn_cancel"',
    );
    const missingCancel = runSession.indexOf(
      'if (decision === "missing") return;',
      turnExecutor,
    );
    expect(missingCancel).toBeLessThan(
      runSession.indexOf(
        "journalRetireCancelledAbnormalAfterSettlement(",
        missingCancel,
      ),
    );
    expect(runSession).toContain("if (!settled) return false;");
    const interruptSettle = runSession.indexOf(
      "settlePromptInterrupt(",
      runSession.indexOf("beginPromptInterruptEffect("),
    );
    expect(
      runSession.indexOf("retireConfirmedAbnormal();", interruptSettle),
    ).toBeGreaterThan(interruptSettle);
    const agentRunner = read("agent-runner.ts");
    expect(agentRunner).toContain('if (cancelOwnership === "unknown") {');
    expect(agentRunner).toMatch(
      /if \(cancelOwnership === "unknown"\) \{[\s\S]*?return true;/,
    );
    expect(agentRunner).toContain(
      'while (ownership === "unknown" && Date.now() < ownershipDeadline)',
    );
    expect(agentRunner).toContain(
      "ownershipBackoffMs = Math.min(5_000, ownershipBackoffMs * 2)",
    );
    const runnerSession = read("runner-session.ts");
    const runnerLaunch = runnerSession.indexOf(
      "await launcher.launch(hostId, hostDir)",
    );
    expect(
      runnerSession.indexOf(
        "opts.shouldCancel?.()",
        runnerSession.indexOf("new HostHandle"),
      ),
    ).toBeLessThan(runnerLaunch);
    expect(
      runnerSession.indexOf("opts.shouldCancel?.()", runnerLaunch),
    ).toBeGreaterThan(runnerLaunch);
    expect(
      runnerSession.indexOf(
        "opts.shouldCancel?.()",
        runnerSession.indexOf("await handle.connectWithWait"),
      ),
    ).toBeGreaterThan(runnerSession.indexOf("await handle.connectWithWait"));
    expect(runnerSession).toContain("journalClearIfLineage(run)");
    expect(runnerSession).not.toContain("journalClear(session.id)");
    const wiring = read("session-control-wiring.ts");
    expect(wiring).toContain("requestTurnCancel(id, currentSession");
    expect(wiring).not.toContain('legacyGatewayEffect("cancel_session"');
    expect(wiring.indexOf('op: "request_cancel_command"')).toBeLessThan(
      wiring.indexOf("requestTurnCancel(id, currentSession"),
    );
    const cancelContinuation = wiring.indexOf(
      "requestTurnCancel(id, currentSession",
    );
    expect(cancelContinuation).toBeLessThan(
      wiring.indexOf('op: "complete_cancel_command"', cancelContinuation),
    );
    expect(wiring).toContain('op: "fail_cancel_command"');
    expect(wiring).not.toContain("cancelAgentRun(");
    const routes = read("routes/sessions.ts");
    expect(routes).toContain("await cancelAgentRunAndWait(runIds)");
    expect(routes).toContain("requestTurnCancel(session.id, session");
    const prRoutes = read("routes/pr.ts");
    expect(prRoutes).toContain("requestTurnCancel(bksId, reviewSession");
    expect(prRoutes).not.toContain("cancelAgentRun(");
    expect(routes).toContain('operation: "delete_session"');
    expect(routes).toContain("withSessionMutationLock(session.id");
  });

  test("create and sandbox recovery establish one execution owner", () => {
    const queue = read("queue-state.ts");
    expect(queue).toContain('kind?: "create"');
    expect(queue).toContain("options.creationOwnsPrompt?.(");
    const runSession = read("run-session.ts");
    expect(runSession).toContain("resumePlannedCreate(sessionId)");
    const boot = read("../../opensession.ts");
    expect(boot).toContain("runId: recoveredRun.runKey");
    expect(boot).toContain("projectionId: `outcome:${recoveredRun.runKey}`");
    expect(boot).toMatch(
      /runGeneration:\s*sessionKernel\(bksSessionId\)\.runStateProjection\(\)\s*\.generation/,
    );
    const cache = read("session-cache.ts");
    expect(cache).toContain('op: "prepare_outcome_projection"');
    expect(cache).toContain("projectionId: opts.projectionId");
    expect(runSession).toContain("creationOwnsPrompt(record.osSessionId");
    expect(boot).toMatch(
      /creationOwnsPrompt\(\s*run\.osSessionId,\s*run\.promptEntryId\s*\)/,
    );
    expect(boot).toContain("!!(run.runnerId || run.sandboxId)");
    expect(boot).toContain("settleRecoveredCreationOpening(");
    const create = read("session-create.ts");
    expect(create).toContain("const openingJournal =");
    expect(create).toContain(
      "const claimedRecovery = activeAgentRecoveryRecord(openingRunKey)",
    );
    expect(create).toContain(
      "claimedRecovery.promptEntryId === item.payload.openingPromptEntryId",
    );
    expect(create).toContain("Recovered local opening lost durable ownership");
    const runner = read("runner-session.ts");
    expect(runner).toContain("promptEntryId: opts.promptEntryId");
    expect(runner).toContain("const hostId = opts.hostId ||");
    expect(runner).toContain('run.launchPhase === "prepared"');
    expect(runner).toContain('launchPhase: "launching"');
    const durableLaunching = runner.indexOf(
      "writeJsonAtomic(launchStatePath, launchState)",
      runner.indexOf('phase: "launching"'),
    );
    const physicalLaunch = runner.indexOf(
      "await launcher.launch(hostId, hostDir)",
      durableLaunching,
    );
    expect(durableLaunching).toBeGreaterThan(0);
    expect(physicalLaunch).toBeGreaterThan(durableLaunching);
    expect(runner).toContain('launchPhase: "started"');
    expect(runner).toContain('phase: "rejected"');
    expect(runner).toContain('reason: "ambiguous_runner_launch"');
    expect(runner).toContain(
      "setRunnerWorkload(runner.id, undefined, session.id)",
    );
    expect(runner).toContain("has no adoptable remote evidence");
    expect(read("runner-ws.ts")).toContain("RunnerHostLaunchRejectedError");
    expect(runner).toContain("candidate.hostId === run.hostId");
    const runtime = read("session-kernel/runtime.ts");
    expect(runtime).toContain('item.kind === "creation_opening_turn"');
    expect(runtime).toContain("activeOpeningOutbox");
    for (const relative of [
      "sandbox/docker.ts",
      "sandbox/adapters/bootstrap.ts",
    ]) {
      const source = read(relative);
      const eager = source.indexOf("launchRunEager");
      const record = source.indexOf("journalSet(record);", eager);
      const specWrite =
        relative === "sandbox/docker.ts"
          ? source.indexOf(
              "writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec)",
              eager,
            )
          : source.indexOf("launcher.writeSpec!(dir, spec)", eager);
      const launch = source.indexOf("launcher.launch", record);
      const launching = source.indexOf(
        'record.launchPhase = "launching"',
        launch,
      );
      const connect = source.indexOf("new HostHandle", launching);
      const dispatchCallback = source.indexOf("onDispatching?.()");
      const processDispatch =
        relative === "sandbox/docker.ts"
          ? source.indexOf("await docker(args)", dispatchCallback)
          : source.indexOf("driver.execBackground(", dispatchCallback);
      expect(specWrite).toBeGreaterThan(0);
      expect(specWrite).toBeLessThan(record);
      expect(record).toBeGreaterThan(0);
      expect(record).toBeLessThan(launch);
      expect(launch).toBeLessThan(launching);
      expect(launching).toBeLessThan(connect);
      expect(dispatchCallback).toBeGreaterThan(0);
      expect(dispatchCallback).toBeLessThan(processDispatch);
      expect(source).toContain("decideSandboxHostRecovery");
      expect(source).toContain("uncertainLaunch");
      expect(source).toContain("reconcileUncertainHostEvents");
      expect(source).not.toContain("pgrep -f");
      expect(source).toContain("evidence(dir)");
      if (relative.includes("bootstrap"))
        expect(source).toContain(
          "if (!dispatchAttempted) unregisterRunWsHost(hostId)",
        );
      expect(source).toContain('recovery.kind === "replay"');
      expect(source).toContain("...(oldSpec as RunHostSpec)");
    }
  });

  test("opening runs settle actor receipts before owner retirement and follow-ups", () => {
    const create = read("session-create.ts");
    const writes = create
      .split("\n")
      .filter((line) => line.includes("touchNativeSession("));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes)
      expect(line).toContain("await touchNativeSession(");
    const creationSettlement = create.indexOf("settleCreationSucceeded(");
    const dispatchAck = create.indexOf(
      "acknowledgePromptDispatch(bksId, openingPromptEntryId)",
      creationSettlement,
    );
    expect(creationSettlement).toBeGreaterThan(0);
    expect(dispatchAck).toBeGreaterThan(creationSettlement);
    expect(create).toContain(
      'if (event.type === "done" || event.type === "error")',
    );
    expect(create).toContain("await settlePhysicalCompletion()");
    expect(create).toContain(
      "Terminal-event handling settles the actor before backend generators may",
    );
    expect(create).toContain(
      'throw new Error("Opening run ended without a terminal event")',
    );
    expect(create).toContain("openingJournal?.terminalFailure");
    expect(create).toContain("startToken = await markSessionStarting(");
    expect(create).toContain("hostId: startToken");
    expect(create).toContain("isAgentSessionCancelled(bksId, startToken)");
    // Sandbox launches bind the physical host to the admitted token so
    // exact-token Stop reaches the live host (mirrors the Runner path).
    expect(read("run-session.ts")).toContain(
      "hostId: opts.startToken || `rh-${randomUUIDv7()}`",
    );
    expect(read("sandbox/local.ts")).toContain("startToken: spec.hostId");
    const runSession = read("run-session.ts");
    const cancelPrepared = runSession.indexOf('op: "prepare_cancel"');
    const settleGuarded = runSession.indexOf(
      "try {\n    await settleCreationOpeningForStop(sessionId);",
      cancelPrepared,
    );
    const bookkeeping = runSession.indexOf("} finally {", settleGuarded);
    expect(cancelPrepared).toBeGreaterThan(0);
    expect(settleGuarded).toBeGreaterThan(cancelPrepared);
    expect(bookkeeping).toBeGreaterThan(settleGuarded);
    // A racing opening settlement must never undo the committed durable
    // cancel or skip queue persistence/broadcast — but genuine invariant
    // failures still propagate after the bookkeeping ran.
    const bookkeptInFinally = runSession.indexOf(
      "stoppedSessions.add(sessionId)",
      bookkeeping,
    );
    expect(bookkeptInFinally).toBeGreaterThan(bookkeeping);
    // A retained cancel receipt fences only the exact run it cancelled:
    // the receipt records the admitted physical token, deterministically
    // derived from the effect payload's logical run id and generation.
    expect(create).toContain(
      "runnerOpeningHostId(item.payload.runId, item.payload.runGeneration)",
    );
    expect(create).toContain(
      "cancel.runGeneration === item.payload.runGeneration",
    );
    // Losing actor admission releases the process reservation it just took.
    const admissionLoss = create.indexOf(
      '"Opening turn lost actor admission before preparation"',
    );
    const unmarkBeforeThrow = create.lastIndexOf(
      "unmarkSessionStarting(bksId, startToken);",
      admissionLoss,
    );
    expect(admissionLoss).toBeGreaterThan(0);
    expect(unmarkBeforeThrow).toBeGreaterThan(0);
    expect(unmarkBeforeThrow).toBeLessThan(admissionLoss);
    for (const backend of [
      "host-client.ts",
      "runner-session.ts",
      "sandbox/docker.ts",
      "sandbox/adapters/bootstrap.ts",
    ]) {
      const source = read(backend);
      expect(source).toContain("journalRecordAbnormalCompletion(");
      expect(source).toContain("sourceCompleted && sawTerminal");
    }

    const cache = read("session-cache.ts");
    const outcome = cache.indexOf("if (errorMessage) {");
    const transcript = cache.indexOf("persistRunFailureNotice(", outcome);
    const sessionFile = cache.indexOf("await touchNativeSession(id", outcome);
    expect(transcript).toBeGreaterThan(outcome);
    expect(sessionFile).toBeGreaterThan(transcript);
    const run = read("run-session.ts");
    const projectionExecutor = run.indexOf(
      'registerSessionEffectExecutor("turn_outcome_project"',
    );
    const applyProjection = run.indexOf(
      "await applyRunOutcomeProjection(",
      projectionExecutor,
    );
    const settleProjection = run.indexOf(
      'op: "settle_outcome_projection"',
      applyProjection,
    );
    expect(projectionExecutor).toBeGreaterThan(0);
    expect(applyProjection).toBeGreaterThan(projectionExecutor);
    expect(settleProjection).toBeGreaterThan(applyProjection);
    expect(run).toContain("projectionId: `outcome:${startToken}`");
    expect(create).toContain("projectionId: `outcome:${startToken}`");

    const terminalOutcome = run.indexOf(
      "await recordRunOutcome(session.id, runFailure",
    );
    expect(terminalOutcome).toBeGreaterThan(0);
    expect(
      run.indexOf("await requeueSteerReceipts", terminalOutcome),
    ).toBeGreaterThan(terminalOutcome);
    expect(run.indexOf('type: "stream_done"', terminalOutcome)).toBeGreaterThan(
      terminalOutcome,
    );

    const openingOutcome = create.indexOf(
      "await recordRunOutcome(bksId, runFailure",
    );
    expect(openingOutcome).toBeGreaterThan(0);
    expect(
      create.indexOf("await settleCreation", openingOutcome),
    ).toBeGreaterThan(openingOutcome);
    const setupOutcome = create.lastIndexOf("await recordRunOutcome(");
    expect(create.indexOf('type: "stream_done"', setupOutcome)).toBeGreaterThan(
      setupOutcome,
    );
    expect(
      create.indexOf("await settleCreationFailed(", setupOutcome),
    ).toBeGreaterThan(setupOutcome);

    const boot = read("../../opensession.ts");
    const recoveredOutcome = boot.indexOf("await recordRunOutcome(");
    expect(
      boot.indexOf("await settleRecoveredCreationOpening(", recoveredOutcome),
    ).toBeGreaterThan(recoveredOutcome);

    const github = read("../agents/github/run.ts");
    const githubOutcome = github.indexOf("await recordRunOutcome(");
    expect(
      github.indexOf("journalClearIfLineage(", githubOutcome),
    ).toBeGreaterThan(githubOutcome);

    const journal = read("run-journal.ts");
    expect(journal).toContain(
      'await transition(record.osSessionId, "run_registered"',
    );
    expect(journal).toContain(
      'await transition(r.osSessionId, "boot_journal_found"',
    );
    expect(journal).not.toContain("void transitionRunState(");
  });

  test("WebSocket session mutations enter the mailbox before dispatch", () => {
    const source = read("ws-handlers.ts");
    expect(source).toContain("kernelCommands.has(msg.type)");
    expect(source).toContain("isInternalKernelDispatch(");
    expect(source).toContain("kernelDispatchTokens.delete(kernelToken)");
    expect(source).toContain("__sessionKernelToken");
    expect(source).not.toContain("__sessionKernelOwned");
    expect(source).toContain('operation: "websocket_command"');
    expect(source).toContain('op: "complete"');
    expect(source).toContain('op: "fail"');
  });
});
