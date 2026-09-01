/**
 * Grafana poller — one generic engine that drives every "poll a Loki failure
 * signal → investigate each fresh failure" automation.
 *
 * An automation opts in by carrying a `grafanaPoll` config (see
 * server/automations.ts `GrafanaPollConfig`). Each tick this agent reads the
 * live automation list, and for every enabled automation with a `grafanaPoll`
 * whose poll interval has elapsed it:
 *   1. re-runs the configured Loki instant query,
 *   2. collapses the series to one row per distinct `dedupLabel` value,
 *   3. for each value not investigated within `dedupDays`, posts a control card
 *      to the configured Slack channel ("Open in Open Session" + Stop) and fires one
 *      run of that automation, handing it the matched Loki labels as the
 *      triggering event.
 *
 * Because the automation list is re-read every tick, adding a NEW failure-signal
 * investigator is pure data — create an automation with a `grafanaPoll` config
 * via the API or `integrations.seeds.automations`; no code change or restart.
 *
 * Investigation only — the runs never retry/recover; they open a PR only when
 * highly confident, else discuss in the card thread.
 */
import { configuredServer, productName } from "../../server/config";
import { stateDir } from "../../server/paths";
import { randomUUIDv7 } from "bun";
import { mkdirSync, readFileSync, existsSync, unlinkSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import type { AgentModule } from "../types";
import {
  listAutomations,
  runAutomation,
  type Automation,
  type GrafanaPollConfig,
} from "../../server/automations";
import { postSlackBlocks, updateSlackBlocks } from "../slack/slack-api";

const DEDUP_ROOT = stateDir("grafana-poll");

const GRAFANA_URL = process.env.GRAFANA_URL || "";
const GRAFANA_TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN || "";
const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID || "loki";

const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

const DEFAULT_LOOKBACK = "20m";
const DEFAULT_POLL_MINUTES = 15;
const DEFAULT_DEDUP_DAYS = 7;
const DEFAULT_NAMESPACE = "prod";

// How often the engine wakes to check whether any automation is due to poll.
const TICK_MS = 60 * 1000;

// ── Loki ─────────────────────────────────────────────────────

interface LokiSeries {
  metric: Record<string, string>;
  value: [number, string];
}

async function queryLoki(cfg: GrafanaPollConfig): Promise<LokiSeries[]> {
  const lookback = cfg.lookback || DEFAULT_LOOKBACK;
  const query = cfg.lokiQuery.replaceAll("$LOOKBACK", lookback);
  const endpoint = `${GRAFANA_URL}/api/datasources/proxy/uid/${LOKI_DATASOURCE_UID}/loki/api/v1/query`;
  const url = new URL(endpoint);
  url.searchParams.set("query", query);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${GRAFANA_TOKEN}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.error(
        `[grafana-poller] Loki query failed: ${resp.status} ${await resp.text()}`,
      );
      return [];
    }
    const data = (await resp.json()) as any;
    if (data?.status !== "success") {
      console.error(
        "[grafana-poller] Loki non-success:",
        JSON.stringify(data).slice(0, 300),
      );
      return [];
    }
    return (data.data?.result || []) as LokiSeries[];
  } finally {
    clearTimeout(timer);
  }
}

interface Failure {
  /** The distinct `dedupLabel` value — one investigation per value. */
  dedupValue: string;
  /** Representative Loki labels for this failure (merged across its series). */
  labels: Record<string, string>;
  /** Distinct Temporal run ids seen failing (retries). */
  runIds: string[];
}

function isPresent(v?: string): v is string {
  return !!v && v !== "None";
}

/** Collapse Loki series into one row per distinct dedupLabel value. */
function groupByDedup(series: LokiSeries[], cfg: GrafanaPollConfig): Failure[] {
  const namespace = cfg.namespace ?? DEFAULT_NAMESPACE;
  const byValue = new Map<string, Failure>();

  for (const s of series) {
    const m = s.metric;
    if (namespace && (m.namespace || "") !== namespace) continue;
    const dedupValue = m[cfg.dedupLabel];
    if (!dedupValue) continue;

    const runId = m.run_id;
    const existing = byValue.get(dedupValue);
    if (!existing) {
      byValue.set(dedupValue, {
        dedupValue,
        labels: { ...m },
        runIds: runId ? [runId] : [],
      });
      continue;
    }
    if (runId && !existing.runIds.includes(runId)) existing.runIds.push(runId);
    // Backfill any label this series has that the representative one was missing.
    for (const [k, v] of Object.entries(m)) {
      if (!isPresent(existing.labels[k]) && isPresent(v))
        existing.labels[k] = v;
    }
  }

  return [...byValue.values()];
}

// ── Dedup store (per automation) ─────────────────────────────

interface DedupRecord {
  dedupValue: string;
  firstSeen: string;
  lastInvestigatedAt: string;
  osSessionId: string;
  slackTs?: string;
}

function dedupDir(automationId: string): string {
  const dir = `${DEDUP_ROOT}/${automationId}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dedupPath(automationId: string, dedupValue: string): string {
  const safe = dedupValue.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${dedupDir(automationId)}/${safe}.json`;
}

