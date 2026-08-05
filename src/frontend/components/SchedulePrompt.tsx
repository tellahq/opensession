import React, { useEffect, useRef, useState } from "react";
import {
  fetchScheduledPrompts,
  createScheduledPromptApi,
  deleteScheduledPromptApi,
  type ScheduledPrompt,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { IconChevronDown, IconClock } from "./icons";
import { cn } from "../ui/cn";

/** "in 45m" / "in 3h" / "in 2d" for a future instant (short form). */
function inTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const menuItemClass = "composer-menu-item disabled:cursor-default disabled:opacity-45";

/**
 * Composer "send later": schedules the *current composer draft* for this
 * session at a chosen time (Slack-style). Due prompts are delivered
 * server-side through the normal prompt path (steer / queue / fresh turn), so
 * they behave exactly like typing at that moment.
 *
 * Renders as the caret half of the send split button — a chevron that opens a
 * small menu of contextual quick picks ("Tomorrow at 9:00 AM", …) plus a
 * "Custom time" entry that opens a date/time dialog. The caret is disabled in
 * lockstep with the send button (empty draft → nothing to schedule), so the
 * whole split button greys out together.
 */
export function SchedulePromptButton({
  sessionId,
  text,
  disabled,
  onScheduled,
  variant = "caret",
}: {
  sessionId: string;
  /** Current composer draft — the message that gets scheduled. */
  text: string;
  disabled?: boolean;
  /** Called after a successful schedule so the composer can clear its draft. */
  onScheduled?: () => void;
  variant?: "caret" | "menu-item";
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [pending, setPending] = useState<ScheduledPrompt[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const hasText = text.trim().length > 0;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const load = () =>
    fetchScheduledPrompts(sessionId)
      .then(setPending)
      .catch(() => {});

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Close menu on outside click; Escape closes menu or dialog.
  useEffect(() => {
    if (!open && !customOpen) return;
    const onDown = (e: MouseEvent) => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, customOpen]);

  // Contextual quick picks (Slack-style): later today, tomorrow, next Monday —
  // all at sensible hours, de-duped and always in the future.
  function quickOptions(): { label: string; at: Date }[] {
    const now = new Date();
    const out: { label: string; at: Date }[] = [];
    const seen = new Set<string>();
    const add = (label: string, at: Date) => {
      const k = at.toISOString();
      if (at.getTime() > now.getTime() + 30_000 && !seen.has(k)) {
        seen.add(k);
        out.push({ label, at });
      }
    };
    const today6pm = new Date(now);
    today6pm.setHours(18, 0, 0, 0);
    add(`Today at ${fmtTime(today6pm)}`, today6pm);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    add(`Tomorrow at ${fmtTime(tomorrow)}`, tomorrow);
    const monday = new Date(now);
    monday.setDate(now.getDate() + (((8 - monday.getDay()) % 7) || 7));
    monday.setHours(9, 0, 0, 0);
    add(
      `${monday.toLocaleDateString([], { weekday: "long" })} at ${fmtTime(monday)}`,
      monday,
    );
    return out.slice(0, 3);
  }

  async function schedule(at: Date) {
    const prompt = text.trim();
    if (!prompt || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createScheduledPromptApi(sessionId, {
        prompt,
        at: at.toISOString(),
        user: getCurrentUser(),
      });
      setOpen(false);
      setCustomOpen(false);
      onScheduled?.();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  function openCustom() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setDate(toDateInput(d));
    setTime("09:00");
    setError(null);
    setOpen(false);
    setCustomOpen(true);
  }

  function scheduleCustom() {
    if (!date || !time) return;
    const at = new Date(`${date}T${time}`);
    if (isNaN(at.getTime())) {
      setError("Pick a valid date and time.");
      return;
    }
    if (at.getTime() <= Date.now()) {
      setError("Pick a time in the future.");
      return;
    }
    void schedule(at);
  }

  return (
    <div
      ref={rootRef}
      className={cn("composer-schedule-wrap relative inline-flex items-stretch", variant === "menu-item" && "composer-schedule-wrap-menu block w-full")}
    >
      <button
        type="button"
        className={
          variant === "menu-item"
            ? `${menuItemClass} composer-schedule-item relative justify-start disabled:hover:bg-transparent`
            : cn("composer-send-caret relative inline-flex w-[30px] items-center justify-center rounded-r-lg border-0 bg-accent text-white transition-[filter] hover:not-disabled:brightness-110 disabled:cursor-default disabled:opacity-35 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-white/45 [&>svg]:transition-transform", open && "is-open [&>svg]:rotate-180")
        }
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Schedule for later"
        aria-label="Schedule for later"
      >
        {variant === "menu-item" ? (
          <>
            <span className="composer-menu-icon inline-flex w-5 items-center justify-center text-control-label text-dim">
              <IconClock size={22} />
            </span>
            <span>Schedule message</span>
          </>
        ) : (
          <IconChevronDown size={20} />
        )}
        {pending.length > 0 && (
          <span className="composer-schedule-badge pointer-events-none absolute -top-[5px] -right-[5px] h-[15px] min-w-[15px] rounded-full bg-yellow px-[3px] text-center text-meta leading-[15px] font-bold text-white shadow-[0_0_0_2px_var(--bg)]">{pending.length}</span>
        )}
      </button>

      {open && (
        <div className="composer-menu composer-schedule-menu min-w-[236px]" role="menu">
          {pending.length > 0 && (
            <div className="composer-schedule-pending mb-0.5 flex flex-col gap-px border-b border-line pb-1">
              {pending.map((p) => (
                <div key={p.id} className="composer-schedule-perow flex min-w-0 items-baseline gap-2 px-[9px] py-[5px] text-label">
                  <span
                    className="composer-schedule-pin shrink-0 font-semibold text-yellow"
                    title={new Date(p.at).toLocaleString()}
                  >
                    {inTime(p.at)}
                  </span>
                  <span className="composer-schedule-ptext truncate text-dim" title={p.prompt}>
                    {p.prompt}
                  </span>
                  <button
                    type="button"
                    className="composer-schedule-pcancel ml-auto shrink-0 border-0 bg-transparent p-0 text-label text-faint hover:text-red"
                    title="Cancel this scheduled message"
                    onClick={async () => {
                      try {
                        await deleteScheduledPromptApi(p.id);
                        load();
                      } catch {}
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-schedule-head px-[9px] pt-1.5 pb-1 text-label font-medium text-faint">Schedule message</div>
          {quickOptions().map((o) => (
            <button
              key={o.at.toISOString()}
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => schedule(o.at)}
              disabled={saving || !hasText}
            >
              {o.label}
            </button>
          ))}
          <div className="composer-schedule-sep mx-1.5 my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={openCustom}
            disabled={!hasText}
          >
            Custom time
          </button>
          {error && !customOpen && (
            <div className="composer-schedule-err px-[9px] pt-1 pb-0.5 text-label text-red">{error}</div>
          )}
        </div>
      )}

      {customOpen && (
        <div
          className="composer-schedule-modal-backdrop fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-5"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomOpen(false);
          }}
        >
          <div className="composer-schedule-modal w-[420px] max-w-[92vw] rounded-xl border border-line-strong bg-raised p-5 shadow-[0_20px_60px_rgba(0,0,0,0.4)]">
            <div className="composer-schedule-modal-head flex items-start justify-between gap-3">
              <div>
                <div className="composer-schedule-modal-title text-[17px] font-semibold text-fg">Schedule message</div>
                <div className="composer-schedule-modal-tz mt-[3px] text-supporting text-dim">Time zone: {tz}</div>
              </div>
              <button
                type="button"
                className="composer-schedule-modal-close border-0 bg-transparent px-1 py-0.5 text-[15px] leading-none text-faint hover:text-fg"
                onClick={() => setCustomOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="composer-schedule-modal-fields mt-4 flex gap-2">
              <input
                type="date"
                value={date}
                min={toDateInput(new Date())}
                onChange={(e) => setDate(e.target.value)}
                className="composer-schedule-input min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-[9px] text-control-label font-medium text-fg outline-none focus:border-line-strong"
              />
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="composer-schedule-input composer-schedule-input-time min-w-0 flex-[0_0_130px] rounded-md border border-line bg-surface px-3 py-[9px] text-control-label font-medium text-fg outline-none focus:border-line-strong"
              />
            </div>
            {error && <div className="composer-schedule-err px-[9px] pt-1 pb-0.5 text-label text-red">{error}</div>}
            <div className="composer-schedule-modal-actions mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="composer-schedule-cancel rounded-md border border-line-strong bg-transparent px-4 py-[9px] text-control-label font-semibold text-fg hover:bg-surface"
                onClick={() => setCustomOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="composer-schedule-submit rounded-md border-0 bg-accent px-4 py-[9px] text-control-label font-semibold text-white transition-[filter] hover:not-disabled:brightness-110 disabled:cursor-default disabled:opacity-45"
                onClick={scheduleCustom}
                disabled={saving || !date || !time}
              >
                {saving ? "Scheduling…" : "Schedule Message"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
