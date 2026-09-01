import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence } from "motion/react";
import { LiveTurnStore } from "../lib/live-turn-store";
import {
  applyTranscriptMotionEvent,
  makeTranscriptHydrationScenario,
  makeTranscriptMotionScenario,
  makeTranscriptStreamPerformanceScenario,
  type TranscriptMotionScenario,
  type TranscriptMotionScenarioEvent,
} from "../lib/transcript-motion-scenarios";
import { VIEWER_MESSAGES } from "../lib/session-viewer-classes";
import { useSessionScroll } from "../hooks/useSessionScroll";
import { Button } from "../ui/button";
import { SessionTranscript } from "./SessionTranscript";
import { BusyInline } from "./session-viewer/busy-indicators";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  hDvh: {
    height: "100dvh",
  },
  minH0: {
    minHeight: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  textFg: {
    color: "var(--text)",
  },
  minH14: {
    minHeight: "calc(4px * 14)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  desktopPx6: {
    "@media (min-width: 721px)": {
      paddingInline: "calc(4px * 6)",
    },
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  flex1: {
    flex: "1",
  },
  mxAuto: {
    marginInline: "auto",
  },
  minH16: {
    minHeight: "calc(4px * 16)",
  },
  wFull: {
    width: "100%",
  },
  maxWVarSessionCol: {
    maxWidth: "var(--session-col)",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px35: {
    paddingInline: "calc(4px * 3.5)",
  },
});

type TranscriptMotionControl = {
  paused: boolean;
  followLatest: () => void;
  step?: () => boolean;
};

declare global {
  interface Window {
    __transcriptMotionControl?: TranscriptMotionControl;
  }
}

export function TranscriptMotionLab({
  initialSeed,
  speed,
  profile,
}: {
  initialSeed: number;
  speed: number;
  profile: "motion" | "stream" | "hydration";
}) {
  const [seed, setSeed] = useState(initialSeed);
  const [run, setRun] = useState(0);
  const [status, setStatus] = useState<"running" | "settling" | "done">(
    "running",
  );
  const scenario =
    profile === "stream"
      ? makeTranscriptStreamPerformanceScenario()
      : profile === "hydration"
        ? makeTranscriptHydrationScenario()
        : makeTranscriptMotionScenario(seed);

  useEffect(() => {
    const splash = document.getElementById("splash");
    if (!splash) return;
    splash.classList.add("splash-hide");
    const removal = window.setTimeout(() => splash.remove(), 400);
    return () => window.clearTimeout(removal);
  }, []);

  return (
    <main
      {...stylex.props(
        sx.flex,
        sx.hDvh,
        sx.minH0,
        sx.flexCol,
        sx.bgSurface,
        sx.textFg,
      )}
      data-transcript-motion-state={status}
      data-transcript-motion-seed={seed}
      data-transcript-motion-speed={speed}
      data-transcript-motion-profile={profile}
      data-transcript-motion-events={scenario.events.length}
    >
      <header
        {...stylex.props(
          sx.flex,
          sx.minH14,
          sx.shrink0,
          sx.itemsCenter,
          sx.justifyBetween,
          sx.gap4,
          sx.px4,
          sx.desktopPx6,
        )}
      >
        <div {...stylex.props(sx.minW0)}>
          <h1
            {...stylex.props(
              sx.truncate,
              sx.fontSemibold,
              typography.itemTitle,
            )}
          >
            Transcript motion lab
          </h1>
          <p {...stylex.props(sx.truncate, sx.textFaint, typography.label)}>
            No network ·{" "}
            {profile === "stream"
              ? "10k · 100 deltas/s"
              : profile === "hydration"
                ? "incremental history"
                : `seed ${seed}`}{" "}
            · {speed}×
          </p>
        </div>
        <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2)}>
          <Button
            variant="soft"
            className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
            onClick={() => {
              setStatus("running");
              setRun((value) => value + 1);
            }}
          >
            Replay
          </Button>
          {profile === "motion" && (
            <Button
              variant="soft"
              className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
              onClick={() => {
                setStatus("running");
                setSeed((value) => value + 1);
                setRun((value) => value + 1);
              }}
            >
              Next seed
            </Button>
          )}
        </div>
      </header>
      <TranscriptMotionPlayer
        key={`${seed}:${run}`}
        scenario={scenario}
        speed={speed}
        manual={profile === "hydration"}
        onStatusChange={setStatus}
      />
    </main>
  );
}

