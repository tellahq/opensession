/**
 * Structural guards for the session list's sources. The gateway builds the
 * list from the list index and, for a cold rebuild, from the catalogs; it
 * never lists a session directory. The directory scanner exists for tests,
 * the isolated demo instance and the offline seed script only. A regression
 * that reintroduces a scan, or a fallback to one, fails here before it can
 * turn a list refresh into a multi-second stall of every request.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const serverDir = resolve(import.meta.dir);
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

const productionFiles = () => [
  ...sourceFiles(serverDir),
  ...sourceFiles(resolve(serverDir, "../agents")),
];
/** `server/x.ts` or `agents/x.ts`. */
const relativeTo = (path: string) => relative(resolve(serverDir, ".."), path);

/** A directory listing whose argument names a session store directory. */
const SESSION_STORE_LISTING =
  /\b(?:readdirSync|readdir|opendirSync|opendir)\(\s*(?:`\$\{)?\s*(?:OPENSESSION_SESSIONS_DIR|SESSIONS_DIR|SESSION_DIR|SLACK_SESSIONS_DIR|LINEAR_SESSIONS_DIR|SLACK_SESSION_DIR|LINEAR_SESSION_DIR|CLI_SESSIONS_DIR)\b/;

describe("session list sources", () => {
  test("the list builders never list a directory or import the scanner", () => {
    for (const file of [
      "sessions.ts",
      "session-cache.ts",
      "agent-session-catalog.ts",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/\breaddir(?:Sync)?\(/);
      expect(source).not.toMatch(
        /^import[^;]*["']\.\/session-source-scan["']/m,
      );
    }
    // The transcript index warm-up walks the engine transcript store, never
    // a session directory.
    const sessions = read("sessions.ts");
    for (const match of sessions.matchAll(/\bopendir\(([^)]*)\)/g))
      expect(match[1]).toContain("CLAUDE_PROJECTS_DIR");
    expect(read("session-cache.ts")).not.toContain("opendir(");
    expect(read("agent-session-catalog.ts")).not.toContain("opendir(");
  });

  test("a cold rebuild comes from the catalogs and fails bounded, never a scan", () => {
    const cache = read("session-cache.ts");
    expect(cache).toContain("class SessionListUnavailableError");
    expect(cache).not.toContain("getAllSessionsAsync");
    expect(cache).not.toContain("catalogNativeSessionRows");
    const asyncPath = cache.slice(
      cache.indexOf("export async function getCachedSessionsAsync"),
      cache.indexOf("export async function getSessionListSnapshotAsync"),
    );
    expect(asyncPath).toContain("rebuildSessionListFromCatalogs(slice)");
    expect(asyncPath).not.toContain("getAllSessions(");
    const prime = cache.slice(
      cache.indexOf("export async function primeSessionListIndex"),
      cache.indexOf("export function __resetSessionListCatalogStateForTest"),
    );
    // Boot fails rather than serving no list; nothing infers completeness.
    expect(prime).toContain("throw error;");
    expect(prime).not.toContain("getAllSessions(");
    expect(cache).not.toContain("mark_catalog_complete");
    expect(cache).not.toContain("markAgentSessionCatalogImportComplete");
    // The list path never discovers transcripts.
    const sessions = read("sessions.ts");
    const cooperative = sessions.slice(
      sessions.indexOf("export async function assembleSessionListAsync"),
      sessions.indexOf("export function getAllSessions("),
    );
    expect(cooperative).not.toContain("warmTranscriptIndexAsync");
    expect(cooperative).not.toContain("resolveTranscripts");
    expect(cooperative).toContain("getConfigAsync()");
    const sources = cache.slice(
      cache.indexOf("async function catalogSessionListSources"),
      cache.indexOf("async function rebuildSessionListFromCatalogs("),
    );
    expect(sources).toContain('op: "catalog_complete"');
    expect(sources).toContain("agentSessionCatalogImportComplete(kind)");
    expect(sources).toContain('op: "catalog_page"');
    expect(sources).toContain('agentSessionCatalogSources("slack")');
    expect(sources).toContain('agentSessionCatalogSources("linear")');
    expect(sources).toContain("throw new SessionListUnavailableError(");
    expect(sources).not.toContain("return undefined");
    // The synchronous scanner is reachable from exactly one place: the
    // test-only fallback of the synchronous reader.
    expect(cache.match(/getAllSessions\(\)/g)?.length).toBe(1);
    expect(cache).toMatch(
      /if \(process\.env\.NODE_ENV === "test"\) \{\s*sessionsCacheGenerations\.include\+\+;\s*return enrichCachedSessions\("include", getAllSessions\(\)\);/,
    );
  });

  test("the sync scanner is a lazily required, offline-only seam", () => {
    const sessions = read("sessions.ts");
    const seam = sessions.slice(
      sessions.indexOf("export function getAllSessions("),
      sessions.indexOf("async function removeSessionArtifacts("),
    );
    expect(seam).toContain('require("./session-source-scan")');
    expect(seam).toContain("assembleSessionList(");
    const scanner = read("session-source-scan.ts");
    expect(scanner).toContain(
      "export function assertOfflineSessionSourceScan(",
    );
    for (const fn of [
      "scanNativeSessionFiles",
      "scanAgentSessionFiles",
      "scanSessionSourceDocuments",
      "seedSessionCatalogsFromFiles",
    ]) {
      const body = scanner.slice(scanner.indexOf(`function ${fn}`));
      const start = body.indexOf("{");
      expect(body.slice(start, start + 240)).toContain(
        "assertOfflineSessionSourceScan(",
      );
    }
    expect(scanner).toContain('process.env.NODE_ENV === "test"');
    expect(scanner).toContain(
      'process.env.OPENSESSION_OFFLINE_SESSION_SCAN === "1"',
    );
  });

  test("only the demo boot imports the directory scanner in production code", () => {
    // sessions.ts requires it lazily inside its test-only seam, which the
    // seam test pins; nothing else may name the module.
    const allowed = new Set(["server/demo/index.ts", "server/sessions.ts"]);
    const offenders: string[] = [];
    for (const path of productionFiles()) {
      const file = relativeTo(path);
      if (file === "server/session-source-scan.ts" || allowed.has(file))
        continue;
      if (/session-source-scan["']/.test(readFileSync(path, "utf8")))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("no production module calls the sync list scanner", () => {
    const offenders: string[] = [];
    for (const path of productionFiles()) {
      const file = relativeTo(path);
      if (file === "server/sessions.ts" || file === "server/session-cache.ts")
        continue;
      if (readFileSync(path, "utf8").includes("getAllSessions("))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("no new production module lists a session store directory", () => {
    const offenders: string[] = [];
    for (const path of productionFiles()) {
      const file = relativeTo(path);
      if (file === "server/session-source-scan.ts") continue;
      if (SESSION_STORE_LISTING.test(readFileSync(path, "utf8")))
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("maintenance readers have no scanner escape hatch or placement fanout", () => {
    const catalog = read("session-catalog-read.ts");
    expect(catalog).toContain('op: "catalog_complete"');
    expect(catalog).toContain('op: "catalog_page"');
    expect(catalog).not.toMatch(/\b(?:readdir|opendir|readFile)(?:Sync)?\(/);
    expect(catalog).not.toContain('op: "get"');
    const orphan = read("transcript-orphan-sweep.ts");
    expect(orphan).not.toContain("transcript.sessionIds");
    expect(orphan).not.toContain("actorTranscriptSessionIds");
    // The UI facade has a legacy local-SQLite fallback. Operator diagnostics
    // must stay on the owning actor RPC instead of opening that shared store.
    expect(orphan).not.toContain('from "./actor-transcript"');
    expect(orphan).toContain("sessionTranscript({");
    expect(orphan).toContain("ids.length > 100");
    expect(orphan).toContain("Live orphan transcript deletion is forbidden");
    const boot = read("../../opensession.ts");
    expect(boot).not.toContain("migrateSessionsToGithubUser");
    expect(boot).not.toContain("kickOrphanTranscriptSweep");
  });

  test("agent source writers publish so the projection learns every write", () => {
    const sync = read("agent-session-sync.ts");
    expect(sync.match(/publishSessionChange\(session\.id\)/g)?.length).toBe(2);
    expect(read("../agents/linear/session.ts")).toContain(
      "await publishSessionChange(`linear-${branch}`)",
    );
    expect(read("../agents/slack/handlers.ts")).toContain(
      "await publishSessionChange(",
    );
    // The mirror is coupled to the publish: a projection that cannot be
    // written fails the read, so the index never runs ahead of the catalog.
    const sessions = read("sessions.ts");
    const row = sessions.slice(
      sessions.indexOf("async function agentSourceRowAsync"),
      sessions.indexOf("export function slackSessionSourceRow"),
    );
    expect(row).toContain("await mirrorAgentSessionSource(");
    expect(row).not.toContain(".catch(");
    const catalog = read("agent-session-catalog.ts");
    const write = catalog.slice(
      catalog.indexOf("async function writeObservation"),
    );
    expect(write).toContain("stored.observedAt > observedAt");
    expect(write).toContain("throw new Error(");
    expect(write).not.toContain("console.warn");
  });
});
