import * as React from "react";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "../components/icons";
import { useIsPhone } from "../hooks/useIsPhone";
import {
  addDays,
  addMonths,
  clampDay,
  dayInMonth,
  dayOfMonth,
  formatDayLong,
  formatDayRange,
  isSameMonth,
  isWithin,
  monthGrid,
  monthTitle,
  rangeSpanAt,
  startOfMonth,
  todayIsoDay,
  weekdayHeadings,
  weekStartFor,
  type IsoDay,
  type RangeSpan,
} from "../lib/date-grid";
import { Button } from "./button";
import { cn } from "./cn";
import { Popover } from "./popover";
import { Segmented, SegmentedKnob, SegmentedOption } from "./segmented";

/**
 * Date range field: the span a page is showing, as ONE control — the presets
 * that name a common span, and the span itself, on a single segmented track.
 *
 * It replaced three separate boxes in the Analytics bar: a preset group, a
 * "from" field and a "to" field, each with its own plate, its own hairline and
 * its own calendar. They set one value between them, so they read as three
 * controls where there is one decision, and the two fields spelled the year
 * out twice at a size that made them the heaviest thing in the bar. Here the
 * presets and the range are options of the same control: whichever one the
 * range currently comes from wears the knob, so the control says where its
 * value is from, and picking a custom span hands the knob across rather than
 * leaving the group standing empty.
 *
 * The range is picked in one calendar with two clicks — first end, second end,
 * either order — which is also what lets the popup show two months at once and
 * a span of weeks be read whole. `<input type="date">` is what this replaced
 * originally: a system calendar with system blue, system corners and Clear /
 * Today in the browser's language, dropped into a page that shares none of it,
 * and reading the day in LOCAL time while every range in the app is UTC days.
 */

export type DateRangePreset = {
  /** What the option says: "7d", "90d". */
  label: string;
  /** How many days it spans, counting back from today inclusive. */
  days: number;
};

