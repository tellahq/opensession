import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchScheduledPrompts,
  createScheduledPromptApi,
  deleteScheduledPromptApi,
  type ScheduledPrompt,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { IconChevronDown, IconClock, IconX } from "./icons";
import {
  composerMenuAnchorRight,
  composerMenuIcon,
  composerMenuItem,
  composerMenuPopup,
  composerMenuWidth,
} from "../lib/composer-classes";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { errorMessage } from "../lib/error-message";

/** "in 45m" / "in 3h" / "in 2d" for a future instant (short form). */
function inTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/** The caret half of a split send button: rounded on its outer edge only, with
 *  a thin inset divider (short of the top/bottom edges, Slack-style) rather
 *  than a full-height seam. */
const caretButton =
  "relative inline-flex w-[30px] items-center justify-center rounded-r-lg bg-accent text-on-accent transition-[background-color] before:absolute before:top-1/2 before:left-0 before:h-4 before:w-px before:-translate-y-1/2 before:bg-white/45 before:content-[''] enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-35";

/** Date / time field in the custom-time dialog. `bg-transparent` is deliberate:
 *  the stylesheet asked for `var(--bg-surface)`, a token that has never been
 *  defined, so the declaration was invalid at computed-value time and the fill
 *  fell back to `transparent` — these fields have always shown the dialog's own
 *  surface. Without it they would pick up the UA's opaque field colour. */
const scheduleField =
  "min-w-0 rounded-control border border-line bg-transparent px-3 py-[9px] text-item-title font-medium text-fg outline-none focus:border-line-strong";

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

  // Stable per session: setters + module fns otherwise.
  const load = useCallback(
    () =>
      fetchScheduledPrompts(sessionId)
        .then(setPending)
        .catch(() => {}),
    [sessionId],
  );

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Close menu on outside click; Escape closes menu or dialog.
  useEffect(() => {
    if (!open && !customOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        open &&
        rootRef.current &&
        !rootRef.current.contains(e.target instanceof Node ? e.target : null)
      )
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
    monday.setDate(now.getDate() + ((8 - monday.getDay()) % 7 || 7));
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
    await (async () => {
      await createScheduledPromptApi(sessionId, {
        prompt,
        at: at.toISOString(),
        user: getCurrentUser(),
      });
      setOpen(false);
      setCustomOpen(false);
      onScheduled?.();
      await load();
    })().catch(async (error) => {
      setError(errorMessage(error, "Failed to schedule prompt"));
    });
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
      // Positioned: the send-later menu below hangs off it.
      className={
        variant === "menu-item"
          ? "relative block w-full"
          : "relative inline-flex items-stretch"
      }
    >
      <button
        type="button"
        className={
          variant === "menu-item"
            ? // The shared menu row plus only what the schedule row changes
              // about it. `disabled:hover:bg-transparent` is load-bearing: it
              // is what suppresses the row's own hover wash while disabled.
              cn(
                composerMenuItem,
                "relative justify-start disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent",
              )
            : caretButton
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
            <span className={composerMenuIcon}>
              <IconClock size={22} />
            </span>
            <span>Schedule message</span>
          </>
        ) : (
          <IconChevronDown
            size={20}
            className={cn("transition-transform", open && "rotate-180")}
          />
        )}
        {pending.length > 0 && (
          <span className="pointer-events-none absolute -top-[5px] -right-[5px] h-[15px] min-w-[15px] rounded-full bg-yellow px-[3px] text-center text-[10px] leading-[15px] font-bold text-white shadow-[0_0_0_2px_var(--bg)]">
            {pending.length}
          </span>
        )}
      </button>

      {open && (
        // 172px, not the 236px `.composer-schedule-menu` asked for: that rule
        // had been dead since the popup surface moved below it in the
        // stylesheet (equal specificity, later wins), so the menu has always
        // been 172px.
        <div
          className={cn(
            composerMenuPopup,
            composerMenuAnchorRight,
            composerMenuWidth,
          )}
          role="menu"
        >
          {/* Pending scheduled messages, listed above the picks with a cancel. */}
          {pending.length > 0 && (
            <div className="mb-0.5 flex flex-col gap-px border-b border-line pb-1">
              {pending.map((p) => (
                <div
                  key={p.id}
                  className="flex min-w-0 items-baseline gap-2 px-[9px] py-[5px] text-meta"
                >
                  <span
                    className="shrink-0 font-semibold text-yellow"
                    title={new Date(p.at).toLocaleString()}
                  >
                    {inTime(p.at)}
                  </span>
                  <span className="truncate text-dim" title={p.prompt}>
                    {p.prompt}
                  </span>
                  <button
                    type="button"
                    className="ml-auto shrink-0 text-meta text-faint hover:text-red"
                    title="Cancel this scheduled message"
                    onClick={async () => {
                      await (async () => {
                        await deleteScheduledPromptApi(p.id);
                        load();
                      })().catch(async () => {});
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="px-[9px] pt-1.5 pb-1 text-meta font-medium text-faint">
            Schedule message
          </div>
          {quickOptions().map((o) => (
            <button
              key={o.at.toISOString()}
              type="button"
              role="menuitem"
              // text-label: the picks read a step larger than the "+" menu's
              // rows, which is what .composer-schedule-menu used to say.
              className={cn(composerMenuItem, "text-label")}
              onClick={() => schedule(o.at)}
              disabled={saving || !hasText}
            >
              {o.label}
            </button>
          ))}
          <div className="mx-1.5 my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={cn(composerMenuItem, "text-label")}
            onClick={openCustom}
            disabled={!hasText}
          >
            Custom time
          </button>
          {error && !customOpen && (
            <div className="px-[9px] pt-1 pb-0.5 text-meta text-red">
              {error}
            </div>
          )}
        </div>
      )}

      {customOpen && (
        // The class name stays: SessionViewer and Sidebar look for an open
        // overlay by this selector before taking a global key.
        <div
          className="composer-schedule-modal-backdrop fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-5"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomOpen(false);
          }}
        >
          <div className="w-[420px] max-w-[92vw] rounded-xl border border-line-strong bg-raised p-5 smooth-shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-dialog-title font-semibold text-fg">
                  Schedule message
                </div>
                <div className="mt-[3px] text-meta text-dim">
                  Time zone: {tz}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="-mt-0.5 -mr-1"
                onClick={() => setCustomOpen(false)}
                aria-label="Close"
                icon={<IconX size={20} />}
              />
            </div>
            <div className="mt-4 flex gap-2">
              <input
                type="date"
                value={date}
                min={toDateInput(new Date())}
                onChange={(e) => setDate(e.target.value)}
                className={cn(scheduleField, "flex-1")}
              />
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cn(scheduleField, "flex-none basis-[130px]")}
              />
            </div>
            {error && (
              <div className="px-[9px] pt-1 pb-0.5 text-meta text-red">
                {error}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="soft"
                size="lg"
                onClick={() => setCustomOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={scheduleCustom}
                disabled={saving || !date || !time}
              >
                {saving ? "Scheduling…" : "Schedule message"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
