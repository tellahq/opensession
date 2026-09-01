import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ModelOption } from "../lib/api";
import { matchesShortcut } from "../lib/shortcuts";
import { EFFORTS } from "../components/ModelEffortSelect";

interface KeyboardIdentity {
  focused: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

interface KeyboardModel {
  models: ModelOption[];
  defaultModel: string;
  model: string;
  effort: string;
  setEffort: Dispatch<SetStateAction<string>>;
}

interface KeyboardTranscript {
  messagesRef: RefObject<HTMLDivElement | null>;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  leaveLatest: () => void;
}

interface SessionViewerKeyboardOptions {
  identity: KeyboardIdentity;
  model: KeyboardModel;
  transcript: KeyboardTranscript;
}

export function useSessionViewerKeyboardController({
  identity: { focused, composerRef },
  model: { models, defaultModel, model, effort, setEffort },
  transcript: { messagesRef, scrollToLatest, leaveLatest },
}: SessionViewerKeyboardOptions) {
  // Ctrl+R focuses the session composer directly.
  const composerRefHolder = useRef(composerRef);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (matchesShortcut(e, "composer-focus")) {
        e.preventDefault();
        composerRefHolder.current.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused]);

  // ⌘⌥↑/⌘⌥↓ step the reasoning effort through the current model's supported
  // levels (up = more thinking), wrapping at the ends. Resolves the same
  // effective effort as the ModelEffortSelect pill (stored value when the
  // model offers it, else "high", else the model's first level), so the step
  // always starts from what the pill displays. Fires with the composer
  // focused too — the Alt modifier keeps it clear of plain ⌘↑/⌘↓ (workspace
  // cycling in the Sidebar, and caret start/end moves in the textarea).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (e.defaultPrevented) return;
      const dir = matchesShortcut(e, "effort-up")
        ? 1
        : matchesShortcut(e, "effort-down")
          ? -1
          : 0;
      if (dir === 0) return;
      const effectiveModel = model || defaultModel;
      const supportedIds =
        models.find((m) => m.id === effectiveModel)?.efforts ?? [];
      const supported = EFFORTS.filter((ef) => supportedIds.includes(ef.id));
      if (supported.length < 2) return;
      const effective = supportedIds.includes(effort)
        ? effort
        : supportedIds.includes("high")
          ? "high"
          : supported[0].id;
      const idx = supported.findIndex((ef) => ef.id === effective);
      const next = supported[(idx + dir + supported.length) % supported.length];
      if (!next) return;
      e.preventDefault();
      setEffort(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, models, defaultModel, model, effort, setEffort]);

  // ⌃⇧↑/⌃⇧↓ page the transcript up/down — keyboard scrolling that works while
  // the composer is focused. A programmatic scroll carries no reader gesture,
  // so useSessionScroll won't re-engage auto-follow from it: a Down that would
  // land at the live edge goes through scrollToLatest, which resumes following.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (e.defaultPrevented) return;
      const up = matchesShortcut(e, "transcript-up");
      const down = matchesShortcut(e, "transcript-down");
      if (!up && !down) return;
      const el = messagesRef.current;
      if (!el) return;
      e.preventDefault();
      const delta = Math.max(120, el.clientHeight * 0.8);
      if (down) {
        const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
        if (remaining - delta < 48) {
          scrollToLatest();
          return;
        }
      }
      if (up) leaveLatest();
      el.scrollBy({
        top: up ? -delta : delta,
        behavior: "smooth",
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, messagesRef, scrollToLatest, leaveLatest]);
}
