/**
 * Health check, macropad keypad feed, in-process frontend rebuild, HTTP upload staging, audit-log viewer.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { type RouteContext, requestUser } from "./context";
import { activeAgentRunCount } from "../agent-runner";
import { getAgents } from "../agents-registry";
import { configuredServer } from "../config";
import { claudeCliStatus } from "../engine-status";
import { IS_DEV, buildFrontend, frontend, isPrebuiltFrontend, sharedCheckoutEditors } from "../frontend-build";
import { getPins } from "../pins";
import { getReads, isUnread } from "../reads";
import { runErrors } from "../session-cache";
import { getSessionControl } from "../session-control";
import { MAX_UPLOAD_BYTES, stageHttpUpload } from "../uploads";
import { BOOT_ID, broadcastToAll } from "../ws-hub";

/** Host metrics for the health endpoint. The health-monitor automation runs
 *  in ask mode on the opencode engine, where the bash tool is unavailable to
 *  unattended runs — webfetching this endpoint is its only way to see disk/
 *  memory/CPU, so keep these fields stable. */
function systemStats(): Record<string, unknown> {
	try {
		const mem: Record<string, number> = {};
		for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
			const m = line.match(/^(\w+):\s+(\d+) kB/);
			if (m) mem[m[1]] = Number(m[2]) * 1024;
		}
		const s = statfsSync("/");
		const totalBytes = s.blocks * s.bsize;
		const availBytes = s.bavail * s.bsize;
		const [load1, load5, load15] = loadavg();
		return {
			disk: {
				mount: "/",
				totalGb: +(totalBytes / 1e9).toFixed(1),
				availGb: +(availBytes / 1e9).toFixed(1),
				usedPct: +((1 - availBytes / totalBytes) * 100).toFixed(1),
			},
			memory: {
				totalGb: +((mem.MemTotal || 0) / 1e9).toFixed(2),
				availableGb: +((mem.MemAvailable || 0) / 1e9).toFixed(2),
				availablePct: mem.MemTotal
					? +(((mem.MemAvailable || 0) / mem.MemTotal) * 100).toFixed(1)
					: null,
				swapUsedGb: +(((mem.SwapTotal || 0) - (mem.SwapFree || 0)) / 1e9).toFixed(2),
			},
			load: { "1m": load1, "5m": load5, "15m": load15, cores: cpus().length },
			processes: processCensus(),
			cgroups: cgroupCensus(),
		};
	} catch (e) {
		return { error: String((e as Error)?.message || e) };
	}
}

interface CgroupMemorySnapshot {
	unit: string;
	currentGb: number;
	peakGb: number | null;
	anonGb: number;
	fileGb: number;
	highGb: number | null;
	maxGb: number | null;
	tasks: number | null;
	oom: number;
	oomKill: number;
}

const gb = (bytes: number): number => +(bytes / 1e9).toFixed(2);

function readCgroupNumber(path: string): number | null {
	try {
		const value = readFileSync(path, "utf8").trim();
		if (!value || value === "max") return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function readCgroupMap(path: string): Record<string, number> {
	const values: Record<string, number> = {};
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const [key, raw] = line.trim().split(/\s+/, 2);
			const parsed = Number(raw);
			if (key && Number.isFinite(parsed)) values[key] = parsed;
		}
	} catch {}
	return values;
}

function cgroupSnapshot(dir: string): CgroupMemorySnapshot | null {
	const current = readCgroupNumber(`${dir}/memory.current`);
	if (current == null) return null;
	const peak = readCgroupNumber(`${dir}/memory.peak`);
	const high = readCgroupNumber(`${dir}/memory.high`);
	const max = readCgroupNumber(`${dir}/memory.max`);
	const tasks = readCgroupNumber(`${dir}/pids.current`);
	const stat = readCgroupMap(`${dir}/memory.stat`);
	const events = readCgroupMap(`${dir}/memory.events`);
	return {
		unit: dir.slice(dir.lastIndexOf("/") + 1),
		currentGb: gb(current),
		peakGb: peak == null ? null : gb(peak),
		anonGb: gb(stat.anon || 0),
		fileGb: gb(stat.file || 0),
		highGb: high == null ? null : gb(high),
		maxGb: max == null ? null : gb(max),
		tasks,
		oom: events.oom || 0,
		oomKill: events.oom_kill || 0,
	};
}

