import type { Ghostty } from "ghostty-web";
import React, { useEffect, useRef, useState } from "react";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/state";
import {
  TAB_GROUP,
  TAB_ITEM,
  TAB_NEW,
  TAB_SCROLL,
  TAB_TITLE,
  tabClass,
  tabCloseClass,
} from "../lib/session-tab-classes";
import { IconPlus, IconX } from "./icons";

/**
 * Interactive terminals over server-side PTYs in the session's worktree:
 * - ShellPanel provides real interactive terminals without leaving the
 *   session's worktree — poke at the agent's checkout without leaving the
 *   browser. Rendered by Ghostty's VT core (libghostty-vt via WASM,
 *   ghostty-web) with an xterm.js fallback — see loadTerminalEngine.
 *   Multiple shell tabs, each its own PTY, multiplexed over the one
 *   session WebSocket by a per-tab `termId` on the term_* frames. A PTY dies
 *   with its tab's ×, the panel unmounting, or the socket — but NOT when
 *   switching side-panel tabs: SessionViewer keeps the ShellPanel mounted
 *   (hidden) once opened.
 *   Sandboxed sessions get their shells INSIDE the sandbox (docker exec /
 *   Daytona PTY — see src/server/terminals.ts); a dim banner says where each
 *   landed.
 */

// ── Interactive shell tabs (xterm.js ↔ server PTYs over the session WS) ──

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface TerminalDisposable {
  dispose(): void;
}

interface TerminalAddon {
  activate: (...args: never[]) => void;
  dispose(): void;
  fit(): void;
}

interface TerminalInstance {
  cols: number;
  rows: number;
  loadAddon(addon: TerminalAddon): void;
  open(element: HTMLElement): void;
  onData(handler: (data: string) => void): TerminalDisposable;
  write(data: string | Uint8Array): void;
  focus(): void;
  dispose(): void;
}

interface TerminalOptions {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  };
  ghostty?: Ghostty;
}

interface TermEngine {
  Terminal: new (options: TerminalOptions) => TerminalInstance;
  FitAddon: new () => TerminalAddon;
  extraOptions: Pick<TerminalOptions, "ghostty">;
}

/**
 * Terminal engine for the shell tabs: Ghostty — the real Ghostty VT core
 * (libghostty-vt compiled to WASM, via coder's xterm.js-API-compatible
 * ghostty-web) — falling back to xterm.js when the WASM can't load (dev
 * mode, missing asset, exotic browser). Loaded once, shared by every tab.
 */
let enginePromise: Promise<TermEngine> | null = null;
function loadTerminalEngine(): Promise<TermEngine> {
  return (enginePromise ??= (async () => {
    try {
      const g = await import("ghostty-web");
      // Explicit wasm path — buildFrontend copies it out of the package into
      // the frontend dist and static-assets.ts serves it there; the bundled
      // chunk's import.meta.url can't locate the package-relative default.
      const ghostty = await g.Ghostty.load("/ghostty-vt.wasm");
      return {
        Terminal: g.Terminal,
        FitAddon: g.FitAddon,
        extraOptions: { ghostty },
      };
    } catch (e) {
      console.warn("[shell] ghostty engine unavailable, using xterm.js", e);
      const [x, f] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      return {
        Terminal: x.Terminal,
        FitAddon: f.FitAddon,
        extraOptions: {},
      };
    }
  })());
}

/** Random per-tab id — keys the PTY on the server (unique per socket; random
 *  so two viewers over one socket, or reopened tabs, can never collide). */
