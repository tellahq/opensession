/**
 * Reports — first-class recurring documents produced by automations (morning
 * support digest today; AWS-spend / churn / MRR analyses tomorrow). One HTML
 * file + JSON sidecar per report, with optional durable assets:
 *
 *   ~/.opensession-reports/<automationId>/<reportId>.html
 *   ~/.opensession-reports/<automationId>/<reportId>.json
 *   ~/.opensession-reports/<automationId>/<reportId>.assets/<path>
 *
 * Report ids are timestamp-prefixed so lexicographic order = chronological.
 * Published from agent runs via the opensession-report in-process MCP
 * (src/agents/slack/report-tools.ts — publish-only, wired into every
 * automation run); browsed via routes/reports.ts and the frontend Reports
 * view (left: one row per automation with history, right: the rendered HTML).
 * Publishes broadcast `reports_changed` so open Reports views refresh.
 *
 * The files are the store; list views read two catalog projections instead
 * of walking the tree per request: `report-groups` (one row per automation:
 * name, count, latest) and `session-reports` (one row per producing session).
 * publishReport, the only writer, keeps both current; the boot catalog import
 * seeds them once from the files.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { dirname, join, normalize, resolve } from "path";
import { catalogDocuments } from "./catalog-documents";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";

/**
 * The reports root, resolved per call. It used to be `homedir()/...`, which
 * bypassed BOTH statePath() and $HOME: a dev instance with its own
 * OPENSESSION_STATE_DIR published into the live operator's reports.
 */
function reportsRoot(): string {
  return stateDir("reports");
}

/** The root at load time, for call sites that need it as a value (tests).
 *  Everything in this module calls reportsRoot() instead, so a state root
 *  repointed after load still wins. */
export const REPORTS_ROOT = reportsRoot();

/** Reports an automation may keep; older ones are pruned on publish. */
const MAX_REPORTS_PER_GROUP = 100;
/** Keep the authored document bounded; binary evidence belongs in assets. */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_REPORT_ASSETS = 500;

export interface ReportAsset {
  path: string;
  data: Uint8Array;
}

export const REPORT_URGENCIES = ["low", "medium", "high", "critical"] as const;
export type ReportUrgency = (typeof REPORT_URGENCIES)[number];
export const REPORT_CONFIDENCES = ["low", "medium", "high"] as const;
export type ReportConfidence = (typeof REPORT_CONFIDENCES)[number];

export interface ReportHighlight {
  title: string;
  summary: string;
  urgency: ReportUrgency;
  confidence: ReportConfidence;
  sourceRefs?: string[];
}

/** Tasks a report may carry, and so the most sessions one fan-out can start. */
export const MAX_REPORT_TASKS = 30;
export const MAX_REPORT_TASK_PROMPT = 4000;

/**
 * One unit of work the report proposes, sized to be done on its own.
 *
 * Deliberately not a highlight. A highlight is a ranked FINDING — it carries
 * urgency and confidence because its job is to be read and triaged. A task is
 * a piece of WORK: a self-contained prompt an agent can be handed with nothing
 * else for context. A report of 21 gaps may want three highlights for the
 * digest and all 21 as tasks, so the two lists are separate and neither is
 * derived from the other.
 */
export interface ReportTask {
  /** Short label, what the row in the picker says. */
  title: string;
  /** The opening prompt for the session that does it. Must stand alone. */
  prompt: string;
}

export interface ReportMeta {
  /** Timestamp-prefixed id, unique within the group (= the filename stem). */
  id: string;
  title: string;
  /** Grouping key: the publishing automation's id. */
  automationId: string;
  /** Display name captured at publish time (survives automation renames). */
  automationName: string;
  /** The run's session, so the UI can link back to the producing session. */
  sessionId?: string;
  createdAt: string;
  /** Short plain-text gist for list rows / notifications. */
  summary?: string;
  /** Time-to-action for the report's most urgent finding. */
  urgency?: ReportUrgency;
  /** Epistemic confidence in the overall assessment. */
  confidence?: ReportConfidence;
  /** Structured findings for history inputs and optional notification sinks. */
  highlights?: ReportHighlight[];
  /** Follow-up work the report proposes, one session each (see ReportTask). */
  tasks?: ReportTask[];
}

