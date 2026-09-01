import { describe, expect, test } from "bun:test";

const read = (relative: string) =>
  Bun.file(new URL(relative, import.meta.url)).text();

describe("shutdown intake fence", () => {
  test("parks automation scheduler, webhook, and direct runs", async () => {
    const source = await read("./automations.ts");
    const run = source.indexOf("export async function runAutomation(");
    const shutdown = source.indexOf("if (isShuttingDown())", run);
    expect(source.indexOf("persistAutomationIntent({", run)).toBeLessThan(
      shutdown,
    );
    expect(shutdown).toBeLessThan(source.indexOf("runningCounts.set", run));
    expect(source).toContain(
      "schedulerInterval = setInterval(() => {\n    if (isShuttingDown()) return;",
    );
    expect(
      source.match(
        /return Response\.json\(\{ error: "Server restarting" \}, \{ status: 503 \}\)/g,
      )?.length,
    ).toBe(2);
    expect(source).toContain("export function resumePendingAutomationRuns(");
    expect(source).toContain("osSessionId: intent.sessionId");
    expect(source).toContain("acceptedAt: intent.acceptedAt");
    expect(source).toContain("const startedAt = new Date(acceptedAt)");
    expect(source).toContain("automationPreparations.has(intent.sessionId)");
    expect(source).toContain(
      "activeAutomationIntentSessions.has(intent.sessionId)",
    );
    expect(source).toMatch(
      /activeRunRecords\(\)\.some\(\s*\(run\) => run\.osSessionId === intent\.sessionId,?\s*\)/,
    );
    expect(source).toContain(
      '(intent.trigger === "cron" || intent.trigger === "manual") &&',
    );
    expect(source).toContain("isAutomationRunning(automation.id)");
    expect(source).toContain("resumePendingAutomationRuns(onSessionCreated)");
    expect(source).toContain("recordAutomationIntentTerminal(");
    const streamAdoption = source.indexOf("for await (const event of events)");
    const terminal = source.indexOf(
      "recordAutomationIntentTerminal(bksId",
      streamAdoption,
    );
    const settle = source.indexOf("settleRun(automation.id, bksId", terminal);
    expect(terminal).toBeLessThan(settle);
    expect(settle).toBeLessThan(
      source.indexOf("clearAutomationIntent(bksId)", settle),
    );
    expect(source).toContain("if (!hasAutomationIntent(osSessionId))");
    expect(
      source.indexOf("automationPreparations.delete(bksId)", streamAdoption),
    ).toBeGreaterThan(streamAdoption);
    const cleanup = source.indexOf("} finally {", streamAdoption);
    expect(
      source.indexOf("automationPreparations.delete(bksId)", cleanup),
    ).toBeGreaterThan(cleanup);
  });

  test("parks new GitHub reviews before claiming their lock", async () => {
    const source = await read("../agents/github/review.ts");
    const review = source.indexOf("export async function runReview(");
    expect(source.indexOf("if (isShuttingDown())", review)).toBeLessThan(
      source.indexOf('claimLock("review"', review),
    );
    expect(source).toContain("preserveRecovery = true");
    expect(source).toContain("review parked for restart");
    expect(source).toContain("review repair parked for restart");
    expect(source).not.toContain(
      "if (cancellationRequested() || isShuttingDown())",
    );
  });

  test("counts accepted automation setup and resumes its durable intent", async () => {
    const source = await read("../../opensession.ts");
    expect(source).toContain("activeAutomationPreparationCount(),");
    expect(source.indexOf("activeAutomationPreparationCount(),")).toBeLessThan(
      source.indexOf("activeAgentRunCount() - activeDetachedAgentRunCount()"),
    );
    expect(source).toContain(
      "resumePendingAutomationRuns(onAutomationSession)",
    );
  });

  test("announces a restart before potentially slow shutdown work", async () => {
    const source = await read("../../opensession.ts");
    const shutdown = source.indexOf("const gracefulShutdown = async");
    const announce = source.indexOf(
      'broadcastToAll({ type: "server_restarting" });',
      shutdown,
    );
    const flush = source.indexOf("setTimeout(r, 50)", announce);
    const runtimeStop = source.indexOf("stopSessionKernelRuntime()", announce);
    const snapshot = source.indexOf("snapshotActiveSessions()", announce);

    expect(announce).toBeGreaterThan(shutdown);
    expect(announce).toBeLessThan(flush);
    expect(flush).toBeLessThan(runtimeStop);
    expect(runtimeStop).toBeLessThan(snapshot);
  });

  test("reserves the handoff signal exclusively for graceful shutdown", async () => {
    const source = await read("../../opensession.ts");
    expect(source.match(/process\.on\("SIGUSR2"/g)).toHaveLength(1);
    expect(source).toContain(
      'process.on("SIGUSR2", () => void gracefulShutdown("SIGUSR2"))',
    );
    expect(source).not.toContain('scheduleFrontendRebuild("SIGUSR2"');
  });

  test("acknowledges restart-window composer intake as queued", async () => {
    const source = await read("./session-control-wiring.ts");
    const delivery = source.indexOf("deliverToSession: async");
    const earlyFence = source.indexOf("if (isShuttingDown())", delivery);
    const busyRoute = source.indexOf("isAgentSessionBusy(", earlyFence);
    expect(earlyFence).toBeGreaterThan(delivery);
    expect(earlyFence).toBeLessThan(busyRoute);
    expect(source.slice(earlyFence, busyRoute)).toContain(
      "await enqueuePrompt(id, queuedItem)",
    );
    expect(source.slice(earlyFence, busyRoute)).toContain(
      'status: "queued" as const',
    );

    const durableIntake = source.indexOf(
      "// Every accepted prompt is durable before any engine or workspace wake.",
    );
    const enqueue = source.indexOf("await enqueuePrompt(id", durableIntake);
    const park = source.indexOf("if (parkQueueForShutdown(id))", enqueue);
    const drain = source.indexOf("void drainQueue(id)", park);
    expect(enqueue).toBeGreaterThan(durableIntake);
    expect(park).toBeGreaterThan(enqueue);
    expect(park).toBeLessThan(drain);
    expect(source.slice(park, drain)).toContain('status: "queued" as const');
  });

  test("does not launch derived one-shots after shutdown or a capacity wait", async () => {
    const source = await read("./one-shot.ts");
    const detailed = source.indexOf("export async function oneShotDetailed(");
    const firstFence = source.indexOf("if (isShuttingDown())", detailed);
    const acquire = source.indexOf("await acquireOneShotSlot()", firstFence);
    const secondFence = source.indexOf("if (isShuttingDown())", acquire);
    const launch = source.indexOf(
      "for await (const event of runPi(",
      secondFence,
    );
    expect(firstFence).toBeGreaterThan(detailed);
    expect(firstFence).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(secondFence);
    expect(secondFence).toBeLessThan(launch);
  });

  test("does not start a queued boot recovery after shutdown begins", async () => {
    const source = await read("./agent-runner.ts");
    const recovery = source.indexOf("const recoveryTask = (");
    const start = source.indexOf("const start = async () =>", recovery);
    expect(
      source.indexOf("if (started || isShuttingDown()) return", start),
    ).toBeGreaterThan(start);
    expect(
      source.indexOf("if (started || isShuttingDown()) return", start),
    ).toBeLessThan(source.indexOf("started = true", start));
  });
});