function newTermId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`;
}

interface ShellTabSpec {
  id: string;
  n: number;
}

/** The server caps PTYs per socket at 8 (terminals.ts) — mirror it here. */
const MAX_SHELL_TABS = 8;

export function ShellPanel({
  sessionId,
  visible,
}: {
  sessionId: string;
  /** False while another side-panel tab covers the (still-mounted) panel. */
  visible: boolean;
}) {
  const [tabs, setTabs] = useState<ShellTabSpec[]>(() => [
    { id: newTermId(), n: 1 },
  ]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  const nextN = useRef(2);

  function addTab() {
    if (tabs.length >= MAX_SHELL_TABS) return;
    const tab = { id: newTermId(), n: nextN.current++ };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id && next.length > 0) {
      setActiveId(next[Math.min(idx, next.length - 1)]!.id);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="relative flex h-10 min-w-0 shrink-0 items-center gap-[3px] border-b border-divider bg-surface px-2"
        role="tablist"
        aria-label="Terminals"
      >
        <div className={TAB_SCROLL}>
          <div className={TAB_GROUP}>
            {tabs.map((t, index) => {
              const active = t.id === activeId;
              const nextActive = tabs[index + 1]?.id === activeId;
              return (
                <div
                  key={t.id}
                  className={TAB_ITEM}
                  data-next-active={nextActive || undefined}
                >
                  <div
                    role="tab"
                    aria-selected={active}
                    className={`group/tab ${tabClass({ active, waiting: false, colored: false })}`}
                    onClick={() => setActiveId(t.id)}
                  >
                    <span className={TAB_TITLE}>Terminal {t.n}</span>
                    <button
                      type="button"
                      className={tabCloseClass(false)}
                      aria-label={`Close terminal ${t.n}`}
                      title="Close terminal (kills its PTY)"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(t.id);
                      }}
                    >
                      <IconX size={16} dense aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {tabs.length < MAX_SHELL_TABS && (
          <button
            type="button"
            className={TAB_NEW}
            onClick={addTab}
            title="New terminal tab"
            aria-label="New terminal tab"
          >
            <IconPlus size={20} aria-hidden="true" />
          </button>
        )}
      </div>
      {tabs.length === 0 ? (
        <EmptyState
          action={
            <Button size="sm" variant="soft" onClick={addTab}>
              Open a terminal
            </Button>
          }
        />
      ) : (
        // Every tab stays mounted (hidden when inactive) so switching tabs
        // never kills a PTY; only the × / panel unmount / socket does.
        tabs.map((t) => (
          <ShellView
            key={t.id}
            sessionId={sessionId}
            termId={t.id}
            visible={visible && t.id === activeId}
          />
        ))
      )}
    </div>
  );
}

function ShellView({
  sessionId,
  termId,
  visible,
}: {
  sessionId: string;
  termId: string;
  visible: boolean;
}) {
  const { send, addHandler } = useSessionSocket();
  const hostRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Dynamic import keeps the terminal engine out of the initial bundle.
      const { Terminal, FitAddon, extraOptions } = await loadTerminalEngine();
      if (disposed || !hostRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const term = new Terminal({
        fontSize: 13,
        fontFamily:
          cs.getPropertyValue("--mono").trim() ||
          "ui-monospace, SFMono-Regular, Menlo, monospace",
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: cs.getPropertyValue("--bg").trim() || "#141414",
          foreground: cs.getPropertyValue("--text").trim() || "#e6e6e6",
          cursor: cs.getPropertyValue("--accent").trim() || "#e6e6e6",
          selectionBackground: "rgba(128,128,128,0.35)",
        },
        ...extraOptions,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      // The host is inset by its wrapper below, so both fit addons measure the
      // actual available canvas instead of drawing beneath visual padding.
      fit.fit();

      send({
        type: "term_start",
        sessionId,
        termId,
        cols: term.cols,
        rows: term.rows,
      });

      const offData = term.onData((d: string) =>
        send({ type: "term_input", termId, data: b64encode(d) }),
      );
      const offMsg = addHandler((msg) => {
        // Frames are tagged with the termId of the PTY they belong to — route
        // only ours. (Untagged frames from a pre-multi-tab server — the cloud
        // upstream mid-deploy — fall through to every tab: single-tab compat.)
        const taggedTermId = "termId" in msg ? msg.termId : undefined;
        if (taggedTermId != null && taggedTermId !== termId) return;
        if (msg.type === "term_data") term.write(b64decode(msg.data));
        else if (msg.type === "term_ready" && msg.target !== "host")
          // Remote sessions run their shell in the selected workspace.
          term.write(
            `\x1b[2m[shell inside ${msg.target === "runner" ? "Runner" : `${msg.target} sandbox`} · ${msg.cwd || ""}]\x1b[0m\r\n`,
          );
        else if (msg.type === "term_notice")
          term.write(`\x1b[2m[${msg.message}]\x1b[0m\r\n`);
        else if (msg.type === "term_exit")
          term.write(
            "\r\n\x1b[2m[shell exited. Close this tab or open a new one]\x1b[0m\r\n",
          );
      });

      const refit = () => {
        // A hidden host (inactive tab / covered panel) measures 0×0 — fitting
        // then would garbage the PTY size; the show handler refits instead.
        const el = hostRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        try {
          fit.fit();
          send({
            type: "term_resize",
            termId,
            cols: term.cols,
            rows: term.rows,
          });
        } catch {}
      };
      showRef.current = () => {
        refit();
        term.focus();
      };
      const ro = new ResizeObserver(refit);
      ro.observe(hostRef.current);
      term.focus();

      cleanup = () => {
        offData.dispose();
        offMsg();
        ro.disconnect();
        send({ type: "term_stop", termId });
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId, termId, send, addHandler]);

  // Becoming the visible tab again: refit (the panel may have resized while
  // this tab was hidden) and take focus.
  useEffect(() => {
    if (visible) showRef.current();
  }, [visible]);

  return (
    <div
      className={`flex-1 min-h-0 overflow-hidden bg-surface pl-4 pt-2 pb-1.5 ${visible ? "" : "hidden"}`}
    >
      {/* Ghostty mounts its hidden keyboard textarea absolutely. Keep this
          host positioned so that input remains inside the terminal instead of
          escaping to the page's top-left corner. */}
      <div ref={hostRef} className="relative size-full overflow-hidden" />
    </div>
  );
}