function collectScopeDirs(root: string, out: string[], depth = 0): void {
	if (depth > 5) return;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = `${root}/${entry.name}`;
			if (/^opensession-(?:oc|preview)-.*\.scope$/.test(entry.name)) {
				out.push(path);
				continue;
			}
			collectScopeDirs(path, out, depth + 1);
		}
	} catch {}
}

function summarizeScopes(scopes: CgroupMemorySnapshot[]): Record<string, unknown> {
	const sorted = scopes.sort((a, b) => b.currentGb - a.currentGb);
	return {
		count: sorted.length,
		currentGb: +sorted.reduce((sum, scope) => sum + scope.currentGb, 0).toFixed(2),
		anonGb: +sorted.reduce((sum, scope) => sum + scope.anonGb, 0).toFixed(2),
		fileGb: +sorted.reduce((sum, scope) => sum + scope.fileGb, 0).toFixed(2),
		oomKills: sorted.reduce((sum, scope) => sum + scope.oomKill, 0),
		top: sorted.slice(0, 5),
	};
}

let cgroupCache: { at: number; data: Record<string, unknown> } | null = null;

/** cgroup v2 resource accounting for the coordinator and detached fleets.
 * Includes anon vs file cache so a reclaimable compiler cache is not mistaken
 * for the anonymous-memory exhaustion that wedged the host on 2026-07-31. */
function cgroupCensus(): Record<string, unknown> {
	if (cgroupCache && Date.now() - cgroupCache.at < 60_000) return cgroupCache.data;
	try {
		const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
		const userRoot = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
		const dirs: string[] = [];
		collectScopeDirs(userRoot, dirs);
		const snapshots = dirs
			.map(cgroupSnapshot)
			.filter((snapshot): snapshot is CgroupMemorySnapshot => snapshot != null);
		const selfRelative = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"))
			?.slice(3);
		const data = {
			coordinator: selfRelative ? cgroupSnapshot(`/sys/fs/cgroup${selfRelative}`) : null,
			user: cgroupSnapshot(userRoot),
			engines: summarizeScopes(snapshots.filter((scope) => scope.unit.startsWith("opensession-oc-"))),
			previews: summarizeScopes(
				snapshots.filter((scope) => scope.unit.startsWith("opensession-preview-")),
			),
		};
		cgroupCache = { at: Date.now(), data };
		return data;
	} catch (e) {
		return { error: String((e as Error)?.message || e) };
	}
}

/** Counts of the process fleets that have historically leaked or ballooned
 *  (2026-07-27: 664 mcp-proxies / 42GB RSS, 26 orphaned opencode scopes, a
 *  3-day goldenbuild dev stack). Surfacing them here lets the health-monitor
 *  automation name the offender in an alert instead of just "high load".
 *  /proc scan, 60s-cached — RestartOverlay polls this endpoint at 1.5s during
 *  incidents. */
let censusCache: { at: number; data: Record<string, number> } | null = null;
function processCensus(): Record<string, number> {
	if (censusCache && Date.now() - censusCache.at < 60_000) return censusCache.data;
	const counts = {
		opencodeServers: 0,
		mcpProxies: 0,
		chrome: 0,
		nextDev: 0,
		gitOps: 0,
		total: 0,
	};
	try {
		for (const pid of readdirSync("/proc")) {
			if (!/^\d+$/.test(pid)) continue;
			counts.total++;
			let cmd = "";
			try {
				cmd = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replaceAll("\0", " ");
			} catch {
				continue; // process exited mid-scan
			}
			if (cmd.includes("opencode serve")) counts.opencodeServers++;
			else if (cmd.includes("mcp-proxy.")) counts.mcpProxies++;
			else if (cmd.includes("/chrome") && cmd.includes("--headless")) counts.chrome++;
			// One per dev stack: a `just dev-next` stack spawns ~6 processes whose
			// cmdline mentions "next dev" (bunx/concurrently/sh/bun/node), so count
			// only the next-server root or 2 healthy stacks read as 12 "leaks".
			else if (cmd.startsWith("next-server")) counts.nextDev++;
			else if (/(^|\/)git(-lfs)? /.test(cmd)) counts.gitOps++;
		}
	} catch {}
	censusCache = { at: Date.now(), data: counts };
	return counts;
}

