import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useCallback, useEffect, useState } from "react";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import {
  fetchSessionSandbox,
  sandboxAction,
  type SessionSandboxStatus,
} from "../lib/api/sandboxes";
import { IconBox, IconConnections } from "./icons";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  flexNone: {
    flex: "none",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  transitionColorBackgroundColorBorderColorScale: {
    transitionProperty: "color,background-color,border-color,scale",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBorderLineStrong: {
    "@media (hover: hover)": {
      ":hover": {
        borderColor: "var(--border-strong)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  focusVisibleBorderLineStrong: {
    ":focus-visible": {
      borderColor: "var(--border-strong)",
    },
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  w300px: {
    width: "300px",
  },
  p25: {
    padding: "calc(4px * 2.5)",
  },
  pb2: {
    paddingBottom: "calc(4px * 2)",
  },
  pt1: {
    paddingTop: "4px",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  mt1: {
    marginTop: "4px",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textRed: {
    color: "var(--red)",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  maxH48: {
    maxHeight: "calc(4px * 48)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
});

type SandboxRef = {
  provider: string;
  sandboxId?: string;
  workspace?: "bind" | "volume";
};

type RunnerRef = {
  id: string;
  name: string;
  workspacePath: string;
  lifecycle?: "preparing" | "awake" | "offline" | "needs_attention";
  lastLifecycleError?: string;
};

const actionClass = utilityClassName(
  "flex min-h-10 w-full items-center rounded-md px-2.5 text-left text-xs font-semibold text-dim outline-none transition-[color,background-color,scale] hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45",
);

/** Live sandbox status + lifecycle controls. The compact trigger remains the
 * old provider badge; opening it resolves provider state without polling every
 * session row in the background. */
export function SandboxBadge({
  sessionId,
  sandbox,
  runner,
}: {
  sessionId: string;
  sandbox?: SandboxRef;
  runner?: RunnerRef;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SessionSandboxStatus | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    await (async () => {
      setStatus(await fetchSessionSandbox(sessionId));
      setError(null);
    })().catch(async (cause) => {
      setError(errorMessage(cause, "Sandbox status unavailable"));
    });
  }, [sessionId]);

  useEffect(() => {
    if (runner) return;
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [open, load, runner]);

  if (runner) {
    const label =
      runner.lifecycle === "awake"
        ? "Ready"
        : runner.lifecycle === "offline"
          ? "Offline"
          : runner.lifecycle === "needs_attention"
            ? "Needs attention"
            : "Preparing";
    const dot =
      runner.lifecycle === "awake"
        ? "bg-green"
        : runner.lifecycle === "offline" ||
            runner.lifecycle === "needs_attention"
          ? "bg-faint"
          : "bg-yellow";
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={mergeStylexOverrideClassName(
            "",
            sx.flex,
            sx.minH10,
            sx.flexNone,
            sx.itemsCenter,
            sx.gap15,
            sx.roundedMd,
            sx.border,
            sx.borderLine,
            sx.bgSurface,
            sx.px2,
            sx.fontMedium,
            sx.textDim,
            sx.outlineNone,
            sx.transitionColorBackgroundColorBorderColorScale,
            sx.hoverBorderLineStrong,
            sx.hoverTextFg,
            sx.focusVisibleBorderLineStrong,
            sx.activeScale096,
            typography.meta,
          )}
          aria-label={`Runner · ${runner.name} · ${label}`}
        >
          <span
            className={cn(utilityClassName("size-2 rounded-full"), dot)}
            aria-hidden="true"
          />
          <IconConnections
            size={20}
            className={mergeStylexOverrideClassName("", sx.textFaint)}
          />
          <span>{runner.name}</span>
        </Popover.Trigger>
        <Popover.Popup
          side="bottom"
          align="start"
          initialFocus
          className={mergeStylexOverrideClassName("", sx.w300px, sx.p25)}
        >
          <div {...stylex.props(sx.px2, sx.pb2, sx.pt1)}>
            <div
              {...stylex.props(
                sx.flex,
                sx.itemsCenter,
                sx.gap2,
                sx.textXs,
                sx.fontSemibold,
                sx.textFg,
              )}
            >
              <span
                className={cn(utilityClassName("size-2 rounded-full"), dot)}
              />
              <span>{label}</span>
              <span {...stylex.props(sx.mlAuto, sx.fontMedium, sx.textFaint)}>
                Runtime
              </span>
            </div>
            <div {...stylex.props(sx.mt1, sx.textDim, typography.meta)}>
              Runner · trusted machine
            </div>
            <div
              {...stylex.props(
                sx.mt1,
                sx.truncate,
                sx.fontMono,
                sx.textFaint,
                typography.meta,
              )}
              title={runner.workspacePath}
            >
              {runner.workspacePath}
            </div>
          </div>
          {runner.lastLifecycleError ? (
            <div
              {...stylex.props(
                sx.px2,
                sx.py15,
                sx.fontMedium,
                sx.textRed,
                typography.meta,
              )}
            >
              {runner.lastLifecycleError}
            </div>
          ) : null}
        </Popover.Popup>
      </Popover.Root>
    );
  }

  if (!sandbox?.provider || sandbox.provider === "local") return null;
  const state = status?.status || (sandbox.sandboxId ? "running" : "gone");
  const lifecycle =
    status?.lifecycle ||
    (state === "running"
      ? "awake"
      : state === "stopped"
        ? "sleeping"
        : "needs_attention");
  const lifecycleLabel: Record<typeof lifecycle, string> = {
    preparing: "Preparing",
    awake: "Awake",
    sleeping: "Sleeping",
    waking: "Waking",
    needs_attention: "Needs attention",
  };
  const dot =
    lifecycle === "awake"
      ? utilityClassName("bg-green")
      : lifecycle === "sleeping" || lifecycle === "waking"
        ? utilityClassName("bg-yellow")
        : utilityClassName("bg-faint");

  async function act(action: "pause" | "resume" | "recreate") {
    if (
      action === "recreate" &&
      !window.confirm(
        "Recreate this sandbox? Unpushed files that exist only inside it will be deleted.",
      )
    )
      return;
    setWorking(action);
    setError(null);
    await (async () => {
      setStatus(await sandboxAction(sessionId, action));
    })()
      .catch(async (cause) => {
        setError(errorMessage(cause, `Could not ${action} sandbox`));
      })
      .finally(async () => {
        setWorking(null);
      });
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.minH10,
          sx.flexNone,
          sx.itemsCenter,
          sx.gap15,
          sx.roundedMd,
          sx.border,
          sx.borderLine,
          sx.bgSurface,
          sx.px2,
          sx.fontMedium,
          sx.textDim,
          sx.outlineNone,
          sx.transitionColorBackgroundColorBorderColorScale,
          sx.hoverBorderLineStrong,
          sx.hoverTextFg,
          sx.focusVisibleBorderLineStrong,
          sx.activeScale096,
          typography.meta,
        )}
        data-testid="sandbox-badge"
        aria-label={`Sandbox · ${lifecycleLabel}`}
      >
        <span
          className={cn(utilityClassName("size-2 rounded-full"), dot)}
          aria-hidden="true"
        />
        <IconBox
          size={20}
          className={mergeStylexOverrideClassName("", sx.textFaint)}
        />
        <span>Sandbox</span>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className={mergeStylexOverrideClassName("", sx.w300px, sx.p25)}
      >
        <div {...stylex.props(sx.px2, sx.pb2, sx.pt1)}>
          <div
            {...stylex.props(
              sx.flex,
              sx.itemsCenter,
              sx.gap2,
              sx.textXs,
              sx.fontSemibold,
              sx.textFg,
            )}
          >
            <span
              className={cn(utilityClassName("size-2 rounded-full"), dot)}
            />
            <span>{lifecycleLabel[lifecycle]}</span>
            <span {...stylex.props(sx.mlAuto, sx.fontMedium, sx.textFaint)}>
              Runtime
            </span>
          </div>
          <div {...stylex.props(sx.mt1, sx.textDim, typography.meta)}>
            {sandbox.provider} · session workspace
          </div>
          {status?.cwd ? (
            <div
              {...stylex.props(
                sx.mt1,
                sx.truncate,
                sx.fontMono,
                sx.textFaint,
                typography.meta,
              )}
              title={status.cwd}
            >
              {status.cwd}
            </div>
          ) : null}
        </div>
        {lifecycle === "awake" && status?.canPause ? (
          <button
            className={actionClass}
            disabled={Boolean(working || status.busy)}
            onClick={() => void act("pause")}
          >
            {working === "pause" ? "Sleeping…" : "Sleep sandbox"}
          </button>
        ) : null}
        {(lifecycle === "sleeping" || lifecycle === "needs_attention") &&
        status?.canResume ? (
          <button
            className={actionClass}
            disabled={Boolean(working)}
            onClick={() => void act("resume")}
          >
            {working === "resume" ? "Waking…" : "Wake sandbox"}
          </button>
        ) : null}
        <button
          className={cn(
            actionClass,
            utilityClassName("text-red hover:text-red"),
          )}
          disabled={Boolean(working || status?.busy)}
          onClick={() => void act("recreate")}
        >
          {working === "recreate" ? "Recreating…" : "Recreate from clean image"}
        </button>
        {status?.logs?.setup || status?.logs?.resume ? (
          <details
            {...stylex.props(
              sx.mt1,
              sx.roundedMd,
              sx.bgSurface,
              sx.px25,
              sx.py2,
              sx.textDim,
              typography.meta,
            )}
          >
            <summary
              {...stylex.props(sx.cursorPointer, sx.fontSemibold, sx.textFg)}
            >
              Lifecycle logs
            </summary>
            <pre
              {...stylex.props(
                sx.mt2,
                sx.maxH48,
                sx.overflowAuto,
                sx.whitespacePreWrap,
                sx.fontMono,
                sx.leadingRelaxed,
                typography.meta,
              )}
            >
              {status.logs.setup ? `setup\n${status.logs.setup}` : ""}
              {status.logs.resume ? `\nresume\n${status.logs.resume}` : ""}
            </pre>
          </details>
        ) : null}
        {status?.lastLifecycleError || error ? (
          <div
            {...stylex.props(
              sx.px2,
              sx.py15,
              sx.fontMedium,
              sx.textRed,
              typography.meta,
            )}
          >
            {status?.lastLifecycleError || error}
          </div>
        ) : null}
      </Popover.Popup>
    </Popover.Root>
  );
}