function TranscriptMotionPlayer({
  scenario,
  speed,
  manual,
  onStatusChange,
}: {
  scenario: TranscriptMotionScenario;
  speed: number;
  manual: boolean;
  onStatusChange: (status: "running" | "settling" | "done") => void;
}) {
  const [state, setState] = useState(scenario.initial);
  const [eventIndex, setEventIndex] = useState(0);
  const [liveTurnStore] = useState(() => new LiveTurnStore());
  const busyRef = useRef(state.busy);
  const [busySince] = useState(() => Date.now());
  const settleTimer = useRef<number | undefined>(undefined);
  const {
    setContainerRef,
    spacerRef,
    beginTurn,
    endTurn,
    shouldMaintainEnd,
    relayout,
    onScroll,
    scrollToLatest,
  } = useSessionScroll(true);

  const applyEvent = useEffectEvent((event: TranscriptMotionScenarioEvent) => {
    switch (event.kind) {
      case "begin-turn":
        beginTurn();
        break;
      case "stream-start":
        liveTurnStore.start("Fixture", `fixture-run-${scenario.seed}`);
        break;
      case "stream-append":
        liveTurnStore.append(event.text, event.blockId);
        break;
      case "stream-land":
        liveTurnStore.land([{ id: event.id, content: event.content }]);
        break;
      case "stream-finish":
        liveTurnStore.finish();
        break;
    }
    setState((current) => applyTranscriptMotionEvent(current, event));
  });

  useEffect(() => {
    const control: TranscriptMotionControl = {
      paused: false,
      followLatest: () => scrollToLatest("auto"),
      step: manual
        ? () => {
            const event = scenario.events[eventIndex];
            if (!event) return false;
            applyEvent(event);
            const next = eventIndex + 1;
            setEventIndex(next);
            if (next === scenario.events.length) onStatusChange("done");
            return true;
          }
        : undefined,
    };
    window.__transcriptMotionControl = control;
    return () => {
      if (window.__transcriptMotionControl === control)
        delete window.__transcriptMotionControl;
    };
  }, [eventIndex, manual, onStatusChange, scenario, scrollToLatest]);

  useEffect(() => {
    if (manual) return () => liveTurnStore.clear();
    let frame = 0;
    let next = 0;
    let elapsed = 0;
    let previousAt = performance.now();
    const tick = (now: number) => {
      if (!window.__transcriptMotionControl?.paused)
        elapsed += (now - previousAt) * speed;
      previousAt = now;
      while (
        next < scenario.events.length &&
        (scenario.events[next]?.atMs ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        const event = scenario.events[next];
        if (event) applyEvent(event);
        next = next + 1;
        setEventIndex(next);
      }
      if (next < scenario.events.length) {
        frame = requestAnimationFrame(tick);
        return;
      }
      onStatusChange("settling");
      settleTimer.current = window.setTimeout(
        () => onStatusChange("done"),
        600,
      );
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (settleTimer.current !== undefined)
        window.clearTimeout(settleTimer.current);
      liveTurnStore.clear();
    };
  }, [manual, scenario, speed, liveTurnStore, onStatusChange]);

  useLayoutEffect(() => {
    if (busyRef.current && !state.busy) endTurn();
    busyRef.current = state.busy;
    relayout();
  }, [state, endTurn, relayout]);

  return (
    <section
      {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.flexCol)}
      data-transcript-motion-event={eventIndex}
      style={
        {
          "--session-under": "0px",
          "--pane-header-h": "0px",
          "--strip-clearance": "0px",
        } as React.CSSProperties
      }
    >
      <div
        ref={setContainerRef}
        onScroll={onScroll}
        className={VIEWER_MESSAGES}
        data-transcript-motion-scroller
      >
        <SessionTranscript
          entries={state.entries}
          optimisticEntries={state.optimisticEntries}
          transcriptIndex={state.transcriptIndex}
          live={state.busy}
          sessionId=""
          liveTurnStore={liveTurnStore}
          shouldMaintainEnd={shouldMaintainEnd}
          onLayout={relayout}
        />
        <AnimatePresence initial={false}>
          {state.busy && (
            <BusyInline
              key="busy"
              since={busySince}
              stoppingSince={null}
              liveTurnStore={liveTurnStore}
              onLayout={relayout}
            />
          )}
        </AnimatePresence>
        <div ref={spacerRef} aria-hidden="true" />
      </div>
      <div
        {...stylex.props(
          sx.mxAuto,
          sx.flex,
          sx.minH16,
          sx.wFull,
          sx.maxWVarSessionCol,
          sx.shrink0,
          sx.itemsCenter,
          sx.px4,
        )}
      >
        <div
          {...mergeStylexProps(
            "text-input shadow-sm",
            sx.flex,
            sx.minH11,
            sx.wFull,
            sx.itemsCenter,
            sx.roundedControl,
            sx.bgPanel,
            sx.px35,
            sx.textFaint,
          )}
        >
          Synthetic composer
        </div>
      </div>
    </section>
  );
}
