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
  growTranscriptMotionEntry,
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

type TranscriptMotionControl = {
  paused: boolean;
  followLatest: () => void;
  step?: () => boolean;
  /** Grow a loaded entry in place, wherever the reader is. Lets a driver
   * exercise growth above the reader inside their own row, in the row above,
   * or during a fling, none of which a keyed prepend covers. */
  grow?: (entryId: string) => boolean;
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
      className="flex h-dvh min-h-0 flex-col bg-surface text-fg"
      data-transcript-motion-state={status}
      data-transcript-motion-seed={seed}
      data-transcript-motion-speed={speed}
      data-transcript-motion-profile={profile}
      data-transcript-motion-events={scenario.events.length}
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 px-4 desktop:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-item-title font-semibold">
            Transcript motion lab
          </h1>
          <p className="truncate text-label text-faint">
            No network ·{" "}
            {profile === "stream"
              ? "10k · 100 deltas/s"
              : profile === "hydration"
                ? "incremental history"
                : `seed ${seed}`}{" "}
            · {speed}×
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="soft"
            className="phone:min-h-11"
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
              className="phone:min-h-11"
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
      grow: manual
        ? (entryId) => {
            if (
              !scenario.initial.transcriptIndex?.some(
                (entry) => entry.id === entryId,
              )
            )
              return false;
            setState((current) => growTranscriptMotionEntry(current, entryId));
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
      className="flex min-h-0 flex-1 flex-col"
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
      <div className="mx-auto flex min-h-16 w-full max-w-[var(--session-col)] shrink-0 items-center px-4">
        <div className="flex min-h-11 w-full items-center rounded-control bg-panel px-3.5 text-input text-faint shadow-sm">
          Synthetic composer
        </div>
      </div>
    </section>
  );
}
