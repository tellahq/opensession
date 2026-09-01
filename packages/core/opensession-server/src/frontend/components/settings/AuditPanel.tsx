import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useEffect, useState } from "react";
import { fetchAudit } from "../../lib/api";
import { BASE_PATH } from "../../lib/base";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { SettingCard, SettingsHeader, SettingsPanel } from "../../ui/settings";
import { EmptyState } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { Select } from "./shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  wAuto: {
    width: "auto",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  minW140px: {
    minWidth: "140px",
  },
  flex1: {
    flex: "1",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  wFull: {
    width: "100%",
  },
  minW0: {
    minWidth: "0",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textLeft: {
    textAlign: "left",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  shrink0: {
    flexShrink: "0",
  },
  textFg: {
    color: "var(--text)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  underline: {
    textDecorationLine: "underline",
  },
  m0: {
    margin: "0",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  borderT: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  py25: {
    paddingBlock: "calc(4px * 2.5)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
});

/** Summarize one audit event for its row (the details live in the expand). */
function auditSummary(e: Record<string, unknown>): string {
  const parts: string[] = [];
  if (e.tool_name) parts.push(String(e.tool_name));
  if (e.action) parts.push(`${e.context ? `${e.context}.` : ""}${e.action}`);
  if (e.decision) parts.push(`decision: ${e.decision}`);
  if (e.account) parts.push(`account: ${e.account}`);
  if (e.model) parts.push(String(e.model));
  if (typeof e.ok === "boolean") parts.push(e.ok ? "ok" : "failed");
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
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
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
          setEvents(page.events || []);
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
    setEvents([...events, ...(page.events || [])]);
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Audit log"
        description="Review prompts, tool decisions, account switches, and confirmations from every agent run. Events are read-only and kept for 400 days."
      />

      <div
        {...stylex.props(
          sx.mb3,
          sx.flex,
          sx.flexWrap,
          sx.itemsCenter,
          sx.gap2,
          sx.px5,
        )}
      >
        <Select
          className={mergeStylexOverrideClassName("", sx.wAuto)}
          label="Date"
          value={date}
          options={dates.map((d) => ({ value: d, label: d }))}
          onChange={setDate}
        />
        <Select
          className={mergeStylexOverrideClassName("", sx.wAuto)}
          label="Event type"
          value={type}
          options={[
            { value: "", label: all ? "All events" : "Significant events" },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
          onChange={setType}
        />
        <label
          {...stylex.props(
            sx.flex,
            sx.cursorPointer,
            sx.itemsCenter,
            sx.gap2,
            sx.textDim,
            typography.label,
          )}
        >
          <Switch checked={all} onCheckedChange={setAll} />
          Include tool firehose
        </label>
        <Input
          className={mergeStylexOverrideClassName("", sx.minW140px, sx.flex1)}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (session id, tool, text…)"
          aria-label="Search audit log"
        />
      </div>

      <div {...stylex.props(sx.mb2, sx.px5, sx.textFaint, typography.meta)}>
        {loading
          ? "Loading…"
          : `${events.length} of ${total} events (newest first)`}
      </div>

      <SettingCard>
        {events.map((e, i) => {
          const time = String(e.time || "").slice(11, 19);
          const t = String(e.kind || e.msg || "event");
          const sid =
            typeof e.bks_session_id === "string" ? e.bks_session_id : "";
          return (
            <div
              key={i}
              className={expanded === i ? utilityClassName("bg-pressed") : ""}
            >
              <button
                {...stylex.props(
                  sx.flex,
                  sx.wFull,
                  sx.minW0,
                  sx.cursorPointer,
                  sx.itemsBaseline,
                  sx.gap2,
                  sx.px5,
                  sx.py15,
                  sx.textLeft,
                  sx.hoverBgHover,
                  typography.label,
                )}
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <span {...stylex.props(sx.textFaint, sx.shrink0)}>{time}</span>
                <span {...stylex.props(sx.textFg, sx.fontMedium, sx.shrink0)}>
                  {t}
                </span>
                {e.run_kind ? (
                  <span {...stylex.props(sx.textFaint, sx.shrink0)}>
                    {String(e.run_kind)}
                  </span>
                ) : null}
                <span {...stylex.props(sx.textDim, sx.truncate)}>
                  {auditSummary(e)}
                </span>
                {sid && (
                  <a
                    {...stylex.props(
                      sx.mlAuto,
                      sx.shrink0,
                      sx.textFaint,
                      sx.underline,
                      typography.meta,
                    )}
                    href={`${BASE_PATH}/session/${sid}`}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {sid.slice(0, 18)}…
                  </a>
                )}
              </button>
              {expanded === i && (
                <pre
                  {...stylex.props(
                    sx.m0,
                    sx.overflowXAuto,
                    sx.borderT,
                    sx.borderLine,
                    sx.px5,
                    sx.py25,
                    sx.leadingRelaxed,
                    sx.textDim,
                    typography.meta,
                  )}
                >
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
        <div {...stylex.props(sx.mt2)}>
          <Button size="sm" onClick={loadMore}>
            Load more ({total - events.length} left)
          </Button>
        </div>
      )}
    </SettingsPanel>
  );
}