export interface ReportGroup {
  automationId: string;
  automationName: string;
  count: number;
  latest: ReportMeta;
}

export const REPORT_GROUPS_NAMESPACE = "report-groups";
export const SESSION_REPORTS_NAMESPACE = "session-reports";

type StoredReportGroup = Omit<ReportGroup, "automationId">;

// Catalog writes are fire and forget for the synchronous publisher; this
// chain lets callers (and tests) wait until every projection write landed.
let projectionWrites: Promise<void> = Promise.resolve();
function trackProjection(write: Promise<unknown>, what: string): void {
  const settled = write.then(
    () => {},
    (error) =>
      console.warn(
        `[reports] catalog projection ${what} failed:`,
        error instanceof Error ? error.message : error,
      ),
  );
  projectionWrites = Promise.all([projectionWrites, settled]).then(() => {});
}

/** Resolves once every catalog projection write issued so far has landed. */
export function reportProjectionsSettled(): Promise<void> {
  return projectionWrites;
}

function sameReport(a: ReportMeta, b: ReportMeta): boolean {
  return a.id === b.id && a.automationId === b.automationId;
}

function newestFirst(reports: ReportMeta[]): ReportMeta[] {
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function projectSessionReport(meta: ReportMeta): void {
  if (!meta.sessionId) return;
  trackProjection(
    catalogDocuments(SESSION_REPORTS_NAMESPACE).update(
      meta.sessionId,
      (current) =>
        newestFirst([
          meta,
          ...((current as ReportMeta[] | null) ?? []).filter(
            (report) => !sameReport(report, meta),
          ),
        ]),
    ),
    `session ${meta.sessionId}`,
  );
}

function unprojectSessionReport(meta: ReportMeta | null): void {
  if (!meta?.sessionId) return;
  trackProjection(
    catalogDocuments(SESSION_REPORTS_NAMESPACE).update(
      meta.sessionId,
      (current) => {
        const rest = ((current as ReportMeta[] | null) ?? []).filter(
          (report) => !sameReport(report, meta),
        );
        return rest.length ? rest : null;
      },
    ),
    `session ${meta.sessionId}`,
  );
}

/** Path-segment guard for ids that travel through URLs. */
function safeSegment(s: string): boolean {
  return /^[\w.-]+$/.test(s);
}

function groupDir(automationId: string): string {
  return join(reportsRoot(), automationId);
}

function reportAssetsDir(automationId: string, reportId: string): string {
  return join(groupDir(automationId), `${reportId}.assets`);
}

function removeOrphanAssets(automationId: string): void {
  const dir = groupDir(automationId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".assets")) continue;
    const reportId = entry.name.slice(0, -".assets".length);
    if (!existsSync(join(dir, `${reportId}.json`)))
      rmSync(join(dir, entry.name), { recursive: true, force: true });
  }
}

function safeAssetPath(path: string): string {
  const raw = (path || "").trim().replace(/^\.\//, "");
  if (!raw) throw new Error("asset path is required");
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.split("/").includes("..")
  )
    throw new Error(
      `asset path must be relative (no leading /, no ..): ${path}`,
    );
  const rel = normalize(raw).replace(/\\/g, "/");
  if (rel === "." || rel.startsWith("../"))
    throw new Error(`asset path escapes the report: ${path}`);
  return rel;
}

function resolveReportAssetPath(
  automationId: string,
  reportId: string,
  path: string,
): { abs: string; rel: string } {
  if (!safeSegment(automationId) || !safeSegment(reportId))
    throw new Error("invalid report id");
  const dir = reportAssetsDir(automationId, reportId);
  const rel = safeAssetPath(path);
  const abs = resolve(dir, rel);
  if (!abs.startsWith(dir + "/"))
    throw new Error(`asset path escapes the report: ${path}`);
  return { abs, rel };
}

