import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { BASE_PATH } from "../lib/base";
import React from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { fieldClasses } from "../ui/input";
import { IconCopy } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  h15: {
    height: "calc(4px * 1.5)",
  },
  w15: {
    width: "calc(4px * 1.5)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  gap1: {
    gap: "4px",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py1: {
    paddingBlock: "4px",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgActive: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--bg-active)",
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
  textFaint: {
    color: "var(--text-faint)",
  },
  m0: {
    margin: "0",
  },
  listNone: {
    listStyleType: "none",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  p0: {
    padding: "0",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  mtPx: {
    marginTop: "1px",
  },
  size18px: {
    width: "18px",
    height: "18px",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  text10px: {
    fontSize: "10px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  mb1: {
    marginBottom: "4px",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  selfStart: {
    alignSelf: "flex-start",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textRed: {
    color: "var(--red)",
  },
  textGreen: {
    color: "var(--green)",
  },
  underline: {
    textDecorationLine: "underline",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  pl15: {
    paddingLeft: "calc(4px * 1.5)",
  },
  pr1: {
    paddingRight: "4px",
  },
  textLeft: {
    textAlign: "left",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  text092em: {
    fontSize: "0.92em",
  },
  textFg: {
    color: "var(--text)",
  },
  breakAll: {
    wordBreak: "break-all",
  },
  OverflowWrapAnywhere: {
    overflowWrap: "anywhere",
  },
  whitespaceNormal: {
    whiteSpace: "normal",
  },
});

// Shared vocabulary for the Settings → Setup page (Setup.tsx) and its section
// siblings (SetupTeam.tsx, SetupRepos.tsx): the /api/setup/* response shapes,
// the state chip, the inline mono tokens, and one fetch helper that unwraps
// the backend's `{error}` bodies.

export interface SetupEnvVar {
  name: string;
  required: boolean;
  description: string;
  present: boolean;
}

export interface SetupLink {
  label: string;
  url: string;
}

export interface SetupIntegration {
  id: string;
  label: string;
  doc: string;
  enabled: boolean;
  env: SetupEnvVar[];
  links: SetupLink[];
  missingRequired: string[];
}

export interface SetupGithub {
  userPrAuth: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  mentionHandle: string;
  appCredentialConfigured: boolean;
  privateKeyConfigured: boolean;
  appSlug: string | null;
  installationOwner: string | null;
  appOrg?: string | null;
  appCreateUrl: string;
}

/** Whether a repo commits the lifecycle scripts that let sessions provision
 *  and boot it unattended (docs/repo-lifecycle.md). `dir` is the lifecycle
 *  directory (`.agents`), null when the repo doesn't commit one. */
export interface SetupRepoLifecycle {
  dir: string | null;
  setup: boolean;
  start: boolean;
  previewJson: boolean;
  previewCommand: boolean;
}

export interface SetupRepo {
  id: string;
  label: string;
  path: string;
  defaultBranch: string;
  /** Where new code sessions run. Existing sessions keep their current checkout. */
  isolatedWorktrees: boolean;
  lifecycle: SetupRepoLifecycle;
}

/** Whether the instance can actually run an agent turn — the one thing the
 *  Getting-started checklist used to omit. Server-side: engine-status.ts. */
export interface SetupEngine {
  claudeBin: string | null;
  claudeAccounts: number;
  codexAccounts: number;
  defaultModel: string;
  provider?: "claude" | "codex";
  ready: boolean;
  blocker: string | null;
  fix: string | null;
  /** The blocker is a PUT away, so the row can offer a button. */
  fixableInApp: boolean;
}

export interface SetupAccess {
  publicBaseUrl: string;
  port: number;
  tailnetIp: string | null;
  caddyInstalled: boolean;
}

export interface SetupStatus {
  /** Kept at the top level for tolerant native clients on the shared snapshot. */
  publicBaseUrl: string;
  access: SetupAccess;
  /** Fast configured value; live ingress health loads independently. */
  ingress?: { publicBaseUrl: string };
  repos: SetupRepo[];
  engine: SetupEngine;
  team: { count: number; names: string[] };
  github: SetupGithub;
  integrations: SetupIntegration[];
}

export interface TeamMember {
  name: string;
  email?: string;
  github?: string;
  slackId?: string;
  aliases?: string[];
}

export interface BrowseRepo {
  fullName: string;
  private: boolean;
  description?: string | null;
  defaultBranch?: string;
  registered: boolean;
}

/** Same-origin JSON fetch against the setup API: prefixes BASE_PATH, encodes
 * an optional `json` body, and surfaces the backend's `{error}` message (or a
 * plain status line) as a thrown Error. */
export async function setupRequest<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${BASE_PATH}${path}`, {
    ...rest,
    ...(json !== undefined
      ? {
          headers: {
            "Content-Type": "application/json",
            ...(rest.headers as Record<string, string> | undefined),
          },
          body: JSON.stringify(json),
        }
      : {}),
  });
  let body: unknown = null;
  await (async () => {
    body = await res.json();
  })().catch(async () => {});
  const responseError =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : null;
  if (!res.ok)
    throw new Error(responseError || `Request failed (${res.status})`);
  return body as T;
}

export type ChipTone = "on" | "warn" | "off";

const CHIP_DOTS: Record<ChipTone, string> = {
  on: "var(--green)",
  warn: "var(--yellow)",
  off: "var(--text-faint)",
};

/** The chip's dot color on its own — the Setup wizard's step rail paints the
 *  same three states next to a step name rather than a chip label. */
export function chipDotColor(tone: ChipTone): string {
  return CHIP_DOTS[tone];
}

/** The Setup wizard's steps, in order. Lives here rather than in Setup.tsx so
 *  the checklist can offer a "jump to that step" without importing the wizard
 *  it is rendered by. */
export type SetupStepId =
  | "github"
  | "organization"
  | "models"
  | "repos"
  | "members"
  | "review";

export function integrationState(i: SetupIntegration): {
  tone: ChipTone;
  label: string;
} {
  if (i.enabled && i.missingRequired.length === 0)
    return { tone: "on", label: "On" };
  if (i.enabled)
    return { tone: "warn", label: "Enabled · missing credentials" };
  return { tone: "off", label: "Off" };
}

export function githubAuthState(g: SetupGithub): {
  tone: ChipTone;
  label: string;
} {
  if (!g.appCredentialConfigured)
    return { tone: "warn", label: "Missing App credential" };
  if (!g.appSlug) return { tone: "warn", label: "Missing App slug" };
  if (g.userPrAuth && !g.clientSecretConfigured)
    return { tone: "warn", label: "Missing client secret" };
  return { tone: "on", label: g.userPrAuth ? "GitHub" : "None" };
}

/** Does this repo carry what a session needs to provision and boot it on its
 *  own? `.agents/start.sh` (or an instance `previewCommand`) is the
 *  load-bearing half — without it the Preview button has nothing to run and an
 *  agent can't see its own UI change. `.agents/setup` alone still helps:
 *  worktrees provision, but nothing boots. Explained in
 *  docs/repo-lifecycle.md.
 *
 *  The chip label is the whole answer a row gives. A sentence under every
 *  repo restated the same mechanism once per row, so the footer says it once
 *  and the label carries the state. */
export function repoLifecycleState(repo: SetupRepo): {
  tone: ChipTone;
  label: string;
} {
  const { setup, start, previewCommand } = repo.lifecycle;
  if (start) return { tone: "on", label: setup ? "Ready" : "Boots previews" };
  if (previewCommand) return { tone: "on", label: "Instance preview" };
  if (setup) return { tone: "warn", label: "Setup only" };
  return { tone: "off", label: "No previews" };
}

export function StateChip({ tone, label }: { tone: ChipTone; label: string }) {
  return (
    <span
      {...stylex.props(
        sx.flex,
        sx.shrink0,
        sx.itemsCenter,
        sx.gap15,
        sx.whitespaceNowrap,
        sx.textDim,
        typography.label,
      )}
    >
      <span
        {...stylex.props(sx.h15, sx.w15, sx.roundedFull)}
        style={{ background: CHIP_DOTS[tone] }}
      />
      {label}
    </span>
  );
}

/** Inline monospace token — env var names, CLI commands, paths. Sits as a
 * well on the raised card surface so it reads as literal text to type. */
export function Code({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <code
      className={cn(
        utilityClassName(
          "whitespace-nowrap rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-fg",
        ),
        className,
      )}
    >
      {children}
    </code>
  );
}

/** Deep links into the third-party tool where a credential is created. */
export function LinkChips({
  links,
  className,
}: {
  links: SetupLink[];
  className?: string;
}) {
  if (!links.length) return null;
  return (
    <div
      className={cn(utilityClassName("mt-2 flex flex-wrap gap-1.5"), className)}
    >
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(
            sx.inlineFlex,
            sx.itemsCenter,
            sx.gap1,
            sx.roundedSm,
            sx.bgSurface,
            sx.px2,
            sx.py1,
            sx.textDim,
            sx.transitionColors,
            sx.hoverBgActive,
            sx.hoverTextFg,
            typography.label,
          )}
        >
          {link.label}
          <span aria-hidden {...stylex.props(sx.textFaint)}>
            ↗
          </span>
        </a>
      ))}
    </div>
  );
}

/** A provider walkthrough: numbered, one shape everywhere. Both setup dialogs
 *  had grown their own version of this list, at different sizes and gaps. */
export function SetupSteps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol
      {...stylex.props(
        sx.m0,
        sx.flex,
        sx.listNone,
        sx.flexCol,
        sx.gap25,
        sx.p0,
      )}
    >
      {steps.map((step, index) => (
        <li
          key={index}
          {...stylex.props(
            sx.flex,
            sx.itemsStart,
            sx.gap25,
            sx.leadingRelaxed,
            sx.textDim,
            typography.supporting,
          )}
        >
          <span
            {...mergeStylexProps(
              "tabular-nums",
              sx.mtPx,
              sx.flex,
              sx.size18px,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedFull,
              sx.bgSurface,
              sx.text10px,
              sx.fontSemibold,
              sx.textFaint,
            )}
          >
            {index + 1}
          </span>
          <span {...stylex.props(sx.minW0, sx.flex1)}>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/** A labelled block inside a setup guide — the steps, the scopes, the notes. */
export function GuideBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        {...stylex.props(
          sx.m0,
          sx.fontSemibold,
          sx.textFaint,
          typography.label,
        )}
      >
        {title}
      </h3>
      <div {...stylex.props(sx.mt2)}>{children}</div>
    </section>
  );
}

export interface SetupScopeGroup {
  label: string;
  items: string[];
}

/** One permission scope, as a token you can lift rather than one you have to
 *  pick out of a sentence. Copies itself and tints green for the beat after,
 *  which confirms without changing the chip's width. */
function ScopeChip({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => copy(value)}
      className={cn(
        utilityClassName(
          "focus-ring rounded-sm px-1.5 py-0.5 font-mono text-meta transition-colors",
        ),
        copied
          ? utilityClassName("bg-green-soft text-green")
          : utilityClassName("bg-surface text-fg hover:bg-active"),
      )}
    >
      {value}
    </button>
  );
}

/**
 * The scopes a provider needs, grouped by what they buy.
 *
 * These were prose: seventeen bold runs inside four sentences, which a person
 * then had to transcribe one at a time into Slack's own form. Scopes are data,
 * so they read as data — and the whole set is one button away.
 */
export function ScopeGroups({ groups }: { groups: SetupScopeGroup[] }) {
  const all = groups.flatMap((group) => group.items);
  const { copied, copy } = useCopy();
  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
      {groups.map((group) => (
        <div key={group.label}>
          <div {...stylex.props(sx.mb1, sx.textFaint, typography.meta)}>
            {group.label}
          </div>
          <div {...stylex.props(sx.flex, sx.flexWrap, sx.gap1)}>
            {group.items.map((item) => (
              <ScopeChip key={item} value={item} />
            ))}
          </div>
        </div>
      ))}
      <Button
        size="sm"
        className={mergeStylexOverrideClassName("", sx.selfStart)}
        onClick={() =>
          copy(all.join(", "), { toast: `Copied ${all.length} scopes` })
        }
      >
        <CopyCheck copied={copied} size={14} idle={<IconCopy size={14} />} />
        {copied ? "Copied" : `Copy all ${all.length}`}
      </Button>
    </div>
  );
}

/**
 * A credential you paste once and never read back.
 *
 * Label, then what the value is, then the well — so the mono names line up in
 * a column you can scan against the provider's own docs. The state lives on
 * the right of the label row and says one thing at a time: a value that is
 * saved is not also "required", which is what made the old row show a yellow
 * warning next to a green tick on a field that was perfectly fine.
 */
export function SecretField({
  name,
  label,
  description,
  placeholder,
  present,
  required,
  cleared,
  value,
  disabled,
  type = "password",
  onChange,
  onToggleClear,
}: {
  /** The field's accessible name. `label` is what it looks like — often the
   *  same string in a mono well, which no screen reader should have to read
   *  out of an element. */
  name: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Shown while the field is empty and nothing is stored — a format example
   *  ("Iv23li…") where the shape is the useful hint. */
  placeholder?: string;
  present: boolean;
  required?: boolean;
  cleared: boolean;
  value: string;
  disabled?: boolean;
  type?: "password" | "text";
  onChange: (value: string) => void;
  onToggleClear: () => void;
}) {
  return (
    <div {...stylex.props(sx.flex, sx.minW0, sx.flexCol, sx.gap1)}>
      <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
        <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
          {/* A plain name takes the app's field-label treatment; a `label`
					    node (an env var in a mono well) carries its own. */}
          {label ?? (
            <span
              {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}
            >
              {name}
            </span>
          )}
        </span>
        {cleared ? (
          <span
            {...stylex.props(
              sx.shrink0,
              sx.fontMedium,
              sx.textRed,
              typography.meta,
            )}
          >
            Clears on save
          </span>
        ) : present ? (
          <span {...stylex.props(sx.shrink0, sx.textGreen, typography.meta)}>
            Saved
          </span>
        ) : required ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
            Optional
          </span>
        )}
        {present && (
          <button
            type="button"
            {...mergeStylexProps(
              "focus-ring",
              sx.shrink0,
              sx.roundedSm,
              sx.fontMedium,
              sx.textFaint,
              sx.underline,
              sx.underlineOffset2,
              sx.transitionColors,
              sx.hoverTextFg,
              typography.meta,
            )}
            onClick={onToggleClear}
          >
            {cleared ? "Keep" : "Clear"}
          </button>
        )}
      </div>
      {description && (
        <div {...stylex.props(sx.textFaint, typography.supporting)}>
          {description}
        </div>
      )}
      <input
        type={type}
        // Mono for the value you paste, but not for the placeholder: every
        // placeholder here is a sentence, and a sentence set in mono reads
        // as a literal string to type rather than as a hint.
        className={fieldClasses("md", "mt-0.5 font-mono placeholder:font-sans")}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          cleared
            ? "Will be unset when you save"
            : present
              ? "Leave blank to keep"
              : (placeholder ?? "Not set")
        }
        aria-label={name}
        required={required}
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
      />
    </div>
  );
}

/** The callback URL and similar values you paste elsewhere: mono well + the
 * house copy affordance (inline check swap + toast). */
export function CopyableCode({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      {...stylex.props(
        sx.inlineFlex,
        sx.maxWFull,
        sx.itemsCenter,
        sx.gap15,
        sx.roundedControl,
        sx.bgSurface,
        sx.py05,
        sx.pl15,
        sx.pr1,
        sx.textLeft,
        sx.fontMono,
        sx.text092em,
        sx.textFg,
        sx.transitionColors,
        sx.hoverBgActive,
      )}
      onClick={() => copy(value, { toast: "Copied" })}
      title="Copy"
    >
      <span
        {...stylex.props(
          sx.minW0,
          sx.breakAll,
          sx.OverflowWrapAnywhere,
          sx.whitespaceNormal,
        )}
      >
        {value}
      </span>
      <CopyCheck
        copied={copied}
        size={14}
        className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
        idle={<IconCopy size={14} />}
      />
    </button>
  );
}
