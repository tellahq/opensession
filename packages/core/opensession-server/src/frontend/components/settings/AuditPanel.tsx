import { useEffect, useState } from "react";
import { z } from "zod";
import { fetchAudit } from "../../lib/api";
import { BASE_PATH } from "../../lib/base";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { SettingCard, SettingsHeader, SettingsPanel } from "../../ui/settings";
import { EmptyState } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { Select } from "./shared";

const auditEventSchema = z.looseObject({
  tool_name: z.json().optional(),
  action: z.json().optional(),
  context: z.json().optional(),
  decision: z.json().optional(),
  account: z.json().optional(),
  model: z.json().optional(),
  ok: z.boolean().optional().catch(undefined),
  error: z.json().optional(),
  text_snippet: z.json().optional(),
  time: z.json().optional(),
  kind: z.json().optional(),
  msg: z.json().optional(),
  bks_session_id: z.string().optional().catch(undefined),
  run_kind: z.json().optional(),
});
const auditEventsSchema = z.array(auditEventSchema);
type AuditEvent = z.infer<typeof auditEventSchema>;

/** Summarize one audit event for its row (the details live in the expand). */
function auditSummary(e: AuditEvent): string {
  const parts: string[] = [];
  if (e.tool_name) parts.push(String(e.tool_name));
  if (e.action) parts.push(`${e.context ? `${e.context}.` : ""}${e.action}`);
  if (e.decision) parts.push(`decision: ${e.decision}`);
  if (e.account) parts.push(`account: ${e.account}`);
  if (e.model) parts.push(String(e.model));
  if (e.ok !== undefined) parts.push(e.ok ? "ok" : "failed");
  if (e.error) parts.push(`error: ${String(e.error).slice(0, 80)}`);
  if (e.text_snippet) parts.push(`“${String(e.text_snippet).slice(0, 100)}”`);
  return parts.join(" · ");
}

/** Read-only viewer over ~/.opensession-audit daily JSONL (agent flight recorder). */
export function AuditPanel() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [type, setType] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // Debounced reload on any filter change.
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      fetchAudit({
        date: date || undefined,
        type: type || undefined,
        q: q || undefined,
        all,
      })
        .then((page) => {
          setDates(page.dates);
          if (!date && page.dates.length) {
            setDate(page.dates[0]);
            return; // effect re-runs with the date set
          }
          setEvents(auditEventsSchema.parse(page.events || []));
          setTotal(page.total || 0);
          setTypes(page.types || []);
          setExpanded(null);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [date, type, q, all]);

  async function loadMore() {
    const page = await fetchAudit({
      date,
      type: type || undefined,
      q: q || undefined,
      all,
      offset: events.length,
    });
    setEvents([...events, ...auditEventsSchema.parse(page.events || [])]);
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Audit log"
        description="Review prompts, tool decisions, account switches, and confirmations from every agent run. Events are read-only and kept for 400 days."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2 px-5">
        <Select
          className="w-auto"
          label="Date"
          value={date}
          options={dates.map((d) => ({ value: d, label: d }))}
          onChange={setDate}
        />
        <Select
          className="w-auto"
          label="Event type"
          value={type}
          options={[
            { value: "", label: all ? "All events" : "Significant events" },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
          onChange={setType}
        />
        <label className="flex cursor-pointer items-center gap-2 text-label text-dim">
          <Switch checked={all} onCheckedChange={setAll} />
          Include tool firehose
        </label>
        <Input
          className="min-w-[140px] flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (session id, tool, text…)"
          aria-label="Search audit log"
        />
      </div>

      <div className="mb-2 px-5 text-meta text-faint">
        {loading
          ? "Loading…"
          : `${events.length} of ${total} events (newest first)`}
      </div>

      <SettingCard>
        {events.map((e, i) => {
          const time = String(e.time || "").slice(11, 19);
          const t = String(e.kind || e.msg || "event");
          const sid = e.bks_session_id ?? "";
          return (
            <div key={i} className={expanded === i ? "bg-pressed" : ""}>
              <button
                className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 px-5 py-1.5 text-left text-label hover:bg-hover"
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <span className="text-faint shrink-0">{time}</span>
                <span className="text-fg font-medium shrink-0">{t}</span>
                {e.run_kind ? (
                  <span className="text-faint shrink-0">
                    {String(e.run_kind)}
                  </span>
                ) : null}
                <span className="text-dim truncate">{auditSummary(e)}</span>
                {sid && (
                  <a
                    className="ml-auto shrink-0 text-meta text-faint underline"
                    href={`${BASE_PATH}/session/${sid}`}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {sid.slice(0, 18)}…
                  </a>
                )}
              </button>
              {expanded === i && (
                <pre className="m-0 overflow-x-auto border-t border-line px-5 py-2.5 text-meta leading-relaxed text-dim">
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
        {!loading && events.length === 0 && (
          <EmptyState placement="row">No events match.</EmptyState>
        )}
      </SettingCard>

      {events.length < total && (
        <div className="mt-2">
          <Button size="sm" onClick={loadMore}>
            Load more ({total - events.length} left)
          </Button>
        </div>
      )}
    </SettingsPanel>
  );
}
