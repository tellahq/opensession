import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  Top5px: {
    top: "calc(5px * -1)",
  },
  Right5px: {
    right: "calc(5px * -1)",
  },
  h15px: {
    height: "15px",
  },
  minW15px: {
    minWidth: "15px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgYellow: {
    backgroundColor: "var(--yellow)",
  },
  px3px: {
    paddingInline: "3px",
  },
  textCenter: {
    textAlign: "center",
  },
  text10px: {
    fontSize: "10px",
  },
  leading15px: {
    lineHeight: "15px",
  },
  fontBold: {
    fontWeight: "var(--font-weight-bold)",
  },
  textWhite: {
    color: "var(--color-white)",
  },
  mb05: {
    marginBottom: "calc(4px * 0.5)",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gapPx: {
    gap: "1px",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  pb1: {
    paddingBottom: "4px",
  },
  minW0: {
    minWidth: "0",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  px9px: {
    paddingInline: "9px",
  },
  py5px: {
    paddingBlock: "5px",
  },
  shrink0: {
    flexShrink: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  pt15: {
    paddingTop: "calc(4px * 1.5)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  mx15: {
    marginInline: "calc(4px * 1.5)",
  },
  my1: {
    marginBlock: "4px",
  },
  hPx: {
    height: "1px",
  },
  bgLine: {
    backgroundColor: "var(--border)",
  },
  pt1: {
    paddingTop: "4px",
  },
  pb05: {
    paddingBottom: "calc(4px * 0.5)",
  },
  textRed: {
    color: "var(--red)",
  },
  fixed: {
    position: "fixed",
  },
  inset0: {
    inset: "0",
  },
  z300: {
    zIndex: "300",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  bgBlack40: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 40%, transparent)",
  },
  p5: {
    padding: "calc(4px * 5)",
  },
  w420px: {
    width: "420px",
  },
  maxW92vw: {
    maxWidth: "92vw",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  smoothShadowLg: {
    boxShadow:
      "0 4px 12px -4px color-mix(in srgb, var(--smooth-shadow-color) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--smooth-shadow-color) 11%, transparent)",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt3px: {
    marginTop: "3px",
  },
  Mt05: {
    marginTop: "calc(4px * -0.5)",
  },
  Mr1: {
    marginRight: "calc(4px * -1)",
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  mt5: {
    marginTop: "calc(4px * 5)",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
});

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
const caretButton = utilityClassName(
  "relative inline-flex w-[30px] items-center justify-center rounded-r-lg bg-accent text-on-accent transition-[background-color] before:absolute before:top-1/2 before:left-0 before:h-4 before:w-px before:-translate-y-1/2 before:bg-white/45 before:content-[''] enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-35",
);

/** Date / time field in the custom-time dialog. `bg-transparent` is deliberate:
 *  the stylesheet asked for `var(--bg-surface)`, a token that has never been
 *  defined, so the declaration was invalid at computed-value time and the fill
 *  fell back to `transparent` — these fields have always shown the dialog's own
 *  surface. Without it they would pick up the UA's opaque field colour. */
const scheduleField = utilityClassName(
  "min-w-0 rounded-control border border-line bg-transparent px-3 py-[9px] text-item-title font-medium text-fg outline-none focus:border-line-strong",
);

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
        !rootRef.current.contains(e.target as Node)
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
          ? utilityClassName("relative block w-full")
          : utilityClassName("relative inline-flex items-stretch")
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
                utilityClassName(
                  "relative justify-start disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent",
                ),
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
            className={cn(
              utilityClassName("transition-transform"),
              open && utilityClassName("rotate-180"),
            )}
          />
        )}
        {pending.length > 0 && (
          <span
            {...mergeStylexProps(
              "shadow-[0_0_0_2px_var(--bg)]",
              sx.pointerEventsNone,
              sx.absolute,
              sx.Top5px,
              sx.Right5px,
              sx.h15px,
              sx.minW15px,
              sx.roundedFull,
              sx.bgYellow,
              sx.px3px,
              sx.textCenter,
              sx.text10px,
              sx.leading15px,
              sx.fontBold,
              sx.textWhite,
            )}
          >
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
            <div
              {...stylex.props(
                sx.mb05,
                sx.flex,
                sx.flexCol,
                sx.gapPx,
                sx.borderB,
                sx.borderLine,
                sx.pb1,
              )}
            >
              {pending.map((p) => (
                <div
                  key={p.id}
                  {...stylex.props(
                    sx.flex,
                    sx.minW0,
                    sx.itemsBaseline,
                    sx.gap2,
                    sx.px9px,
                    sx.py5px,
                    typography.meta,
                  )}
                >
                  <span
                    {...stylex.props(
                      sx.shrink0,
                      sx.fontSemibold,
                      sx.textYellow,
                    )}
                    title={new Date(p.at).toLocaleString()}
                  >
                    {inTime(p.at)}
                  </span>
                  <span
                    {...stylex.props(sx.truncate, sx.textDim)}
                    title={p.prompt}
                  >
                    {p.prompt}
                  </span>
                  <button
                    type="button"
                    {...stylex.props(
                      sx.mlAuto,
                      sx.shrink0,
                      sx.textFaint,
                      sx.hoverTextRed,
                      typography.meta,
                    )}
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

          <div
            {...stylex.props(
              sx.px9px,
              sx.pt15,
              sx.pb1,
              sx.fontMedium,
              sx.textFaint,
              typography.meta,
            )}
          >
            Schedule message
          </div>
          {quickOptions().map((o) => (
            <button
              key={o.at.toISOString()}
              type="button"
              role="menuitem"
              // text-label: the picks read a step larger than the "+" menu's
              // rows, which is what .composer-schedule-menu used to say.
              className={cn(composerMenuItem, utilityClassName("text-label"))}
              onClick={() => schedule(o.at)}
              disabled={saving || !hasText}
            >
              {o.label}
            </button>
          ))}
          <div {...stylex.props(sx.mx15, sx.my1, sx.hPx, sx.bgLine)} />
          <button
            type="button"
            role="menuitem"
            className={cn(composerMenuItem, utilityClassName("text-label"))}
            onClick={openCustom}
            disabled={!hasText}
          >
            Custom time
          </button>
          {error && !customOpen && (
            <div
              {...stylex.props(
                sx.px9px,
                sx.pt1,
                sx.pb05,
                sx.textRed,
                typography.meta,
              )}
            >
              {error}
            </div>
          )}
        </div>
      )}

      {customOpen && (
        // The class name stays: SessionViewer and Sidebar look for an open
        // overlay by this selector before taking a global key.
        <div
          {...mergeStylexProps(
            "composer-schedule-modal-backdrop",
            sx.fixed,
            sx.inset0,
            sx.z300,
            sx.flex,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.bgBlack40,
            sx.p5,
          )}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomOpen(false);
          }}
        >
          <div
            {...stylex.props(
              sx.w420px,
              sx.maxW92vw,
              sx.roundedXl,
              sx.border,
              sx.borderLineStrong,
              sx.bgRaised,
              sx.p5,
              sx.smoothShadowLg,
            )}
          >
            <div
              {...stylex.props(
                sx.flex,
                sx.itemsStart,
                sx.justifyBetween,
                sx.gap3,
              )}
            >
              <div>
                <div
                  {...stylex.props(
                    sx.fontSemibold,
                    sx.textFg,
                    typography.dialogTitle,
                  )}
                >
                  Schedule message
                </div>
                <div {...stylex.props(sx.mt3px, sx.textDim, typography.meta)}>
                  Time zone: {tz}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className={mergeStylexOverrideClassName("", sx.Mt05, sx.Mr1)}
                onClick={() => setCustomOpen(false)}
                aria-label="Close"
                icon={<IconX size={20} />}
              />
            </div>
            <div {...stylex.props(sx.mt4, sx.flex, sx.gap2)}>
              <input
                type="date"
                value={date}
                min={toDateInput(new Date())}
                onChange={(e) => setDate(e.target.value)}
                className={cn(scheduleField, utilityClassName("flex-1"))}
              />
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cn(
                  scheduleField,
                  utilityClassName("flex-none basis-[130px]"),
                )}
              />
            </div>
            {error && (
              <div
                {...stylex.props(
                  sx.px9px,
                  sx.pt1,
                  sx.pb05,
                  sx.textRed,
                  typography.meta,
                )}
              >
                {error}
              </div>
            )}
            <div {...stylex.props(sx.mt5, sx.flex, sx.justifyEnd, sx.gap2)}>
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