export function DateRangeField({
  from,
  to,
  onRangeChange,
  presets = [],
  min,
  max,
  label,
  className,
}: {
  /** The range in effect, `YYYY-MM-DD` at both ends, inclusive. */
  from: IsoDay;
  to: IsoDay;
  onRangeChange: (from: IsoDay, to: IsoDay) => void;
  /** Common spans, shown in full beside the range. Ordered short to long. */
  presets?: DateRangePreset[];
  /** Inclusive bounds on what can be picked. */
  min?: IsoDay;
  max?: IsoDay;
  /** Accessible name for the control: "Date range". */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  // One id for the whole control: the knob is shared between the preset group
  // and the range option, so it travels between them (see ui/segmented).
  const knobId = React.useId();
  const isPhone = useIsPhone();
  const today = todayIsoDay();
  const presetRange = (days: number): [IsoDay, IsoDay] => [
    clampDay(addDays(today, -(days - 1)), min, max),
    clampDay(today, min, max),
  ];
  // A preset means "the last N days, ending today", so a range only names one
  // while it still ends today.
  const activePreset =
    presets.find((p) => {
      const [start, end] = presetRange(p.days);
      return from === start && to === end;
    })?.days ?? null;
  const rangeLabel = formatDayRange(from, to);
  // A phone bar has room for one of the two halves, and the range is the half
  // that has to be readable at a glance. The presets move into the popup,
  // where they get the tap box they can't have on the track.
  const presetsOnTrack = presets.length > 0 && !isPhone;
  // The knob marks where the range comes from, so the range option takes it
  // when no preset matches — and always when it is the only option on the
  // track, where a knob-less label would read as a disabled chip.
  const rangeWearsKnob = !presetsOnTrack || activePreset === null;

  return (
    // The track is the control's, not the toggle group's: everything on it is
    // one exclusive choice. Concentric corners, as in ui/segmented — the
    // options' `rounded-control` (12) plus this 2px padding is `rounded-lg`.
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex items-center rounded-lg bg-hover p-0.5",
        className,
      )}
    >
      {presetsOnTrack && (
        <>
          <Segmented
            label="Preset ranges"
            knobId={knobId}
            value={activePreset === null ? null : String(activePreset)}
            onValueChange={(v) => onRangeChange(...presetRange(Number(v)))}
            // The group contributes its options only; the well around them
            // belongs to the whole control.
            className="rounded-none bg-transparent p-0"
          >
            {presets.map((p) => (
              <SegmentedOption key={p.label} value={String(p.days)}>
                {p.label}
              </SegmentedOption>
            ))}
          </Segmented>
          {/* The seam between the two halves of the control. Short of the
					    track's full height, so it separates the options without
					    reading as the edge of a second box. */}
          <span
            aria-hidden
            className="mx-1 h-3.5 w-px shrink-0 bg-line-strong phone:mx-1.5 phone:h-5"
          />
        </>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          // The range is the label a sighted reader gets, so it belongs in
          // the spoken one: a bare "Date range, button" says nothing about
          // what is being charted.
          aria-label={`${label}, ${rangeLabel}`}
          className={cn(
            "relative inline-flex cursor-pointer select-none items-center",
            // The glyph's side is pulled in by the whitespace it carries,
            // the way ui/button balances a leading icon.
            "rounded-control py-1 pr-2.5 pl-1.5",
            "text-control-label font-medium whitespace-nowrap",
            "transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] focus-ring",
            // Phones get the tap box the options beside it take.
            "phone:py-2 phone:pr-3 phone:pl-2.5 phone:text-item-title",
            rangeWearsKnob ? "text-fg" : "text-dim hover:text-fg",
            "data-[popup-open]:text-fg",
          )}
        >
          {rangeWearsKnob && <SegmentedKnob knobId={knobId} />}
          {/* Above the knob, which fills the option. */}
          <span className="relative flex items-center gap-1.5">
            {/* Support, not the label: the dates are what is being read. `dense`
						    is what keeps this option the height of the ones beside it —
						    at the icon scale's own floor the glyph, not the text, would
						    set it, and the control would stand a step taller than the
						    presets it shares a track with. */}
            <IconCalendar size={16} dense className="shrink-0 opacity-55" />
            <span className="[text-box:trim-both_cap_alphabetic]">
              {rangeLabel}
            </span>
          </span>
        </Popover.Trigger>
        <Popover.Popup align="end" sideOffset={6} initialFocus={false}>
          <RangeCalendar
            from={from}
            to={to}
            min={min}
            max={max}
            label={label}
            presets={presetsOnTrack ? [] : presets}
            activePreset={activePreset}
            onPreset={(days) => onRangeChange(...presetRange(days))}
            onCommit={(start, end) => {
              onRangeChange(start, end);
              setOpen(false);
            }}
          />
        </Popover.Popup>
      </Popover.Root>
    </div>
  );
}

/**
 * The calendar, two months wide on a desktop and one on a phone. A range is
 * two clicks: the first sets an end and the grid previews the span to whatever
 * the pointer (or the ring) is over, the second commits it. Either end can be
 * clicked first, so a reader who starts at the wrong one is not stuck.
 *
 * Focus is roving, the way a date grid is expected to work: the calendar is one
 * tab stop, arrows walk days and weeks, PageUp/PageDown page months (Shift for
 * years). Only the focused day is tabbable, so Tab leaves the grid rather than
 * walking 42 cells per month.
 *
 * The months on show (`anchor`) are deliberately NOT derived from the focused
 * day. Chromium focuses a button on mousedown, before the click: if the grid
 * re-anchored on focus, pressing a day near the edge could page the calendar
 * and unmount that very button, so the click never landed and the press read as
 * "the calendar jumped instead of picking". Walking with the keyboard moves
 * both; focus alone moves only the ring.
 */
function RangeCalendar({
  from,
  to,
  min,
  max,
  label,
  presets,
  activePreset,
  onPreset,
  onCommit,
}: {
  from: IsoDay;
  to: IsoDay;
  min?: IsoDay;
  max?: IsoDay;
  label: string;
  /** Presets to show above the grid — the ones the track had no room for. */
  presets: DateRangePreset[];
  activePreset: number | null;
  onPreset: (days: number) => void;
  onCommit: (from: IsoDay, to: IsoDay) => void;
}) {
  const isPhone = useIsPhone();
  const monthCount = isPhone ? 1 : 2;
  const today = todayIsoDay();
  // Clamped: a range end outside the bounds would put the grid's only tab stop
  // on a disabled cell, leaving the calendar unreachable by keyboard.
  const end = clampDay(to, min, max);
  // Open on the far end, with the month before it filling the left grid, so a
  // range of a few weeks is visible whole without paging.
  const [anchor, setAnchor] = React.useState<IsoDay>(() =>
    startOfMonth(monthCount > 1 ? addMonths(end, -1) : end),
  );
  const [focused, setFocused] = React.useState<IsoDay>(end);
  /** The first click of a new range, and the day the span is previewed to. */
  const [pending, setPending] = React.useState<IsoDay | null>(null);
  const [preview, setPreview] = React.useState<IsoDay | null>(null);
  // Which day the DOM should take focus to. Only a keyboard move sets it, so
  // paging with the chevrons leaves focus on the chevron.
  const pendingFocus = React.useRef<IsoDay | null>(null);
  const gridRef = React.useRef<HTMLDivElement | null>(null);

  const weekStart = weekStartFor();
  const headings = weekdayHeadings(weekStart);
  const months = Array.from({ length: monthCount }, (_, i) =>
    startOfMonth(addMonths(anchor, i)),
  );

  function focusDay(day: IsoDay) {
    // One button per day across the grids: a day from a neighbouring month is
    // blank here, so it is only ever pressable in its own month.
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
      ?.focus();
  }

  React.useEffect(() => {
    const want = pendingFocus.current;
    pendingFocus.current = null;
    // A move the bounds clamped back onto the current day never re-renders,
    // so the ref can outlive its move; only honour it while it still names
    // the focused day.
    if (!want || want !== focused) return;
    focusDay(want);
  }, [focused]);

  // The grid opens with focus on the end in effect, so the keyboard lands
  // where the eye does. Base UI's own initialFocus can't reach a cell that
  // only exists once this component has rendered. Once per open: the popup
  // unmounts on close, so there is no later state for this to disagree with.
  const focusEndOnce = React.useEffectEvent(() => focusDay(end));
  React.useEffect(() => {
    focusEndOnce();
    // Once per open: the popup unmounts on close.
  }, []);

  // A viewport that crosses the phone breakpoint while the popup is open can
  // drop the month the ring is in. Bring it back, rather than leaving the
  // grid with no tab stop at all.
  React.useEffect(() => {
    if (!months.some((m) => isSameMonth(focused, m)))
      setAnchor(startOfMonth(focused));
  }, [months, focused]);

  /** A keyboard step: the ring, the preview and the months follow the day. */
  function moveTo(day: IsoDay) {
    // Walking past a bound stops at it rather than doing nothing: the reader
    // asked to go that way, and the edge of the range is where that ends.
    const next = clampDay(day, min, max);
    if (next === focused) return;
    pendingFocus.current = next;
    setFocused(next);
    if (pending) setPreview(next);
    const month = next.slice(0, 7);
    if (month < months[0].slice(0, 7)) setAnchor(startOfMonth(next));
    else if (month > months[months.length - 1].slice(0, 7)) {
      setAnchor(startOfMonth(addMonths(next, -(monthCount - 1))));
    }
  }

  /** A chevron press: the months turn under the ring, focus stays put. */
  function pageMonth(delta: number) {
    const next = startOfMonth(addMonths(anchor, delta));
    setAnchor(next);
    // Keep the roving tab stop inside the months now on show, on the same day
    // of the month, entering from the side the step came from.
    const landing =
      delta < 0 ? next : startOfMonth(addMonths(next, monthCount - 1));
    setFocused(clampDay(dayInMonth(landing, dayOfMonth(focused)), min, max));
  }

  function pick(day: IsoDay) {
    if (!pending) {
      setPending(day);
      setPreview(day);
      return;
    }
    setPending(null);
    setPreview(null);
    // Either end can be clicked first, so the pair is ordered here rather
    // than asking the reader to start at the left.
    if (day < pending) onCommit(day, pending);
    else onCommit(pending, day);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    let dayStep: number | undefined;
    switch (e.key) {
      case "ArrowLeft":
        dayStep = -1;
        break;
      case "ArrowRight":
        dayStep = 1;
        break;
      case "ArrowUp":
        dayStep = -7;
        break;
      case "ArrowDown":
        dayStep = 7;
        break;
    }
    if (dayStep !== undefined) {
      e.preventDefault();
      moveTo(addDays(focused, dayStep));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const by = e.key === "PageUp" ? -1 : 1;
      moveTo(addMonths(focused, e.shiftKey ? by * 12 : by));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const offset =
        (new Date(`${focused}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7;
      moveTo(addDays(focused, e.key === "Home" ? -offset : 6 - offset));
    }
  }

  // While a range is being drafted the band follows the draft, so the span
  // under the pointer is the one being proposed. The committed range is what
  // is painted the rest of the time.
  const bandFrom = pending
    ? preview && preview < pending
      ? preview
      : pending
    : from;
  const bandTo = pending
    ? preview && preview > pending
      ? preview
      : pending
    : to;
  // A step is only offered when some day beyond the months on show can be
  // picked.
  const canGoBack = !min || min < months[0];
  const canGoForward = !max || max >= addMonths(months[months.length - 1], 1);

  return (
    <div className="p-2.5" role="group" aria-label={label}>
      {presets.length > 0 && (
        <Segmented
          label="Preset ranges"
          size="md"
          value={activePreset === null ? null : String(activePreset)}
          onValueChange={(v) => onPreset(Number(v))}
          // Full width, so the options divide the popup rather than huddling
          // in one corner of it.
          className="mb-2 flex w-full [&>*]:flex-1"
        >
          {presets.map((p) => (
            <SegmentedOption
              key={p.label}
              value={String(p.days)}
              className="justify-center"
            >
              <span className="w-full text-center">{p.label}</span>
            </SegmentedOption>
          ))}
        </Segmented>
      )}
      <div ref={gridRef} onKeyDown={onKeyDown} className="flex gap-4">
        {months.map((month, index) => {
          const title = monthTitle(month);
          const first = index === 0;
          const last = index === months.length - 1;
          return (
            // Wider on a phone, where a day is a thumb target rather than a
            // click: 308px puts the columns on 44px and still clears the
            // 390px viewport.
            <div key={month} className="w-[252px] phone:w-[308px]">
              {/* The title is centred between the chevrons rather than sitting
							    on the grid's left edge: with two grids side by side, a
							    left-aligned title and one pair of chevrons can't say which
							    month a step is about. Each grid keeps the step that leaves
							    the pair, on its own outer edge. */}
              <div className="flex items-center justify-between gap-1 pb-1.5">
                {first ? (
                  <MonthStep
                    label="Previous month"
                    enabled={canGoBack}
                    onStep={() => pageMonth(-1)}
                    icon={<IconChevronLeft size={20} />}
                  />
                ) : (
                  <span aria-hidden className="size-[26px]" />
                )}
                {/* Live, because a chevron turns the month without moving
								    focus. */}
                <div
                  aria-live="polite"
                  className="text-item-title font-semibold text-fg"
                >
                  {title}
                </div>
                {last ? (
                  <MonthStep
                    label="Next month"
                    enabled={canGoForward}
                    onStep={() => pageMonth(1)}
                    icon={<IconChevronRight size={20} />}
                  />
                ) : (
                  <span aria-hidden className="size-[26px]" />
                )}
              </div>

              {/* Gapless columns: the range band has to run unbroken across a
							    week, so the air between days lives inside each cell, around
							    the chip. Each row is its own 7-column grid rather than one
							    42-cell grid, because `role="grid"` wants real rows between
							    it and its cells. */}
              <div role="grid" aria-label={title}>
                <div role="row" className="grid grid-cols-7">
                  {headings.map((h) => (
                    <span
                      key={h.long}
                      role="columnheader"
                      aria-label={h.long}
                      className="pb-1 text-center text-meta font-medium text-faint"
                    >
                      {/* The initial is decoration: every cell below announces
											    its own weekday, and a `title` here would raise the
											    browser's own tooltip over our popup. */}
                      <span aria-hidden>{h.short}</span>
                    </span>
                  ))}
                </div>
                {monthGrid(month, weekStart).map((week) => (
                  <div key={week[0]} role="row" className="grid grid-cols-7">
                    {week.map((day, i) => {
                      // A day from a neighbouring month is blank: with two
                      // grids on screen it would otherwise print the same date
                      // twice, once in each, and a range band would be painted
                      // across both copies.
                      if (!isSameMonth(day, month)) {
                        return (
                          <div
                            key={day}
                            role="gridcell"
                            className="h-9 phone:h-12"
                          />
                        );
                      }
                      const span = rangeSpanAt(day, week, i, bandFrom, bandTo);
                      return (
                        <Day
                          key={day}
                          day={day}
                          // The ends of the span carry the fill; everything
                          // between them is band.
                          selected={day === bandFrom || day === bandTo}
                          today={day === today}
                          disabled={!isWithin(day, min, max)}
                          tabbable={day === focused}
                          // The band stops at the edge of its month with a
                          // rounded end rather than running into the blanks:
                          // the grid beside this one picks it up.
                          span={
                            span && {
                              open:
                                span.open ||
                                !isSameMonth(week[i - 1] ?? "", month),
                              close:
                                span.close ||
                                !isSameMonth(week[i + 1] ?? "", month),
                            }
                          }
                          onPick={pick}
                          onPreview={() => pending && setPreview(day)}
                          onFocus={() => setFocused(day)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A month chevron. It goes `aria-disabled` rather than `disabled` at the end
 * of the range: a real `disabled` attribute arriving on the button that
 * currently holds focus drops focus to the document, so paging to the last
 * available month would strand a keyboard user.
 */
function MonthStep({
  label,
  enabled,
  onStep,
  icon,
}: {
  label: string;
  enabled: boolean;
  onStep: () => void;
  icon: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-disabled={enabled ? undefined : true}
      className="aria-disabled:pointer-events-none aria-disabled:opacity-40"
      onClick={() => enabled && onStep()}
      icon={icon}
    />
  );
}

function Day({
  day,
  selected,
  today,
  disabled,
  tabbable,
  span,
  onPick,
  onPreview,
  onFocus,
}: {
  day: IsoDay;
  selected: boolean;
  today: boolean;
  disabled: boolean;
  tabbable: boolean;
  span: RangeSpan;
  onPick: (day: IsoDay) => void;
  onPreview: () => void;
  onFocus: () => void;
}) {
  const name = formatDayLong(day);
  return (
    // 36px row holding a 32px chip: the 4px is the air between weeks, and
    // the band takes exactly the chip's height so an endpoint fuses with the
    // span instead of standing a step taller than it.
    <div
      role="gridcell"
      aria-selected={selected}
      className="relative grid h-9 place-items-center phone:h-12"
    >
      {span && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 inset-y-0.5 bg-accent-soft",
            span.open && "rounded-l-md",
            span.close && "rounded-r-md",
          )}
        />
      )}
      <button
        type="button"
        data-day={day}
        tabIndex={tabbable ? 0 : -1}
        disabled={disabled}
        // Screen readers read state off the focused element, and the
        // `aria-selected` above sits on the cell around it, so an end of the
        // range says so in its own name.
        aria-label={selected ? `${name}, selected` : name}
        aria-current={today ? "date" : undefined}
        onClick={() => onPick(day)}
        onPointerEnter={onPreview}
        onFocus={onFocus}
        className={cn(
          "relative grid h-8 w-full cursor-pointer place-items-center rounded-md",
          "text-control-label tabular-nums phone:h-11 phone:text-item-title",
          "transition-[color,background-color] duration-[var(--dur-micro)] ease-[var(--ease)]",
          "focus-ring text-fg",
          // Today is marked by an edge rather than a fill: a second filled
          // day in the month would compete with the ends of the range.
          today &&
            !selected &&
            "font-semibold ring-1 ring-line-strong ring-inset",
          selected
            ? "bg-accent font-semibold text-on-accent hover:bg-accent-hover"
            : "hover:bg-hover",
          "disabled:cursor-default disabled:text-faint disabled:opacity-45 disabled:hover:bg-transparent",
        )}
      >
        {dayOfMonth(day)}
      </button>
    </div>
  );
}