function readDedup(
  automationId: string,
  dedupValue: string,
): DedupRecord | null {
  const path = dedupPath(automationId, dedupValue);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DedupRecord;
  } catch {
    return null;
  }
}

function recentlyInvestigated(
  automationId: string,
  dedupValue: string,
  dedupDays: number,
): boolean {
  const rec = readDedup(automationId, dedupValue);
  if (!rec) return false;
  const last = Date.parse(rec.lastInvestigatedAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last < dedupDays * 24 * 60 * 60 * 1000;
}

function writeDedup(automationId: string, rec: DedupRecord): void {
  writeJsonAtomic(dedupPath(automationId, rec.dedupValue), rec);
}

// ── Slack control card ───────────────────────────────────────

function controlCardBlocks(
  cfg: GrafanaPollConfig,
  failure: Failure,
  bksId: string,
  running: boolean,
) {
  // A friendly human label if the signal carries one, else the card title.
  const friendly =
    (isPresent(failure.labels.story_name) && failure.labels.story_name) ||
    (isPresent(failure.labels.user_email) && failure.labels.user_email) ||
    null;
  const heading = friendly ? `*${friendly}*` : `*${cfg.cardTitle}*`;
  const attempts =
    failure.runIds.length > 1
      ? `  ·  *Attempts:* ${failure.runIds.length}`
      : "";

  const sectionText = [
    `:mag: Investigating ${cfg.cardTitle} — ${heading}`,
    `*${cfg.dedupLabel}:* \`${failure.dedupValue}\`${attempts}`,
  ].join("\n");

  const opensessionButton = {
    type: "button",
    text: {
      type: "plain_text",
      text: `:desktop_computer: Open in ${productName()}`,
      emoji: true,
    },
    url: `${UI_BASE}/session/${bksId}`,
    action_id: `opensession:${bksId}`,
  };
  const stopButton = {
    type: "button",
    text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
    style: "danger",
    action_id: `investigate-stop:${bksId}`,
    value: bksId,
  };

  return [
    { type: "section", text: { type: "mrkdwn", text: sectionText } },
    {
      type: "actions",
      block_id: `investigation-${bksId}`,
      elements: running ? [opensessionButton, stopButton] : [opensessionButton],
    },
  ];
}

// ── Investigate one failure ──────────────────────────────────

async function investigate(
  automation: Automation,
  cfg: GrafanaPollConfig,
  failure: Failure,
  onSessionInvalidate?: () => void,
): Promise<void> {
  const bksId = `bks-${randomUUIDv7()}`;
  const nowIso = new Date().toISOString();

  // Claim the dedup slot BEFORE the async work so an overlapping poll can't
  // double-fire the same failure.
  const prior = readDedup(automation.id, failure.dedupValue);
  const base: DedupRecord = {
    dedupValue: failure.dedupValue,
    firstSeen: prior?.firstSeen || nowIso,
    lastInvestigatedAt: nowIso,
    osSessionId: bksId,
  };
  writeDedup(automation.id, base);

  let slackTs: string | undefined;
  try {
    const card = await postSlackBlocks(
      cfg.slackChannel,
      `Investigating ${cfg.cardTitle} for ${failure.dedupValue}`,
      controlCardBlocks(cfg, failure, bksId, true),
    );
    slackTs = card?.ts;
  } catch (e) {
    console.error("[grafana-poller] Failed to post Slack control card:", e);
  }
  if (slackTs) writeDedup(automation.id, { ...base, slackTs });

  const eventContext = JSON.stringify(
    {
      source: "grafana-poller",
      automationId: automation.id,
      automationName: automation.name,
      dedupLabel: cfg.dedupLabel,
      dedupValue: failure.dedupValue,
      attempts: failure.runIds.length,
      // All matched Loki labels (story_id / streaming_upload_id / workflow_id /
      // namespace / user_email / story_name / run_id …) at the top level.
      ...failure.labels,
      title: `${cfg.cardTitle} — ${failure.dedupValue}`,
      slackChannelId: cfg.slackChannel,
      slackThreadTs: slackTs || null,
    },
    null,
    2,
  );

  console.log(
    `[grafana-poller] Investigating ${cfg.dedupLabel}=${failure.dedupValue} → ${bksId}`,
  );

  void runAutomation(automation, onSessionInvalidate, {
    trigger: "event",
    osSessionId: bksId,
    eventContext,
  })
    .catch((e) => {
      console.error(
        `[grafana-poller] runAutomation failed for ${failure.dedupValue}:`,
        e,
      );
      // The dedup slot was stamped before launch (to stop an overlapping poll
      // from double-firing) — but a crashed launch must not mute this alert
      // for dedupDays. Roll the stamp back so the next poll retries.
      try {
        if (prior) writeDedup(automation.id, prior);
        else unlinkSync(dedupPath(automation.id, failure.dedupValue));
      } catch (e2) {
        console.error(
          `[grafana-poller] Failed to roll back dedup stamp for ${failure.dedupValue}:`,
          e2,
        );
      }
    })
    .finally(() => {
      if (!slackTs) return;
      void updateSlackBlocks(
        cfg.slackChannel,
        slackTs,
        `Investigation for ${failure.dedupValue}`,
        controlCardBlocks(cfg, failure, bksId, false),
      ).catch(() => {});
    });
}

// ── Poll one automation ──────────────────────────────────────

const pollingNow = new Set<string>();

async function pollAutomation(
  automation: Automation,
  onSessionInvalidate?: () => void,
): Promise<void> {
  const cfg = automation.grafanaPoll;
  if (!cfg) return;
  if (pollingNow.has(automation.id)) return;
  pollingNow.add(automation.id);
  try {
    const series = await queryLoki(cfg);
    const failures = groupByDedup(series, cfg);
    if (!failures.length) return;

    const dedupDays = cfg.dedupDays || DEFAULT_DEDUP_DAYS;
    const fresh = failures.filter(
      (f) => !recentlyInvestigated(automation.id, f.dedupValue, dedupDays),
    );
    console.log(
      `[grafana-poller] "${automation.name}": ${failures.length} failing, ${fresh.length} new`,
    );

    // Sequentially so each dedup claim is committed before the next; the
    // investigations themselves run concurrently as event automations.
    for (const failure of fresh) {
      await investigate(automation, cfg, failure, onSessionInvalidate);
    }
  } catch (e) {
    console.error(`[grafana-poller] Poll error for "${automation.name}":`, e);
  } finally {
    pollingNow.delete(automation.id);
  }
}

// ── Agent module ─────────────────────────────────────────────

export class GrafanaPollerAgent implements AgentModule {
  name = "grafana-poller";

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onSessionInvalidate?: () => void;
  /** automationId → last poll timestamp (ms). */
  private readonly lastPolled = new Map<string, number>();

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  /** Automations that are due for a poll this tick. */
  private due(now: number): Automation[] {
    return listAutomations().filter((a) => {
      if (!a.enabled || !a.grafanaPoll) return false;
      const intervalMs =
        (a.grafanaPoll.pollMinutes || DEFAULT_POLL_MINUTES) * 60 * 1000;
      const last = this.lastPolled.get(a.id) || 0;
      return now - last >= intervalMs;
    });
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // Manual trigger: POST /grafana-poll/<automationId>/<secret> { "value": "...", "force": true }
    // Path-auth on the automation's webhook secret, same model as the automations webhook.
    routes.set("POST /grafana-poll/*", async (req, url) => {
      const m = url.pathname.match(/^\/grafana-poll\/([^/]+)\/([^/]+)$/);
      if (!m) return Response.json({ error: "Bad path" }, { status: 400 });

      const automation = listAutomations().find((a) => a.id === m[1]);
      if (
        !automation ||
        !automation.grafanaPoll ||
        automation.webhookSecret !== m[2]
      ) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const cfg = automation.grafanaPoll;

      let body: any = {};
      try {
        body = JSON.parse(await readRequestTextWithinLimit(req, 64 * 1024));
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(64 * 1024);
      }
      const value = typeof body?.value === "string" ? body.value.trim() : "";
      if (!value)
        return Response.json({ error: "value required" }, { status: 400 });

      const force = body?.force === true;
      const dedupDays = cfg.dedupDays || DEFAULT_DEDUP_DAYS;
      if (!force && recentlyInvestigated(automation.id, value, dedupDays)) {
        return Response.json({
          ok: false,
          skipped: `investigated within ${dedupDays} days`,
        });
      }

      // Enrich from a live query if the value currently shows in the signal.
      const failures = groupByDedup(await queryLoki(cfg), cfg);
      const failure: Failure = failures.find((f) => f.dedupValue === value) || {
        dedupValue: value,
        labels: { [cfg.dedupLabel]: value },
        runIds: [],
      };

      void investigate(automation, cfg, failure, this.onSessionInvalidate);
      return Response.json({ ok: true, value });
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (!GRAFANA_URL || !GRAFANA_TOKEN) {
      console.warn(
        "[grafana-poller] GRAFANA_URL/GRAFANA_SERVICE_ACCOUNT_TOKEN unset — poller disabled",
      );
      return;
    }

    this.timer = setInterval(() => {
      const now = Date.now();
      for (const automation of this.due(now)) {
        this.lastPolled.set(automation.id, now);
        void pollAutomation(automation, this.onSessionInvalidate);
      }
    }, TICK_MS);

    const names = listAutomations()
      .filter((a) => a.grafanaPoll)
      .map((a) => a.name);
    console.log(
      `[grafana-poller] Agent started — ${names.length} poll automation(s): ${names.join(", ") || "none yet"}`,
    );
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health(): Record<string, unknown> {
    const polls = listAutomations()
      .filter((a) => a.grafanaPoll)
      .map((a) => ({
        name: a.name,
        enabled: a.enabled,
        channel: a.grafanaPoll?.slackChannel,
      }));
    return {
      status:
        GRAFANA_URL && GRAFANA_TOKEN
          ? "operational"
          : "missing GRAFANA credentials",
      polls,
    };
  }
}
