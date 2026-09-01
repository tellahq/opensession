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
import { dirname, join, normalize, resolve } from "path";
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

let sessionReportIndex: Map<string, ReportMeta[]> | null = null;

/** Test seam for suites that create sidecars directly instead of publishReport. */
export function __resetReportIndexForTest(): void {
  if (process.env.NODE_ENV === "test") sessionReportIndex = null;
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

function indexReport(meta: ReportMeta | null): void {
  if (!sessionReportIndex || !meta?.sessionId) return;
  const reports = sessionReportIndex.get(meta.sessionId) || [];
  reports.push(meta);
  reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  sessionReportIndex.set(meta.sessionId, reports);
}

function removeIndexedReport(meta: ReportMeta | null): void {
  if (!sessionReportIndex || !meta?.sessionId) return;
  const reports = sessionReportIndex
    .get(meta.sessionId)
    ?.filter(
      (report) =>
        report.id !== meta.id || report.automationId !== meta.automationId,
    );
  if (reports?.length) sessionReportIndex.set(meta.sessionId, reports);
  else sessionReportIndex.delete(meta.sessionId);
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
  indexReport(meta);
  // Prune beyond the cap (both files) — newest first, drop the tail.
  for (const stale of sidecarsFor(input.automationId).slice(
    MAX_REPORTS_PER_GROUP,
  )) {
    try {
      const staleMeta = readMeta(input.automationId, stale);
      removeIndexedReport(staleMeta);
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

/** One row per automation that has published at least one report. */
export function listReportGroups(): ReportGroup[] {
  if (!existsSync(reportsRoot())) return [];
  const groups: ReportGroup[] = [];
  for (const entry of readdirSync(reportsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const sidecars = sidecarsFor(entry.name);
    if (!sidecars.length) continue;
    const latest = readMeta(entry.name, sidecars[0]);
    if (!latest) continue;
    groups.push({
      automationId: entry.name,
      automationName: latest.automationName,
      count: sidecars.length,
      latest,
    });
  }
  return groups.sort((a, b) =>
    b.latest.createdAt.localeCompare(a.latest.createdAt),
  );
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

/** Every report produced by one session, newest first. */
export function listReportsForSession(sessionId: string): ReportMeta[] {
  if (!safeSegment(sessionId) || !existsSync(reportsRoot())) return [];
  if (!sessionReportIndex) {
    sessionReportIndex = new Map();
    for (const entry of readdirSync(reportsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
      for (const sidecar of sidecarsFor(entry.name)) {
        const meta = readMeta(entry.name, sidecar);
        indexReport(meta);
      }
    }
  }
  return sessionReportIndex.get(sessionId) || [];
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