/** Sidecar filenames in a group dir, newest first (ids sort chronologically). */
function sidecarsFor(automationId: string): string[] {
  const dir = groupDir(automationId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

function readMeta(automationId: string, sidecar: string): ReportMeta | null {
  try {
    const raw = readFileSync(join(groupDir(automationId), sidecar), "utf8");
    const meta = JSON.parse(raw) as ReportMeta;
    return meta && typeof meta.id === "string" ? meta : null;
  } catch {
    return null;
  }
}

export function publishReport(input: {
  automationId: string;
  automationName: string;
  sessionId?: string;
  title: string;
  html: string;
  summary?: string;
  urgency?: ReportUrgency;
  confidence?: ReportConfidence;
  highlights?: ReportHighlight[];
  tasks?: ReportTask[];
  assets?: ReportAsset[];
}): ReportMeta {
  if (!safeSegment(input.automationId)) {
    throw new Error(`Invalid automation id "${input.automationId}"`);
  }
  const bytes = Buffer.byteLength(input.html, "utf8");
  if (!input.html.trim()) throw new Error("Report HTML is empty");
  if (bytes > MAX_REPORT_BYTES) {
    throw new Error(
      `Report HTML too large (${bytes} bytes > ${MAX_REPORT_BYTES}) — move binary evidence into report assets`,
    );
  }
  const assets = input.assets || [];
  if (assets.length > MAX_REPORT_ASSETS)
    throw new Error(
      `Too many report assets (${assets.length} > ${MAX_REPORT_ASSETS})`,
    );
  let assetBytes = 0;
  const assetPaths = new Set<string>();
  const validatedAssets = assets.map((asset) => {
    const path = safeAssetPath(asset.path);
    if (assetPaths.has(path))
      throw new Error(`Duplicate report asset: ${path}`);
    assetPaths.add(path);
    assetBytes += asset.data.byteLength;
    return { path, data: asset.data };
  });
  if (assetBytes > MAX_REPORT_ASSET_BYTES)
    throw new Error(
      `Report assets too large (${assetBytes} bytes > ${MAX_REPORT_ASSET_BYTES})`,
    );
  const now = new Date();
  if (input.urgency !== undefined && !REPORT_URGENCIES.includes(input.urgency))
    throw new Error(`Invalid report urgency "${input.urgency}"`);
  if (
    input.confidence !== undefined &&
    !REPORT_CONFIDENCES.includes(input.confidence)
  )
    throw new Error(`Invalid report confidence "${input.confidence}"`);
  if ((input.highlights?.length || 0) > 20)
    throw new Error("Too many report highlights (20 max)");
  const highlights = input.highlights?.map((highlight, index) => {
    if (!highlight || typeof highlight !== "object")
      throw new Error(`Invalid report highlight ${index + 1}`);
    const title = String(highlight.title || "")
      .trim()
      .slice(0, 200);
    const summary = String(highlight.summary || "")
      .trim()
      .slice(0, 2000);
    if (!title || !summary)
      throw new Error(
        `Report highlight ${index + 1} needs a title and summary`,
      );
    if (!REPORT_URGENCIES.includes(highlight.urgency))
      throw new Error(`Invalid urgency on report highlight ${index + 1}`);
    if (!REPORT_CONFIDENCES.includes(highlight.confidence))
      throw new Error(`Invalid confidence on report highlight ${index + 1}`);
    if ((highlight.sourceRefs?.length || 0) > 20)
      throw new Error(
        `Too many source references on report highlight ${index + 1}`,
      );
    const sourceRefs = highlight.sourceRefs
      ?.map((ref) =>
        String(ref || "")
          .trim()
          .slice(0, 500),
      )
      .filter(Boolean);
    return {
      title,
      summary,
      urgency: highlight.urgency,
      confidence: highlight.confidence,
      ...(sourceRefs?.length ? { sourceRefs } : {}),
    };
  });
  if ((input.tasks?.length || 0) > MAX_REPORT_TASKS)
    throw new Error(`Too many report tasks (${MAX_REPORT_TASKS} max)`);
  const tasks = input.tasks?.map((task, index) => {
    if (!task || typeof task !== "object")
      throw new Error(`Invalid report task ${index + 1}`);
    const title = String(task.title || "")
      .trim()
      .slice(0, 200);
    // Truncating a prompt would hand an agent a sentence that stops
    // mid-instruction, so an over-long one is refused instead.
    const prompt = String(task.prompt || "").trim();
    if (!title || !prompt)
      throw new Error(`Report task ${index + 1} needs a title and a prompt`);
    if (prompt.length > MAX_REPORT_TASK_PROMPT)
      throw new Error(
        `Report task ${index + 1} prompt is too long (${prompt.length} > ${MAX_REPORT_TASK_PROMPT})`,
      );
    return { title, prompt };
  });
  // 2026-07-12-060002-4f3a: lexicographic = chronological, readable on disk.
  const stamp = now
    .toISOString()
    .slice(0, 19)
    .replace("T", "-")
    .replace(/:/g, "");
  const id = `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
  const meta: ReportMeta = {
    id,
    title: (input.title || "Untitled report").trim().slice(0, 200),
    automationId: input.automationId,
    automationName: (input.automationName || "?").trim().slice(0, 120),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdAt: now.toISOString(),
    ...(input.summary ? { summary: input.summary.trim().slice(0, 2000) } : {}),
    ...(input.urgency ? { urgency: input.urgency } : {}),
    ...(input.confidence ? { confidence: input.confidence } : {}),
    ...(highlights?.length ? { highlights } : {}),
    ...(tasks?.length ? { tasks } : {}),
  };
  const dir = groupDir(input.automationId);
  mkdirSync(dir, { recursive: true });
  removeOrphanAssets(input.automationId);
  try {
    for (const asset of validatedAssets) {
      const { abs } = resolveReportAssetPath(
        input.automationId,
        id,
        asset.path,
      );
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, asset.data);
    }
    writeFileSync(join(dir, `${id}.html`), input.html, "utf8");
    // The sidecar is written last: its presence makes the report discoverable.
    writeJsonAtomic(join(dir, `${id}.json`), meta);
  } catch (error) {
    rmSync(join(dir, `${id}.html`), { force: true });
    rmSync(join(dir, `${id}.json`), { force: true });
    rmSync(reportAssetsDir(input.automationId, id), {
      recursive: true,
      force: true,
    });
    throw error;
  }
  projectSessionReport(meta);
  // Prune beyond the cap (both files) — newest first, drop the tail.
  const sidecars = sidecarsFor(input.automationId);
  trackProjection(
    catalogDocuments(REPORT_GROUPS_NAMESPACE).set(input.automationId, {
      automationName: meta.automationName,
      count: Math.min(sidecars.length, MAX_REPORTS_PER_GROUP),
      latest: meta,
    } satisfies StoredReportGroup),
    `group ${input.automationId}`,
  );
  for (const stale of sidecars.slice(MAX_REPORTS_PER_GROUP)) {
    try {
      const staleMeta = readMeta(input.automationId, stale);
      unprojectSessionReport(staleMeta);
      rmSync(join(dir, stale));
      rmSync(join(dir, stale.replace(/\.json$/, ".html")), {
        force: true,
      });
      const staleId = stale.replace(/\.json$/, "");
      rmSync(reportAssetsDir(input.automationId, staleId), {
        recursive: true,
        force: true,
      });
    } catch {}
  }
  broadcastToAll({
    type: "reports_changed",
    automationId: input.automationId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  return meta;
}

/** One row per automation that has published at least one report, newest
 *  first, from the catalog projection. */
export async function listReportGroups(): Promise<ReportGroup[]> {
  await projectionWrites; // this process's own publishes are visible
  const rows = await catalogDocuments(REPORT_GROUPS_NAMESPACE).list();
  return rows
    .map((row) => ({
      automationId: row.key,
      ...(row.value as StoredReportGroup),
    }))
    .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}

/** One report's metadata, or null when it doesn't exist. */
export function getReport(
  automationId: string,
  reportId: string,
): ReportMeta | null {
  if (!safeSegment(automationId) || !safeSegment(reportId)) return null;
  return readMeta(automationId, `${reportId}.json`);
}

/** A group's full history, newest first. */
export function listReports(automationId: string): ReportMeta[] {
  if (!safeSegment(automationId)) return [];
  return sidecarsFor(automationId)
    .map((s) => readMeta(automationId, s))
    .filter((m): m is ReportMeta => !!m);
}

/** Every report produced by one session, newest first, from the catalog. */
export async function listReportsForSession(
  sessionId: string,
): Promise<ReportMeta[]> {
  if (!safeSegment(sessionId)) return [];
  await projectionWrites; // this process's own publishes are visible
  return (
    ((await catalogDocuments(SESSION_REPORTS_NAMESPACE).get(sessionId)) as
      | ReportMeta[]
      | null) ?? []
  );
}

/** One-time catalog import: both projections from the report files. Reads
 *  asynchronously; never called on a request path. */
let seedRows: ReturnType<typeof readReportSeedRows> | null = null;
export function reportCatalogSeedRows(): ReturnType<typeof readReportSeedRows> {
  return (seedRows ??= readReportSeedRows());
}

async function readReportSeedRows(): Promise<{
  groups: Array<{ key: string; value: string }>;
  sessions: Array<{ key: string; value: string }>;
}> {
  const groups: Array<{ key: string; value: string }> = [];
  const bySession = new Map<string, ReportMeta[]>();
  let automationIds: string[];
  try {
    automationIds = (await readdir(reportsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeSegment(entry.name))
      .map((entry) => entry.name);
  } catch {
    return { groups, sessions: [] };
  }
  for (const automationId of automationIds) {
    let sidecars: string[];
    try {
      sidecars = (await readdir(groupDir(automationId)))
        .filter((file) => file.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    let latest: ReportMeta | null = null;
    for (const sidecar of sidecars) {
      let meta: ReportMeta;
      try {
        meta = JSON.parse(
          await readFile(join(groupDir(automationId), sidecar), "utf8"),
        ) as ReportMeta;
      } catch {
        continue;
      }
      if (!meta || typeof meta.id !== "string") continue;
      latest ??= meta;
      if (meta.sessionId) {
        const list = bySession.get(meta.sessionId) ?? [];
        list.push(meta);
        bySession.set(meta.sessionId, list);
      }
    }
    if (latest)
      groups.push({
        key: automationId,
        value: JSON.stringify({
          automationName: latest.automationName,
          count: sidecars.length,
          latest,
        } satisfies StoredReportGroup),
      });
  }
  return {
    groups,
    sessions: [...bySession].map(([key, reports]) => ({
      key,
      value: JSON.stringify(newestFirst(reports)),
    })),
  };
}

/** Repair after a fresh import: groups whose directory changed since `since`
 *  are recomputed, and their reports written since then are merged into the
 *  session projection. Covers publishes by a previous gateway mid-import. */
export async function reconcileReportCatalog(since: number): Promise<void> {
  let automationIds: string[];
  try {
    automationIds = (await readdir(reportsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeSegment(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const automationId of automationIds) {
    const dir = groupDir(automationId);
    try {
      if ((await stat(dir)).mtimeMs < since) continue;
      const sidecars = (await readdir(dir))
        .filter((file) => file.endsWith(".json"))
        .sort()
        .reverse();
      let latest: ReportMeta | null = null;
      for (const sidecar of sidecars) {
        const path = join(dir, sidecar);
        const fresh = (await stat(path)).mtimeMs >= since;
        if (latest && !fresh) break; // older sidecars are already indexed
        const meta = JSON.parse(await readFile(path, "utf8")) as ReportMeta;
        if (!meta || typeof meta.id !== "string") continue;
        latest ??= meta;
        if (fresh) projectSessionReport(meta);
      }
      if (latest)
        trackProjection(
          catalogDocuments(REPORT_GROUPS_NAMESPACE).set(automationId, {
            automationName: latest.automationName,
            count: sidecars.length,
            latest,
          } satisfies StoredReportGroup),
          `group ${automationId}`,
        );
    } catch {}
  }
  await projectionWrites;
}

/** The report HTML itself, or null when it doesn't exist. */
export function readReportHtml(
  automationId: string,
  reportId: string,
): string | null {
  if (!safeSegment(automationId) || !safeSegment(reportId)) return null;
  const file = join(groupDir(automationId), `${reportId}.html`);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** A durable report asset's absolute path, or null when it doesn't exist. */
export function readReportAsset(
  automationId: string,
  reportId: string,
  path: string,
): { path: string; rel: string } | null {
  try {
    if (!safeSegment(automationId) || !safeSegment(reportId)) return null;
    if (!existsSync(join(groupDir(automationId), `${reportId}.json`)))
      return null;
    const { abs, rel } = resolveReportAssetPath(automationId, reportId, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return { path: abs, rel };
  } catch {
    return null;
  }
}
