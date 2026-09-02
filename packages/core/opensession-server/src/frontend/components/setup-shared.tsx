import { BASE_PATH } from "../lib/base";
import React from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { fieldClasses } from "../ui/input";
import { IconCopy } from "./icons";
import { z } from "zod";

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
const setupErrorSchema = z.object({ error: z.string() });

export async function setupRequest<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const request: RequestInit = { ...rest };
  if (json !== undefined) {
    const headers = new Headers({ "Content-Type": "application/json" });
    new Headers(rest.headers).forEach((value, key) => headers.set(key, value));
    request.headers = headers;
    request.body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE_PATH}${path}`, request);
  const body = await res.json().catch(() => null);
  const parsedError = setupErrorSchema.safeParse(body);
  if (!res.ok) {
    throw new Error(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : `Request failed (${res.status})`,
    );
  }
  return body;
}

export type ChipTone = "on" | "warn" | "off";

export interface ChipState {
  tone: ChipTone;
  label: string;
}

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

export function integrationState(i: SetupIntegration): ChipState {
  if (i.enabled && i.missingRequired.length === 0)
    return { tone: "on", label: "On" };
  if (i.enabled)
    return { tone: "warn", label: "Enabled · missing credentials" };
  return { tone: "off", label: "Off" };
}

export function githubAuthState(g: SetupGithub): ChipState {
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
export function repoLifecycleState(repo: SetupRepo): ChipState {
  const { setup, start, previewCommand } = repo.lifecycle;
  if (start) return { tone: "on", label: setup ? "Ready" : "Boots previews" };
  if (previewCommand) return { tone: "on", label: "Instance preview" };
  if (setup) return { tone: "warn", label: "Setup only" };
  return { tone: "off", label: "No previews" };
}

export function StateChip({ tone, label }: { tone: ChipTone; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-label text-dim">
      <span
        className="h-1.5 w-1.5 rounded-full"
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
        "whitespace-nowrap rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-fg",
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
    <div className={cn("mt-2 flex flex-wrap gap-1.5", className)}>
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-sm bg-surface px-2 py-1 text-label text-dim transition-colors hover:bg-active hover:text-fg"
        >
          {link.label}
          <span aria-hidden className="text-faint">
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
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
      {steps.map((step, index) => (
        <li
          key={index}
          className="flex items-start gap-2.5 text-supporting leading-relaxed text-dim"
        >
          <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-semibold tabular-nums text-faint">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">{step}</span>
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
      <h3 className="m-0 text-label font-semibold text-faint">{title}</h3>
      <div className="mt-2">{children}</div>
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
        "focus-ring rounded-sm px-1.5 py-0.5 font-mono text-meta transition-colors",
        copied
          ? "bg-green-soft text-green"
          : "bg-surface text-fg hover:bg-active",
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
    <div className="flex flex-col gap-2.5">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="mb-1 text-meta text-faint">{group.label}</div>
          <div className="flex flex-wrap gap-1">
            {group.items.map((item) => (
              <ScopeChip key={item} value={item} />
            ))}
          </div>
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
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
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {/* A plain name takes the app's field-label treatment; a `label`
					    node (an env var in a mono well) carries its own. */}
          {label ?? (
            <span className="text-label font-medium text-dim">{name}</span>
          )}
        </span>
        {cleared ? (
          <span className="shrink-0 text-meta font-medium text-red">
            Clears on save
          </span>
        ) : present ? (
          <span className="shrink-0 text-meta text-green">Saved</span>
        ) : required ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <span className="shrink-0 text-meta text-faint">Optional</span>
        )}
        {present && (
          <button
            type="button"
            className="focus-ring shrink-0 rounded-sm text-meta font-medium text-faint underline underline-offset-2 transition-colors hover:text-fg"
            onClick={onToggleClear}
          >
            {cleared ? "Keep" : "Clear"}
          </button>
        )}
      </div>
      {description && (
        <div className="text-supporting text-faint">{description}</div>
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
      className="inline-flex max-w-full items-center gap-1.5 rounded-control bg-surface py-0.5 pl-1.5 pr-1 text-left font-mono text-[0.92em] text-fg transition-colors hover:bg-active"
      onClick={() => copy(value, { toast: "Copied" })}
      title="Copy"
    >
      <span className="min-w-0 break-all [overflow-wrap:anywhere] whitespace-normal">
        {value}
      </span>
      <CopyCheck
        copied={copied}
        size={14}
        className="shrink-0 text-faint"
        idle={<IconCopy size={14} />}
      />
    </button>
  );
}