export async function handleSystemRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Health check (includes agent health — Tailscale-only, not public).
	// frontendVersion lets clients detect a frontend-only rebuild (no bootId
	// change) and refresh.
	if (path === "/api/health") {
		const agentHealth: Record<string, unknown> = {};
		for (const a of getAgents()) {
			agentHealth[a.name] = a.health();
		}
		return Response.json({
			ok: true,
			bootId: BOOT_ID,
			frontendVersion: frontend?.version ?? null,
			uptime: process.uptime(),
			// In-flight runner runs this process is driving — a drain-aware deploy
			// polls this to restart only when the service is idle (or near it), so a
			// restart kills as few in-flight runs/background tasks as possible.
			activeRuns: activeAgentRunCount(),
			agents: agentHealth,
			// The `claude` CLI every Anthropic turn execs (the release ships no
			// bundled Claude Code). Missing here means turns fail; ok stays true
			// because the server itself is up.
			engine: { claudeCli: claudeCliStatus() },
			system: systemStats(),
		});
	}

	// ── Macropad status feed ──
	// A user's pinned sessions (pinned order, max 8) with a coarse status per
	// key, for a hardware keypad. Polled ~every 1.5s, so it only touches
	// in-memory state: the per-user pins file plus the 2s session cache behind
	// SessionControl. The central auth gate accepts either a signed-in web
	// session or the route-scoped KEYPAD_TOKEN bearer credential.
	if (path === "/api/keypad" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		const control = getSessionControl();
		// Per-user read marks (mirrored from the app's localStorage — reads.ts),
		// so a finished session with activity newer than the last-read mark shows
		// as unread on the macropad.
		const reads = getReads(user);
		// Canonical open-in-app link per session (the macropad opens it on
		// keypress) — same shape as the frontend's session path helper (share-link.ts):
		// workspace-scoped when the session belongs to a Project.
		const uiBase = configuredServer().publicBaseUrl;
		const sessions: Array<{
			id: string;
			title: string;
			status: "idle" | "working" | "needs_input" | "unread" | "error";
			url: string;
		}> = [];
		for (const key of getPins(user)) {
			if (sessions.length >= 8) break;
			// Pins also hold workspace rows (`workspace:<id>`) — not sessions.
			if (key.startsWith("workspace:")) continue;
			const s = control.getSession(key);
			if (!s || s.state === "archived") continue;
			// A queued prompt means the session is about to run — show it as
			// working, same as taskStateOf (sessions-tools.ts). An engine session
			// id means it has run before, so an idle session with one is "done";
			// without one it's a fresh pinned session that never ran.
			const lastRunError = runErrors.get(s.id) || s.lastRunError;
			// Precedence (first match wins) — surface the single most important
			// thing: error > working > needs_input > unread > idle. The old "done"
			// (finished, has run before) collapses into idle; "unread" is the
			// finished-with-new-activity case (lastActivity newer than the user's
			// read mark). See src/server/reads.ts.
			const status: "idle" | "working" | "needs_input" | "unread" | "error" =
				lastRunError
					? "error"
					: s.state === "running" || s.state === "queued"
						? "working"
						: s.state === "waiting_question"
							? "needs_input"
							: isUnread(s.lastActivity, reads[s.id])
								? "unread"
								: "idle";
			const sessionUrl = s.workspaceId
				? `${uiBase}/workspace/${encodeURIComponent(s.workspaceId)}/session/${encodeURIComponent(s.id)}`
				: `${uiBase}/session/${encodeURIComponent(s.id)}`;
			sessions.push({
				id: s.id,
				title: s.title || "Untitled",
				status,
				url: sessionUrl,
			});
		}
		return Response.json({ sessions });
	}

	// Rebuild the frontend bundle in-process (no restart → live runs untouched).
	// Drop-in replacement for `systemctl restart opensession` after a frontend/CSS
	// change. Tailscale + team gated at the network layer like every route here.
	if (path === "/api/rebuild-frontend" && req.method === "POST") {
		if (IS_DEV || !frontend) {
			return Response.json(
				{ ok: false, error: "not available in dev mode" },
				{ status: 400 },
			);
		}
		if (isPrebuiltFrontend()) {
			return Response.json(
				{ ok: false, error: "not available for a prebuilt release" },
				{ status: 400 },
			);
		}
		try {
			const version = await buildFrontend();
			// Attribute the refresh nudge: the signed-in caller when web auth is
			// on, else the session(s) active in this checkout (curl from a run).
			const by = requestUser(ctx) || sharedCheckoutEditors(true);
			broadcastToAll({ type: "frontend_updated", version, ...(by ? { by } : {}) });
			return Response.json({ ok: true, version });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String(e) },
				{ status: 500 },
			);
		}
	}

	// Forced client reload (mirror retirement / protocol-break deploys): nudge
	// every connected tab onto the CURRENT bundle. With `force` (the default)
	// new-enough bundles auto-reload after a short client-side grace
	// (UpdatePill.tsx; hidden tabs immediately) — bundles older than that
	// handler just show the normal update pill, which is the best a broadcast
	// can do for them. Does NOT rebuild; POST /api/rebuild-frontend first if
	// the bundle itself changed. Team gated by the global auth layer like
	// every /api/* route. Body: { force?: boolean } (default true).
	if (
		path === "/api/admin/frontend-reload" &&
		req.method === "POST"
	) {
		if (IS_DEV || !frontend) {
			return Response.json(
				{ ok: false, error: "not available in dev mode" },
				{ status: 400 },
			);
		}
		let body: { force?: unknown } = {};
		try {
			body = ((await req.json()) ?? {}) as typeof body;
		} catch {
			// empty/non-JSON body → defaults
		}
		const force = body.force !== false;
		const by = requestUser(ctx) || sharedCheckoutEditors(true);
		console.log(
			`[frontend] admin reload broadcast${force ? " (forced)" : ""}${by ? ` by ${by}` : ""} (v=${frontend.version})`,
		);
		broadcastToAll({
			type: "frontend_updated",
			version: frontend.version,
			...(force ? { force: true } : {}),
			...(by ? { by } : {}),
		});
		return Response.json({ ok: true, version: frontend.version, force });
	}

	// Transcript v2 backfill (docs/transcripts.md §8): migrate legacy
	// session transcripts into transcripts.db, in-process (invariant 8: the
	// live server is the DB's only writer — never a standalone script). Team
	// gated by the global auth layer like every /api/* route. Body:
	// { limit?, dryRun?, wait? }. Idempotent (store imports are upserts), so
	// it's also safe to run pre-activation to warm the store. A full run takes
	// minutes (paced), so it defaults to background + immediate 202; pass
	// `wait: true` (with a small `limit`) to block for the summary.
	if (
		path === "/api/admin/transcript-backfill" &&
		req.method === "POST"
	) {
		let body: { limit?: unknown; dryRun?: unknown; wait?: unknown } = {};
		try {
			body = ((await req.json()) ?? {}) as typeof body;
		} catch {
			// empty/non-JSON body → defaults
		}
		const opts = {
			limit:
				typeof body.limit === "number" && body.limit > 0
					? Math.floor(body.limit)
					: undefined,
			dryRun: body.dryRun === true,
		};
		const by = requestUser(ctx);
		console.log(
			`[transcript-backfill] admin trigger${by ? ` by ${by}` : ""}:`,
			opts,
		);
		const { runTranscriptBackfill } = await import("../transcript-backfill");
		if (body.wait === true) {
			const summary = await runTranscriptBackfill(opts);
			return Response.json({ ok: true, ...summary });
		}
		void runTranscriptBackfill(opts).catch((e) => {
			console.error("[transcript-backfill] admin-triggered run failed:", e);
		});
		return Response.json({ ok: true, started: true, ...opts }, { status: 202 });
	}

	// Pi engine smoke turn: one scripted turn against a throwaway
	// `os-test-pi-*` session through the in-process pi SDK runner, for
	// post-restart verification (SDK turn → bridge → transcripts.db rows).
	// Config-gated (~/.opensession-pi.json), not env-gated: with the engine
	// disabled (or dryRun: true) this never touches the bridge or the SDK —
	// it returns ok:false + reason (200), never a 500. Real turns are
	// wall-capped at 120s by the harness (under Bun.serve's 240s idleTimeout),
	// so the route can block for the result without hanging.
	if (path === "/api/admin/pi-smoke" && req.method === "POST") {
		let body: { dryRun?: unknown; model?: unknown } = {};
		try {
			body = ((await req.json()) ?? {}) as typeof body;
		} catch {
			// empty/non-JSON body → defaults
		}
		const dryRun = body.dryRun === true;
		const model = typeof body.model === "string" ? body.model : undefined;
		const by = requestUser(ctx);
		console.log(
			`[pi-smoke] admin trigger${by ? ` by ${by}` : ""}${dryRun ? " (dry-run)" : ""}`,
		);
		try {
			// Dynamic import: the pi runner's module graph (opencode-runner and
			// friends) stays out of this hot route file; the heavy pi SDK import
			// is itself dynamic inside the runner.
			const { runPiSmokeTurn } = await import("../pi-runner");
			const result = await runPiSmokeTurn({ dryRun, timeoutMs: 120_000, model });
			// Snippet, not the full turn output — this is a wiring probe.
			return Response.json({ ...result, text: result.text.slice(0, 400) });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String((e as Error)?.message || e) },
				{ status: 500 },
			);
		}
	}

	// Stream a large composer attachment straight to disk (base64-over-WS
	// can't carry big files). Body is the raw file bytes; filename in the
	// `x-file-name` header. Returns { name, path } the client echoes back in
	// its next prompt/create_session `files` entry.
	if (path === "/api/upload" && req.method === "POST") {
		try {
			const rawName = req.headers.get("x-file-name") || "file";
			const name = decodeURIComponent(rawName);
			const len = Number(req.headers.get("content-length") || 0);
			if (len > MAX_UPLOAD_BYTES) {
				return Response.json(
					{
						ok: false,
						error: `File too large (${len} bytes, max ${MAX_UPLOAD_BYTES}).`,
					},
					{ status: 413 },
				);
			}
			const staged = await stageHttpUpload(name, req);
			return Response.json({ ok: true, ...staged });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String((e as Error)?.message || e) },
				{ status: 400 },
			);
		}
	}

	// ── Audit digest: one day rolled up for the nightly Dreaming automation ──
	// The raw jsonl is 10-20MB (too big to shell-process), so this rolled-up
	// endpoint is that run's window into yesterday's work — like /api/health for
	// the health monitor. Default date is yesterday (UTC). Use `?section=` to
	// pull individual detail sections under the engine's tool-output cap.
	if (path === "/api/audit/digest" && req.method === "GET") {
		const { buildAuditDigest, listAuditDates } = await import(
			"../../server/audit"
		);
		const date =
			url.searchParams.get("date") ||
			new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		const digestJson = buildAuditDigest(date);
		if (!digestJson) {
			return Response.json(
				{
					ok: false,
					error: `no audit log for ${date}`,
					dates: listAuditDates().slice(0, 7),
				},
				{ status: 404 },
			);
		}
		// Join automation runs so automation sessions carry a readable name.
		const { listAutomations } = await import("../automations");
		const automationRuns: Array<Record<string, unknown>> = [];
		const nameBySession = new Map<string, string>();
		for (const a of listAutomations()) {
			for (const r of a.runs || []) {
				if (String(r.at).slice(0, 10) !== date) continue;
				automationRuns.push({
					automation: a.name,
					at: r.at,
					trigger: r.trigger,
					status: r.status,
					durationMs: r.durationMs,
					sessionId: r.sessionId,
				});
				if (r.sessionId) nameBySession.set(r.sessionId, a.name);
			}
		}
		for (const s of digestJson.sessions as Array<Record<string, unknown>>) {
			const name = nameBySession.get(String(s.id));
			if (name) s.automation = name;
		}
		const full: Record<string, unknown> = { ok: true, ...digestJson, automationRuns };
		// The full digest is 50-70KB, which trips the engine's large-tool-output
		// truncation (the body spills to a file and the inline view is cut). A
		// `?section=errorGroups,sessions` filter lets a caller pull one or two
		// detail sections at a time, each small enough to land inline. `ok`,
		// `date` and a `sections` index of what's available always ride along.
		const section = url.searchParams.get("section");
		if (section) {
			const want = new Set(section.split(",").map((s) => s.trim()).filter(Boolean));
			const picked: Record<string, unknown> = {
				ok: true,
				date,
				sections: Object.keys(full).filter((k) => k !== "ok"),
			};
			for (const k of want) if (k in full) picked[k] = full[k];
			return Response.json(picked);
		}
		return Response.json(full);
	}

	// ── Audit log viewer (Settings → Audit log) ──
	if (path === "/api/audit" && req.method === "GET") {
		const { listAuditDates, readAuditEvents } = await import(
			"../../server/audit"
		);
		const date = url.searchParams.get("date") || "";
		const dates = listAuditDates();
		if (!date) return Response.json({ dates });
		return Response.json({
			dates,
			...readAuditEvents({
				date,
				q: url.searchParams.get("q") || undefined,
				type: url.searchParams.get("type") || undefined,
				session: url.searchParams.get("session") || undefined,
				significantOnly: url.searchParams.get("all") !== "1",
				offset: Number(url.searchParams.get("offset")) || 0,
				limit: Number(url.searchParams.get("limit")) || 200,
			}),
		});
	}

	return undefined;
}
