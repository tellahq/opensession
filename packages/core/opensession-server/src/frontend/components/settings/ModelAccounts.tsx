import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePeople } from "../../lib/people";
import {
  AUTOMATIONS_ACCOUNT_OWNER,
  accountOwnerDescription,
  accountOwnerLabel,
  isAutomationsAccountOwner,
  providerAccountLabel,
} from "../../lib/provider-account";
import { request } from "../../lib/api/request";
import { useClaudeFederationSetupResource } from "../../hooks/useApiResources";
import { errorMessage } from "../../lib/error-message";
import { UserAvatar } from "../UserAvatar";
import {
  claudeLimits,
  liveLimits,
  type LimitWindow,
  type UsageWindow,
} from "../../lib/account-usage";
import { Field, Input } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { Button } from "../../ui/button";
import { DeviceCode } from "../../ui/device-code";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
  rowMenuTriggerClasses,
} from "../../ui/settings";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/toast";
import { BrandMark, IconTile } from "../BrandTile";
import {
  IconClock,
  IconDotsHorizontal,
  IconHistory,
  IconPencil,
  IconPeople,
  IconPlug,
  IconPlus,
  IconSliders,
  IconTrash,
} from "../icons";
import { ClaudeSignInForm } from "./ClaudeSignInForm";
import { RenameDialog } from "../RenameDialog";

// The Claude and Codex subscription accounts runs draw from, and how full each
// one is. Rendered by Settings → Models; the account list and its meters live
// together because the answer to "this one is spent" is an action on the row
// (hand it an owner, connect its usage, take it out of the pool).

interface ClaudeFederationInfo {
  organizationId: string;
  federationRuleId: string;
  serviceAccountId: string;
  workspaceId?: string;
}

function isClaudeApiAccount(account: ClaudeAccountInfo): boolean {
  return account.authKind === "api-key" || account.authKind === "federation";
}

interface ClaudeAccountInfo {
  id: string;
  name: string;
  label?: string;
  tokenMasked: string;
  /** "api-key" and "federation" bill an Anthropic API organization and serve
   *  only Mythos; older servers send only the first two. */
  authKind: "setup-token" | "oauth" | "api-key" | "federation";
  federation?: ClaudeFederationInfo;
  email?: string;
  plan?: string;
  /** Personal sub of this person; unset = shared pool account. */
  owner?: string;
  mode: "shared" | "personal" | "automations";
  /** Benched account-wide or for a model; older servers omit it. */
  sidelined?: boolean;
  usage: {
    fetchedAt: string;
    fiveHour: UsageWindow | null;
    sevenDay: UsageWindow | null;
    scopedLimits?: {
      label: string;
      utilization: number | null;
      resetsAt: string | null;
    }[];
    /** Pay-as-you-go spend past the subscription limits; credits are cents. */
    extraUsage?: {
      enabled: boolean;
      usedCredits: number;
      monthlyLimit: number;
    } | null;
    /** "meridian" = observed via a live Meridian proxy, not the OAuth endpoint. */
    source?: "meridian";
    error?: string;
    errorStatus?: number;
  } | null;
  noUsageScope: boolean;
  credentialsPath?: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

interface CodexAccountInfo {
  id: string;
  name: string;
  label?: string;
  email?: string;
  kind: "api_key" | "home";
  valueMasked: string;
  owner?: string;
  mode: "shared" | "personal";
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
  usage: {
    fetchedAt: string;
    buckets: CodexUsageBucket[];
    resetCreditsAvailable: number | null;
    error?: string;
  } | null;
}

interface CodexUsageBucket {
  id: string;
  label?: string;
  plan?: string;
  primary: (UsageWindow & { windowDurationMins: number | null }) | null;
  secondary: (UsageWindow & { windowDurationMins: number | null }) | null;
  /** Prepaid credits, present only when the account has some. */
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null };
  /** The spend cap the ChatGPT workspace set on this member. Amounts are the
   *  provider's own formatted strings. */
  spendLimit?: {
    limit: string;
    used: string;
    remainingPercent: number | null;
    resetsAt: string | null;
  };
  rateLimitReachedType?: string;
}

interface XaiAccountInfo {
  id: string;
  name: string;
  label?: string;
  email?: string;
  kind: "oauth";
  owner?: string;
  mode: "shared" | "personal";
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
  refreshError?: string;
  reloginRequired: boolean;
  usage: {
    fetchedAt: string;
    subscriptionTier?: string;
    creditUsagePercent?: number;
    usedCents?: number;
    monthlyLimitCents?: number;
    onDemandEnabled?: boolean;
    onDemandUsedCents?: number;
    onDemandCapCents?: number;
    periodType?: string;
    periodEnd?: string;
    productUsage?: { product: string; usagePercent: number }[];
    error?: string;
  } | null;
}

// ── Shared bits ────────────────────────────────────────────────────────────

function abortPendingOAuth(pending: {
  current: { id?: string; done: boolean };
}) {
  const { id, done } = pending.current;
  if (!done && id) {
    void request(`/claude-accounts/oauth-login/${encodeURIComponent(id)}`, {
      method: "DELETE",
      label: "Could not cancel Claude sign-in",
    }).catch(() => undefined);
  }
}

/** Choose the shared pool, the Automations group or one person's
 *  subscription. */
function OwnerSelect({
  value,
  onChange,
  label,
  title,
  disabled,
  quiet = false,
  className,
}: {
  value: string;
  onChange: (owner: string) => void;
  label: string;
  title?: string;
  disabled?: boolean;
  /** Remove field chrome when the selected owner sits inside a row. */
  quiet?: boolean;
  className?: string;
}) {
  // The roster reactively, so the list and the pictures both fill in when
  // GET /api/people lands rather than only on the next render.
  const people = usePeople();
  const roster = people.map((p) => p.name);
  // A personal Claude API account stores its owner's GitHub login: show the
  // person it names.
  const lower = value.toLowerCase();
  const shown =
    (value && people.find((p) => p.github?.toLowerCase() === lower)?.name) ||
    value;
  // Keep a non-team owner (e.g. set via the API) selectable.
  const owners =
    shown && !isAutomationsAccountOwner(shown) && !roster.includes(shown)
      ? [shown, ...roster]
      : roster;
  const items = [
    { value: "", label: "Shared pool" },
    { value: AUTOMATIONS_ACCOUNT_OWNER, label: "Automations" },
    ...owners.map((name) => ({ value: name, label: name })),
  ];
  // The person's own picture, the way every other people picker in the app
  // draws them. The pool is everyone, so it takes the group glyph, and the
  // Automations group the glyph Automations has everywhere else.
  const ownerIcon = (owner: string) =>
    !owner ? (
      <IconPeople size={20} />
    ) : isAutomationsAccountOwner(owner) ? (
      <IconClock size={20} />
    ) : (
      <UserAvatar name={owner} size={16} />
    );
  return (
    <Select.Root
      items={items}
      value={shown}
      disabled={disabled}
      onValueChange={(next) => onChange(String(next))}
    >
      <Select.Trigger
        aria-label={label}
        title={title}
        icon={ownerIcon(shown)}
        sizeTo={quiet ? undefined : items.map((i) => i.label)}
        children={
          quiet ? (
            <span className="flex h-4 items-center leading-none">
              {accountOwnerLabel(shown) ?? "Shared pool"}
            </span>
          ) : undefined
        }
        className={cn(
          quiet &&
            "w-auto border-transparent bg-transparent px-2 text-dim shadow-none transition-colors hover:border-transparent hover:bg-hover enabled:hover:shadow-none focus:border-transparent data-[popup-open]:border-transparent data-[popup-open]:bg-hover phone:min-h-11 [&>svg]:size-4",
          className,
        )}
      />
      <Select.Popup align="end">
        {items.map((i) => (
          <Select.Item key={i.value} value={i.value} icon={ownerIcon(i.value)}>
            {i.label}
          </Select.Item>
        ))}
      </Select.Popup>
    </Select.Root>
  );
}

/** A provider mark keeps mixed account rows scannable without repeating a
 * column of colored tiles beside provider names that are already written out. */
function AccountProviderMark({ name }: { name: "claude" | "codex" | "xai" }) {
  return (
    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-faint">
      <BrandMark name={name} size={18} />
    </span>
  );
}

/**
 * A meter's fill. Normal usage is neutral ink, not green: an account that is
 * fine already says so in its "In rotation" pill, and three green bars per
 * account across nine accounts turned the whole page into colour with nothing
 * to look at. Colour here means "this one is running out" — so the two
 * accounts near a limit are the only things that catch the eye.
 */
const usageToneClasses = {
  unknown: "bg-line",
  high: "bg-red",
  warn: "bg-yellow",
  normal: "bg-faint",
} as const;

/** Utilization → tone. Shared so a meter and its neighbours can't drift. */
function usageTone(pct: number | null): keyof typeof usageToneClasses {
  return pct === null
    ? "unknown"
    : pct >= 90
      ? "high"
      : pct >= 70
        ? "warn"
        : "normal";
}

const statusToneClasses = {
  red: { dot: "bg-red", text: "text-red" },
  yellow: { dot: "bg-yellow", text: "text-yellow" },
  muted: {
    dot: null,
    text: "rounded-full bg-yellow-soft px-2 py-[2px] text-yellow",
  },
} as const;

function AccountStatus({
  tone,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"span"> & {
  tone: keyof typeof statusToneClasses;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-meta font-medium",
        statusToneClasses[tone].text,
      )}
      {...props}
    >
      {statusToneClasses[tone].dot && (
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", statusToneClasses[tone].dot)}
        />
      )}
      {children}
    </span>
  );
}

/**
 * "resets in 3h". An account reports three or four windows, so the absolute
 * timestamp this used to print ("resets Sat, Aug 1, 05:00 PM") was repeated
 * down the whole page — the single noisiest thing on it, for the least useful
 * reading. What a person wants from a limit is how long until it frees up; the
 * exact time stays one hover away.
 */
function formatReset(resetsAt: string | null): string {
  const d = resetsAt ? new Date(resetsAt) : null;
  if (!d || isNaN(d.getTime())) return "";
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "resets now";
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

function absoluteReset(resetsAt: string | null): string | undefined {
  const d = resetsAt ? new Date(resetsAt) : null;
  if (!d || isNaN(d.getTime())) return undefined;
  return `Resets ${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/** A provider-formatted amount as dollars when it is a bare number ("37.50"),
 *  otherwise as given: the wire does not say which currency or format it is.
 *  Whole dollars drop the cents ("$50") so a cap fits beside its reset time in
 *  the meter's one-line note. */
function providerAmount(amount: string): string {
  const n = Number(amount);
  if (!amount.trim() || !Number.isFinite(n)) return amount;
  const cents = Number.isInteger(n) ? 0 : 2;
  return `$${n.toLocaleString([], { minimumFractionDigits: cents, maximumFractionDigits: 2 })}`;
}

/**
 * Usage windows sit beside each other so three limits add one compact strip
 * instead of three lines to every account. Each window owns its alignment,
 * which also lets Codex wrap a fourth window without changing its neighbours.
 * Phones keep one window per line because the same strip would be unreadable
 * at that width.
 */
function MeterGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 grid max-w-[420px] grid-cols-3 gap-3 text-meta phone:grid-cols-1 phone:gap-1.5">
      {children}
    </div>
  );
}

/** One compact limit: label and value, track, then its reset time. */
function Meter({
  label,
  labelTitle,
  pct,
  value,
  note,
  noteTitle,
}: {
  label: string;
  labelTitle?: string;
  /** 0-100, or null when the value is unknown. The track renders empty. */
  pct: number | null;
  value: React.ReactNode;
  note?: React.ReactNode;
  noteTitle?: string;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 phone:grid-cols-[minmax(0,1fr)_72px_minmax(38px,auto)] phone:gap-x-2 phone:gap-y-0">
      {/* `contents` gives the desktop label and reset time separate rows.
			    On phones they become one cell beside the track and value. */}
      <span className="min-w-0 phone:overflow-visible phone:whitespace-normal desktop:contents">
        <span
          className="overflow-hidden text-ellipsis whitespace-nowrap text-dim desktop:col-start-1 desktop:row-start-1"
          title={labelTitle}
        >
          {label}
        </span>
        {note ? (
          <span
            className="overflow-hidden text-ellipsis whitespace-nowrap text-faint desktop:col-span-2 desktop:row-start-3"
            title={noteTitle}
          >
            <span className="phone:inline desktop:hidden"> · </span>
            {note}
          </span>
        ) : null}
      </span>
      <div className="h-1 overflow-hidden rounded-full bg-active desktop:col-span-2 desktop:row-start-2 phone:col-start-2 phone:row-start-1">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-long",
            usageToneClasses[usageTone(pct)],
          )}
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </div>
      <span className="text-right tabular-nums text-dim desktop:col-start-2 desktop:row-start-1 phone:col-start-3 phone:row-start-1">
        {value}
      </span>
    </div>
  );
}

/**
 * Every limit an account is running against, one compact item each: the 5-hour
 * window, the 7-day window, and any per-model weekly cap. They free up at
 * different times, so which one is full changes what you do about it. A spent
 * 5h clears this afternoon, while a spent Fable cap holds that model for days.
 * Showing only the fullest of them put the rest a hover away, which is no place
 * for a fact someone came to this page to read. Quiet ink keeps a page of
 * accounts calm; colour still means one thing, that this limit is running out.
 */
function UsageMeters({ windows }: { windows: LimitWindow[] }) {
  return (
    <>
      {liveLimits(windows).map((w, i) => (
        <Meter
          key={`${w.label}-${i}`}
          label={w.label}
          pct={w.utilization}
          value={`${Math.round(w.utilization)}%`}
          note={formatReset(w.resetsAt)}
          noteTitle={absoluteReset(w.resetsAt)}
        />
      ))}
    </>
  );
}

/**
 * Usage-credits (extra usage) spend for one account: what's been billed past
 * the subscription's included limits this month, against the account's monthly
 * credit cap. Values from the OAuth usage endpoint are cents. Hidden until
 * something has actually been spent: an account with extra usage merely
 * switched on drew a "$0.00" bar every month, which is a cap, not a cost.
 */
function ExtraUsageRow({
  extra,
}: {
  extra:
    | { enabled: boolean; usedCredits: number; monthlyLimit: number }
    | null
    | undefined;
}) {
  if (!extra || extra.usedCredits <= 0) return null;
  const usd = (cents: number) =>
    `$${(cents / 100).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct =
    extra.monthlyLimit > 0
      ? (extra.usedCredits / extra.monthlyLimit) * 100
      : null;
  return (
    <Meter
      label="Credits"
      labelTitle="Usage-credits: pay-as-you-go spend past the subscription limits, against this account's monthly credit cap (set at claude.ai)"
      pct={pct}
      value={usd(extra.usedCredits)}
      note={`${extra.monthlyLimit > 0 ? `${usd(extra.monthlyLimit)}/mo cap` : "no monthly cap"}${
        extra.enabled ? "" : " · off"
      }`}
    />
  );
}

// ── Claude accounts ────────────────────────────────────────────────────────

/**
 * The one thing that needs attention, never stacked, so nothing collides. A
 * healthy account gets no status: its meters already say it is fine, and nine
 * green "In rotation" labels down a page hid the two accounts that weren't.
 */
function ClaudeAccountStatus({ a }: { a: ClaudeAccountInfo }) {
  if (a.usage?.error && a.usage.errorStatus === 401)
    return (
      <AccountStatus tone="red" title={a.usage.error}>
        Token error
      </AccountStatus>
    );
  if (a.usage?.error)
    return (
      <AccountStatus tone="yellow" title={a.usage.error}>
        Usage unknown
      </AccountStatus>
    );
  if (a.noUsageScope && !a.usage)
    return (
      <AccountStatus
        tone="muted"
        title="Add OAuth usage credentials to show dashboard usage."
      >
        Usage hidden
      </AccountStatus>
    );
  if (a.exhaustedUntil)
    return (
      <AccountStatus tone="red" title={`Sidelined until ${a.exhaustedUntil}`}>
        Limit hit
      </AccountStatus>
    );
  if (a.usable) return null;
  return <AccountStatus tone="yellow">Near limit</AccountStatus>;
}

/** A renamed account's row title no longer shows its email, so the
 * description line keeps it. */
function renamedEmail(account: { label?: string; email?: string }): string {
  return account.label?.trim() && account.email ? ` · ${account.email}` : "";
}

/** The Rename… action every account row shares. A blank name clears it, so
 * the row shows the account's email again. */
function useAccountRename(
  poolPath: "/claude-accounts" | "/codex-accounts" | "/xai-accounts",
  provider: string,
  load: () => Promise<void>,
  setError: (message: string) => void,
) {
  const [target, setTarget] = useState<{
    id: string;
    name: string;
    label?: string;
    email?: string;
  } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  function start(account: NonNullable<typeof target>) {
    setTarget(account);
    setDraft(account.label ?? "");
  }

  function cancel() {
    setDraft(null);
  }

  async function commit() {
    if (!target || draft === null) return;
    const label = draft.trim();
    setDraft(null);
    if (label === (target.label ?? "")) return;
    try {
      await request(`${poolPath}/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        body: { label },
        label: `Could not rename ${provider} account`,
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, `Could not rename ${provider} account`));
    }
  }

  return {
    start,
    dialog: (
      <RenameDialog
        title="Rename account"
        draft={draft}
        placeholder={target?.email || target?.name}
        allowEmpty
        onDraftChange={setDraft}
        onCommit={() => void commit()}
        onCancel={cancel}
      />
    ),
  };
}

function useClaudeAccounts() {
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
  const [signIn, setSignIn] = useState<ClaudeAccountInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceUsage = false) => {
    if (forceUsage) setRefreshing(true);
    try {
      const { accounts } = await request<{ accounts: ClaudeAccountInfo[] }>(
        forceUsage ? "/claude-accounts/refresh" : "/claude-accounts",
        {
          method: forceUsage ? "POST" : "GET",
          label: "Could not load Anthropic accounts",
        },
      );
      setAccounts(accounts);
    } catch (cause) {
      setError(errorMessage(cause, "Could not load Anthropic accounts"));
      setAccounts((current) => current ?? []);
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function remove(account: ClaudeAccountInfo) {
    if (
      !confirm(
        `Remove Claude account "${providerAccountLabel(account)}"? Runs will stop using this account.`,
      )
    ) {
      return;
    }
    try {
      await request(`/claude-accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        label: "Could not remove Anthropic account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not remove Anthropic account"));
    }
  }

  async function setOwner(account: ClaudeAccountInfo, owner: string) {
    if (owner === (account.owner || "")) return;
    try {
      await request(`/claude-accounts/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        body: { owner },
        label: "Could not update Anthropic account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not update Anthropic account"));
    }
  }

  async function returnToPool(account: ClaudeAccountInfo) {
    try {
      await request(
        `/claude-accounts/${encodeURIComponent(account.id)}/return-to-pool`,
        { method: "POST", label: "Could not return the account to the pool" },
      );
      toast(`${providerAccountLabel(account)} is back in rotation`);
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not return the account to the pool"));
    }
  }

  async function setCredentialsPath(account: ClaudeAccountInfo) {
    const current =
      account.credentialsPath ||
      `~/.claude/accounts/${account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/credentials.json`;
    const credentialsPath = prompt(
      "Path to this account's Claude OAuth credentials.json for usage polling. Leave empty to clear it.",
      current,
    );
    if (credentialsPath === null) return;
    try {
      await request(`/claude-accounts/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        body: { owner: account.owner || "", credentialsPath },
        label: "Could not update Anthropic usage credentials",
      });
      void load(true);
    } catch (cause) {
      setError(
        errorMessage(cause, "Could not update Anthropic usage credentials"),
      );
    }
  }

  return {
    accounts,
    error,
    load,
    refreshing,
    remove,
    returnToPool,
    setCredentialsPath,
    setError,
    rename: useAccountRename("/claude-accounts", "Anthropic", load, setError),
    setOwner,
    setSignIn,
    signIn,
  };
}

type ClaudeAccountsState = ReturnType<typeof useClaudeAccounts>;

function ClaudeAccountRows({ state }: { state: ClaudeAccountsState }) {
  return (
    <>
      {state.rename.dialog}
      {[...(state.accounts || [])]
        .sort(
          (left, right) =>
            providerAccountLabel(left).localeCompare(
              providerAccountLabel(right),
            ) || left.id.localeCompare(right.id),
        )
        .map((account) => (
          <React.Fragment key={account.id}>
            <SettingRow className="items-start gap-x-3 phone:px-4">
              <AccountProviderMark name="claude" />
              <SettingRowText>
                <div className="flex min-w-0 items-center gap-2">
                  <SettingRowTitle className="truncate">
                    {providerAccountLabel(account)}
                  </SettingRowTitle>
                  <ClaudeAccountStatus a={account} />
                </div>
                <SettingRowDescription
                  className="truncate text-meta"
                  title={[
                    "Anthropic",
                    account.plan?.replace("default_claude_", ""),
                    account.tokenMasked,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  Anthropic
                  {account.authKind === "federation"
                    ? " · API · workload identity"
                    : account.authKind === "api-key"
                      ? " · API key"
                      : ""}
                  {renamedEmail(account)}
                  {account.plan
                    ? ` · ${account.plan.replace("default_claude_", "")}`
                    : ""}
                </SettingRowDescription>
                {isClaudeApiAccount(account) ? (
                  <div className="mt-1.5 text-meta leading-relaxed text-faint">
                    Serves Mythos runs, billed to the API organization.
                  </div>
                ) : account.noUsageScope && !account.usage ? (
                  <div className="mt-1.5 text-meta leading-relaxed text-faint">
                    Sign in with Claude from the account menu to show usage.
                  </div>
                ) : (
                  <>
                    <MeterGroup>
                      <UsageMeters windows={claudeLimits(account.usage)} />
                      <ExtraUsageRow extra={account.usage?.extraUsage} />
                    </MeterGroup>
                    {account.usage?.source === "meridian" && (
                      <div className="mt-1.5 text-meta text-faint">
                        Observed through Meridian from rate-limit events during
                        live runs. The token cannot read the usage endpoint
                        directly.
                      </div>
                    )}
                    {account.usage?.error && (
                      <div className="mt-1.5 text-meta text-red">
                        {account.usage.error}
                      </div>
                    )}
                  </>
                )}
              </SettingRowText>
              <SettingRowControl className="flex items-center gap-1.5 phone:mt-1 phone:ml-0 phone:w-full phone:basis-full phone:gap-2.5 phone:pl-10">
                <span className="hidden shrink-0 text-meta text-faint phone:inline">
                  Used by
                </span>
                <OwnerSelect
                  value={account.owner || ""}
                  onChange={(owner) => state.setOwner(account, owner)}
                  label={`Owner of ${providerAccountLabel(account)}`}
                  quiet
                  className="phone:ml-auto"
                  title={accountOwnerDescription(account.owner)}
                />
                <Menu.Root>
                  <Menu.Trigger
                    className={rowMenuTriggerClasses}
                    aria-label={`Manage ${providerAccountLabel(account)}`}
                  >
                    <IconDotsHorizontal size={20} />
                  </Menu.Trigger>
                  <Menu.Popup align="end" sideOffset={4}>
                    {(account.sidelined || account.exhaustedUntil) && (
                      <Menu.Item
                        onClick={() => state.returnToPool(account)}
                        title="Use this after resetting its limit at Anthropic. A real limit benches it again on the next refused request."
                      >
                        <IconHistory size={20} className="text-faint" />
                        Return to pool
                      </Menu.Item>
                    )}
                    {!isClaudeApiAccount(account) && (
                      <Menu.Item onClick={() => state.setSignIn(account)}>
                        <IconPlug size={20} className="text-faint" />
                        Connect usage…
                      </Menu.Item>
                    )}
                    {account.authKind === "setup-token" && (
                      <Menu.Item
                        onClick={() => state.setCredentialsPath(account)}
                      >
                        <IconSliders size={20} className="text-faint" />
                        Usage credentials…
                      </Menu.Item>
                    )}
                    <Menu.Item onClick={() => state.rename.start(account)}>
                      <IconPencil size={20} className="text-faint" />
                      Rename…
                    </Menu.Item>
                    <Menu.Item
                      onClick={() => state.remove(account)}
                      tone="danger"
                    >
                      <IconTrash size={20} />
                      Remove account
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Root>
              </SettingRowControl>
            </SettingRow>
            {state.signIn?.id === account.id && (
              <ClaudeSignInForm
                account={account}
                onClose={() => state.setSignIn(null)}
                onDone={() => {
                  state.setSignIn(null);
                  void state.load();
                }}
              />
            )}
          </React.Fragment>
        ))}
    </>
  );
}

/** Provider-specific summary used by onboarding. The full settings page uses
 * ProviderAccountsSection so every account shares one list and one toolbar. */
export function ClaudeAccountsSection({
  onChanged,
}: {
  compact?: boolean;
  onChanged?: () => void | Promise<void>;
} = {}) {
  const state = useClaudeAccounts();
  const [showAdd, setShowAdd] = useState(false);
  const available =
    state.accounts?.filter(
      (account) => account.usable && !account.exhaustedUntil,
    ).length ?? 0;
  return (
    <>
      <SettingsGroupLabel
        actions={
          <Button
            size="sm"
            icon={<IconPlus size={20} />}
            onClick={() => setShowAdd(true)}
          >
            Add account
          </Button>
        }
      >
        Claude
      </SettingsGroupLabel>
      <Modal.Root open={showAdd} onOpenChange={setShowAdd}>
        <Modal.Content widthClassName="max-w-[32rem]">
          <AddClaudeAccountForm
            onAccountAdded={() => {
              void state.load();
              void onChanged?.();
            }}
            onDone={() => setShowAdd(false)}
          />
        </Modal.Content>
      </Modal.Root>
      <SettingCard>
        {!state.accounts ? (
          <LoadingState placement="row">Checking Claude…</LoadingState>
        ) : (
          <SettingRow>
            <IconTile name="claude" size={28} />
            <SettingRowText>
              <SettingRowTitle>Claude</SettingRowTitle>
              <SettingRowDescription>
                {state.accounts.length === 0
                  ? "Add a Claude account before choosing an Anthropic model."
                  : `${available} available of ${state.accounts.length} connected`}
              </SettingRowDescription>
            </SettingRowText>
            <span className="shrink-0 text-label text-dim">
              {available > 0
                ? "Ready"
                : state.accounts.length > 0
                  ? "Unavailable"
                  : "Not connected"}
            </span>
          </SettingRow>
        )}
      </SettingCard>
    </>
  );
}

// ── Codex accounts ─────────────────────────────────────────────────────────

function CodexAccountStatus({ account }: { account: CodexAccountInfo }) {
  if (account.exhaustedUntil)
    return (
      <AccountStatus
        tone="red"
        title={`Sidelined until ${account.exhaustedUntil}`}
      >
        Limit hit
      </AccountStatus>
    );
  if (account.usage?.error)
    return (
      <AccountStatus tone="yellow" title={account.usage.error}>
        Usage unknown
      </AccountStatus>
    );
  return null;
}

function CodexUsageMeters({ account }: { account: CodexAccountInfo }) {
  if (account.kind === "api_key")
    return (
      <div className="mt-1.5 text-meta text-faint">
        Platform usage is billed at the organization level, not per API key.
      </div>
    );
  if (!account.usage)
    return <div className="mt-1.5 text-meta text-faint">Checking usage…</div>;
  if (account.usage.error)
    return (
      <div className="mt-1.5 text-meta text-red">{account.usage.error}</div>
    );

  const bucketName = (bucket: CodexUsageBucket) =>
    bucket.label || (bucket.id === "codex" ? "Codex" : bucket.id);
  const windowLabel = (minutes: number | null) => {
    if (!minutes) return "Usage";
    if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  };
  // A bucket the account names is a per-model budget (GPT-5.3-Codex-Spark)
  // rather than the plan's own window, so it is listed after the plan's and
  // carries the model's name.
  const multipleBuckets = account.usage.buckets.length > 1;
  const windows: LimitWindow[] = account.usage.buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].flatMap((window) => {
      if (!window) return [];
      const duration = windowLabel(window.windowDurationMins);
      return [
        {
          label: multipleBuckets
            ? `${bucketName(bucket)} ${duration}`
            : duration,
          utilization: window.utilization,
          resetsAt: window.resetsAt,
          scoped: !!bucket.label,
        },
      ];
    }),
  );
  // A workspace spend cap stops runs just like a full window does, so it sits
  // in the same strip, after the windows. Used against the cap, not remaining.
  const spendCaps = account.usage.buckets.flatMap((bucket) =>
    bucket.spendLimit ? [{ bucket, cap: bucket.spendLimit }] : [],
  );
  // Balances are facts, not limits: one quiet line under the meters.
  const balances = account.usage.buckets.flatMap((bucket) => {
    const credits = bucket.credits;
    if (!credits) return [];
    const amount = credits.unlimited
      ? "Unlimited credits"
      : credits.balance
        ? `${providerAmount(credits.balance)} credits`
        : "Credits available";
    return [multipleBuckets ? `${bucketName(bucket)}: ${amount}` : amount];
  });
  if (
    account.usage.resetCreditsAvailable !== null &&
    account.usage.resetCreditsAvailable > 0
  ) {
    balances.push(
      `${account.usage.resetCreditsAvailable} rate-limit reset${
        account.usage.resetCreditsAvailable === 1 ? "" : "s"
      } available`,
    );
  }
  return (
    <>
      {(windows.length > 0 || spendCaps.length > 0) && (
        <MeterGroup>
          <UsageMeters windows={windows} />
          {spendCaps.map(({ bucket, cap }) => (
            <Meter
              key={`${bucket.id}-spend`}
              label={
                multipleBuckets
                  ? `${bucketName(bucket)} spend cap`
                  : "Spend cap"
              }
              labelTitle="Spend cap: what this account has spent this period against the cap its ChatGPT workspace set for it"
              pct={
                cap.remainingPercent === null
                  ? null
                  : 100 - cap.remainingPercent
              }
              value={providerAmount(cap.used)}
              note={[
                `${providerAmount(cap.limit)} cap`,
                formatReset(cap.resetsAt),
              ]
                .filter(Boolean)
                .join(" · ")}
              noteTitle={[
                `${providerAmount(cap.used)} of ${providerAmount(cap.limit)} spent`,
                absoluteReset(cap.resetsAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </MeterGroup>
      )}
      {balances.length > 0 && (
        <div className="mt-1.5 text-meta text-faint">
          {balances.join(" · ")}
        </div>
      )}
    </>
  );
}

function useCodexAccounts() {
  const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceUsage = false) => {
    if (forceUsage) setRefreshing(true);
    try {
      const { accounts } = await request<{ accounts: CodexAccountInfo[] }>(
        forceUsage ? "/codex-accounts/refresh" : "/codex-accounts",
        {
          method: forceUsage ? "POST" : "GET",
          label: "Could not load OpenAI accounts",
        },
      );
      setAccounts(accounts);
    } catch (cause) {
      setError(errorMessage(cause, "Could not load OpenAI accounts"));
      setAccounts((current) => current ?? []);
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function setOwner(account: CodexAccountInfo, owner: string) {
    if (owner === (account.owner || "")) return;
    try {
      await request(`/codex-accounts/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        body: { owner },
        label: "Could not update OpenAI account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not update OpenAI account"));
    }
  }

  async function remove(account: CodexAccountInfo) {
    if (
      !confirm(
        `Remove Codex account "${providerAccountLabel(account)}"? Runs will stop using it.`,
      )
    ) {
      return;
    }
    try {
      await request(`/codex-accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        label: "Could not remove OpenAI account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not remove OpenAI account"));
    }
  }

  const rename = useAccountRename("/codex-accounts", "OpenAI", load, setError);
  return {
    accounts,
    error,
    load,
    refreshing,
    remove,
    rename,
    setError,
    setOwner,
  };
}

type CodexAccountsState = ReturnType<typeof useCodexAccounts>;

function CodexAccountRows({ state }: { state: CodexAccountsState }) {
  return (
    <>
      {state.rename.dialog}
      {[...(state.accounts || [])]
        .sort(
          (left, right) =>
            providerAccountLabel(left).localeCompare(
              providerAccountLabel(right),
            ) || left.id.localeCompare(right.id),
        )
        .map((account) => (
          <SettingRow
            key={account.id}
            className="items-start gap-x-3 phone:px-4"
          >
            <AccountProviderMark name="codex" />
            <SettingRowText>
              <div className="flex min-w-0 items-center gap-2">
                <SettingRowTitle className="truncate">
                  {providerAccountLabel(account)}
                </SettingRowTitle>
                <CodexAccountStatus account={account} />
              </div>
              <SettingRowDescription
                className="truncate text-meta"
                title={account.valueMasked}
              >
                OpenAI ·{" "}
                {account.kind === "api_key" ? "API key" : "ChatGPT login"}
                {renamedEmail(account)}
                {account.usage?.buckets.find((bucket) => bucket.plan)?.plan
                  ? ` · ${account.usage.buckets.find((bucket) => bucket.plan)!.plan}`
                  : ""}
                {account.kind === "api_key" ? ` · ${account.valueMasked}` : ""}
              </SettingRowDescription>
              <CodexUsageMeters account={account} />
            </SettingRowText>
            <SettingRowControl className="flex items-center gap-1.5 phone:mt-1 phone:ml-0 phone:w-full phone:basis-full phone:gap-2.5 phone:pl-10">
              <span className="hidden shrink-0 text-meta text-faint phone:inline">
                Used by
              </span>
              <OwnerSelect
                value={account.owner || ""}
                onChange={(owner) => state.setOwner(account, owner)}
                label={`Owner of ${providerAccountLabel(account)}`}
                quiet
                className="phone:ml-auto"
                title={accountOwnerDescription(account.owner)}
              />
              <Menu.Root>
                <Menu.Trigger
                  className={rowMenuTriggerClasses}
                  aria-label={`Manage ${providerAccountLabel(account)}`}
                >
                  <IconDotsHorizontal size={20} />
                </Menu.Trigger>
                <Menu.Popup align="end" sideOffset={4}>
                  <Menu.Item onClick={() => state.rename.start(account)}>
                    <IconPencil size={20} className="text-faint" />
                    Rename…
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => state.remove(account)}
                    tone="danger"
                  >
                    <IconTrash size={20} />
                    Remove account
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Root>
            </SettingRowControl>
          </SettingRow>
        ))}
    </>
  );
}

/** Provider-specific summary used by onboarding. */
export function CodexAccountsSection({
  onChanged,
}: {
  compact?: boolean;
  onChanged?: () => void | Promise<void>;
} = {}) {
  const state = useCodexAccounts();
  const [showAdd, setShowAdd] = useState(false);
  const available =
    state.accounts?.filter(
      (account) => account.usable && !account.exhaustedUntil,
    ).length ?? 0;
  return (
    <>
      <SettingsGroupLabel
        actions={
          <Button
            size="sm"
            icon={<IconPlus size={20} />}
            onClick={() => setShowAdd(true)}
          >
            Add account
          </Button>
        }
      >
        OpenAI Codex
      </SettingsGroupLabel>
      <Modal.Root open={showAdd} onOpenChange={setShowAdd}>
        <Modal.Content>
          <AddCodexAccountForm
            onAdded={() => {
              setShowAdd(false);
              void state.load();
              void onChanged?.();
            }}
          />
        </Modal.Content>
      </Modal.Root>
      <SettingCard>
        {!state.accounts ? (
          <LoadingState placement="row">Checking Codex…</LoadingState>
        ) : (
          <SettingRow>
            <IconTile name="codex" size={28} />
            <SettingRowText>
              <SettingRowTitle>OpenAI Codex</SettingRowTitle>
              <SettingRowDescription>
                {state.accounts.length === 0
                  ? "Add a ChatGPT login or API key before choosing an OpenAI model."
                  : `${available} available of ${state.accounts.length} connected`}
              </SettingRowDescription>
            </SettingRowText>
            <span className="shrink-0 text-label text-dim">
              {available > 0
                ? "Ready"
                : state.accounts.length > 0
                  ? "Unavailable"
                  : "Not connected"}
            </span>
          </SettingRow>
        )}
      </SettingCard>
    </>
  );
}

// ── xAI (SuperGrok) accounts ──────────────────────────────────────────────────

function XaiAccountStatus({ account }: { account: XaiAccountInfo }) {
  if (account.reloginRequired)
    return (
      <AccountStatus tone="red" title={account.refreshError}>
        Sign in again
      </AccountStatus>
    );
  if (account.exhaustedUntil)
    return (
      <AccountStatus
        tone="red"
        title={`Sidelined until ${account.exhaustedUntil}`}
      >
        Limit hit
      </AccountStatus>
    );
  if ((account.usage?.creditUsagePercent ?? 0) >= 100)
    return <AccountStatus tone="red">Credits spent</AccountStatus>;
  if (account.usage?.error)
    return (
      <AccountStatus tone="yellow" title={account.usage.error}>
        Usage unknown
      </AccountStatus>
    );
  return null;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** SuperGrok reports one credit budget per billing period, plus per-product
 * shares and an optional on-demand pool once the included credits are gone. */
function XaiUsageMeters({ account }: { account: XaiAccountInfo }) {
  const usage = account.usage;
  if (!usage)
    return <div className="mt-1.5 text-meta text-faint">Checking usage…</div>;
  if (usage.error)
    return <div className="mt-1.5 text-meta text-red">{usage.error}</div>;
  const period = usage.periodType
    ? usage.periodType.replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase()
    : "";
  const included =
    usage.creditUsagePercent !== undefined ? usage.creditUsagePercent : null;
  const onDemandPct =
    usage.onDemandCapCents && usage.onDemandUsedCents !== undefined
      ? Math.min(100, (usage.onDemandUsedCents / usage.onDemandCapCents) * 100)
      : null;
  return (
    <MeterGroup>
      <Meter
        label={
          period
            ? `${period[0].toUpperCase()}${period.slice(1)} credits`
            : "Included credits"
        }
        labelTitle={
          usage.usedCents !== undefined && usage.monthlyLimitCents !== undefined
            ? `${formatCents(usage.usedCents)} of ${formatCents(usage.monthlyLimitCents)}`
            : undefined
        }
        pct={included}
        value={included === null ? "–" : `${Math.round(included)}%`}
        note={formatReset(usage.periodEnd ?? null)}
        noteTitle={absoluteReset(usage.periodEnd ?? null)}
      />
      {(usage.productUsage || []).map((entry) => (
        <Meter
          key={entry.product}
          label={entry.product}
          pct={entry.usagePercent}
          value={`${Math.round(entry.usagePercent)}%`}
        />
      ))}
      {onDemandPct !== null && (
        <Meter
          label="On-demand"
          labelTitle={`${formatCents(usage.onDemandUsedCents ?? 0)} of ${formatCents(usage.onDemandCapCents ?? 0)}`}
          pct={onDemandPct}
          value={`${Math.round(onDemandPct)}%`}
          note={usage.onDemandEnabled === false ? "off" : undefined}
        />
      )}
    </MeterGroup>
  );
}

function useXaiAccounts() {
  const [accounts, setAccounts] = useState<XaiAccountInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceUsage = false) => {
    if (forceUsage) setRefreshing(true);
    try {
      const { accounts } = await request<{ accounts: XaiAccountInfo[] }>(
        forceUsage ? "/xai-accounts/refresh" : "/xai-accounts",
        {
          method: forceUsage ? "POST" : "GET",
          label: "Could not load xAI accounts",
        },
      );
      setAccounts(accounts);
    } catch (cause) {
      setError(errorMessage(cause, "Could not load xAI accounts"));
      setAccounts((current) => current ?? []);
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function setOwner(account: XaiAccountInfo, owner: string) {
    if (owner === (account.owner || "")) return;
    try {
      await request(`/xai-accounts/${encodeURIComponent(account.id)}`, {
        method: "PUT",
        body: { owner },
        label: "Could not update xAI account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not update xAI account"));
    }
  }

  async function remove(account: XaiAccountInfo) {
    if (
      !confirm(
        `Remove SuperGrok account "${providerAccountLabel(account)}"? Runs will stop using it.`,
      )
    ) {
      return;
    }
    try {
      await request(`/xai-accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        label: "Could not remove xAI account",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not remove xAI account"));
    }
  }

  const rename = useAccountRename("/xai-accounts", "xAI", load, setError);
  return {
    accounts,
    error,
    load,
    refreshing,
    remove,
    rename,
    setError,
    setOwner,
  };
}

type XaiAccountsState = ReturnType<typeof useXaiAccounts>;

function XaiAccountRows({ state }: { state: XaiAccountsState }) {
  return (
    <>
      {state.rename.dialog}
      {[...(state.accounts || [])]
        .sort(
          (left, right) =>
            providerAccountLabel(left).localeCompare(
              providerAccountLabel(right),
            ) || left.id.localeCompare(right.id),
        )
        .map((account) => (
          <SettingRow
            key={account.id}
            className="items-start gap-x-3 phone:px-4"
          >
            <AccountProviderMark name="xai" />
            <SettingRowText>
              <div className="flex min-w-0 items-center gap-2">
                <SettingRowTitle className="truncate">
                  {providerAccountLabel(account)}
                </SettingRowTitle>
                <XaiAccountStatus account={account} />
              </div>
              <SettingRowDescription className="truncate text-meta">
                xAI · SuperGrok login
                {renamedEmail(account)}
                {account.usage?.subscriptionTier
                  ? ` · ${account.usage.subscriptionTier}`
                  : ""}
              </SettingRowDescription>
              <XaiUsageMeters account={account} />
            </SettingRowText>
            <SettingRowControl className="flex items-center gap-1.5 phone:mt-1 phone:ml-0 phone:w-full phone:basis-full phone:gap-2.5 phone:pl-10">
              <span className="hidden shrink-0 text-meta text-faint phone:inline">
                Used by
              </span>
              <OwnerSelect
                value={account.owner || ""}
                onChange={(owner) => state.setOwner(account, owner)}
                label={`Owner of ${providerAccountLabel(account)}`}
                quiet
                className="phone:ml-auto"
                title={accountOwnerDescription(account.owner)}
              />
              <Menu.Root>
                <Menu.Trigger
                  className={rowMenuTriggerClasses}
                  aria-label={`Manage ${providerAccountLabel(account)}`}
                >
                  <IconDotsHorizontal size={20} />
                </Menu.Trigger>
                <Menu.Popup align="end" sideOffset={4}>
                  <Menu.Item onClick={() => state.rename.start(account)}>
                    <IconPencil size={20} className="text-faint" />
                    Rename…
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => state.remove(account)}
                    tone="danger"
                  >
                    <IconTrash size={20} />
                    Remove account
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Root>
            </SettingRowControl>
          </SettingRow>
        ))}
    </>
  );
}

/** One provider, collapsed: how many accounts it has and how many can take a
 * run right now. The accounts themselves stay one click away, so a pool of a
 * dozen reads as two rows instead of a page of meters. */
function ProviderSummaryRow({
  mark,
  title,
  accounts,
  expanded,
  onToggle,
  onAdd,
  children,
}: {
  mark: "claude" | "codex" | "xai";
  title: string;
  accounts: { usable: boolean; exhaustedUntil: string | null }[];
  expanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const total = accounts.length;
  const available = accounts.filter(
    (a) => a.usable && !a.exhaustedUntil,
  ).length;
  return (
    <>
      <SettingRow>
        <IconTile name={mark} size={28} />
        <SettingRowText>
          <SettingRowTitle>{title}</SettingRowTitle>
          <SettingRowDescription>
            {total === 0
              ? "No accounts yet"
              : `${total} account${total === 1 ? "" : "s"} · ${available} available`}
          </SettingRowDescription>
        </SettingRowText>
        <SettingRowControl className="flex items-center gap-1.5">
          {total > 0 && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? "Hide accounts" : "View accounts"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<IconPlus size={20} />}
            onClick={onAdd}
          >
            Add account
          </Button>
        </SettingRowControl>
      </SettingRow>
      {expanded && children}
    </>
  );
}

/** Subscription accounts, one row per provider with its account count.
 * A row opens to its accounts and their usage meters. */
export function ProviderAccountsSection({
  onboarding = false,
  onChanged,
}: {
  onboarding?: boolean;
  onChanged?: () => void | Promise<void>;
} = {}) {
  const claude = useClaudeAccounts();
  const codex = useCodexAccounts();
  const xai = useXaiAccounts();
  const [adding, setAdding] = useState<"claude" | "codex" | "xai" | null>(null);
  const [expanded, setExpanded] = useState<"claude" | "codex" | "xai" | null>(
    null,
  );
  const loading =
    claude.accounts === null ||
    codex.accounts === null ||
    xai.accounts === null;
  const empty =
    !loading &&
    claude.accounts?.length === 0 &&
    codex.accounts?.length === 0 &&
    xai.accounts?.length === 0;
  const refreshing = claude.refreshing || codex.refreshing || xai.refreshing;

  function refreshUsage() {
    void Promise.allSettled([
      claude.load(true),
      codex.load(true),
      xai.load(true),
    ]);
  }

  return (
    <>
      <SettingsGroupLabel
        className={cn(
          "phone:[&>span]:w-full phone:[&>div]:w-full phone:[&>div]:flex-wrap",
          onboarding && "px-6",
        )}
        actions={
          <>
            {!onboarding && (
              <Button
                size="sm"
                variant="ghost"
                icon={
                  <IconHistory
                    size={20}
                    className={refreshing ? "animate-spin" : ""}
                  />
                }
                onClick={refreshUsage}
                disabled={refreshing}
              >
                {refreshing ? "Checking…" : "Refresh usage"}
              </Button>
            )}
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    size={onboarding ? "md" : "sm"}
                    variant={onboarding ? "primary" : "default"}
                    className={cn(
                      "",
                      onboarding && "bg-fg text-bg hover:bg-fg/85",
                    )}
                    icon={<IconPlus size={20} />}
                    caret={!onboarding}
                  >
                    Add account
                  </Button>
                }
              />
              <Menu.Popup align="end" sideOffset={4}>
                <Menu.Item onClick={() => setAdding("claude")}>
                  <IconTile name="claude" size={18} />
                  Claude account
                </Menu.Item>
                <Menu.Item onClick={() => setAdding("codex")}>
                  <IconTile name="codex" size={18} />
                  OpenAI account
                </Menu.Item>
                <Menu.Item onClick={() => setAdding("xai")}>
                  <IconTile name="xai" size={18} />
                  xAI account
                </Menu.Item>
              </Menu.Popup>
            </Menu.Root>
          </>
        }
      >
        Subscriptions
      </SettingsGroupLabel>

      {claude.error && (
        <InlineAlert className="mb-2" onDismiss={() => claude.setError(null)}>
          {claude.error}
        </InlineAlert>
      )}
      {codex.error && (
        <InlineAlert className="mb-2" onDismiss={() => codex.setError(null)}>
          {codex.error}
        </InlineAlert>
      )}
      {xai.error && (
        <InlineAlert className="mb-2" onDismiss={() => xai.setError(null)}>
          {xai.error}
        </InlineAlert>
      )}

      <Modal.Root
        open={adding === "claude"}
        onOpenChange={(open) => !open && setAdding(null)}
      >
        <Modal.Content widthClassName="max-w-[32rem]">
          <AddClaudeAccountForm
            onAccountAdded={() => {
              void claude.load();
              void onChanged?.();
            }}
            onDone={() => setAdding(null)}
          />
        </Modal.Content>
      </Modal.Root>
      <Modal.Root
        open={adding === "codex"}
        onOpenChange={(open) => !open && setAdding(null)}
      >
        <Modal.Content>
          <AddCodexAccountForm
            onAdded={() => {
              setAdding(null);
              void codex.load();
              void onChanged?.();
            }}
          />
        </Modal.Content>
      </Modal.Root>
      <Modal.Root
        open={adding === "xai"}
        onOpenChange={(open) => !open && setAdding(null)}
      >
        <Modal.Content>
          <AddXaiAccountForm
            onAdded={() => {
              setAdding(null);
              void xai.load();
              void onChanged?.();
            }}
          />
        </Modal.Content>
      </Modal.Root>

      <SettingCard className={onboarding ? "p-1" : undefined}>
        {loading ? (
          <LoadingState placement="row">Loading accounts…</LoadingState>
        ) : empty ? (
          <EmptyState placement="row">
            {onboarding
              ? "Connect a Claude, OpenAI or xAI account to use its subscription."
              : "No accounts yet. Runs use this server's own sign-ins."}
          </EmptyState>
        ) : (
          <>
            <ProviderSummaryRow
              mark="claude"
              title="Claude"
              accounts={claude.accounts || []}
              expanded={expanded === "claude"}
              onToggle={() =>
                setExpanded(expanded === "claude" ? null : "claude")
              }
              onAdd={() => setAdding("claude")}
            >
              <ClaudeAccountRows state={claude} />
            </ProviderSummaryRow>
            <ProviderSummaryRow
              mark="codex"
              title="OpenAI"
              accounts={codex.accounts || []}
              expanded={expanded === "codex"}
              onToggle={() =>
                setExpanded(expanded === "codex" ? null : "codex")
              }
              onAdd={() => setAdding("codex")}
            >
              <CodexAccountRows state={codex} />
            </ProviderSummaryRow>
            <ProviderSummaryRow
              mark="xai"
              title="xAI"
              accounts={xai.accounts || []}
              expanded={expanded === "xai"}
              onToggle={() => setExpanded(expanded === "xai" ? null : "xai")}
              onAdd={() => setAdding("xai")}
            >
              <XaiAccountRows state={xai} />
            </ProviderSummaryRow>
          </>
        )}
      </SettingCard>
      <SettingsHint className={onboarding ? "mt-4 px-6" : undefined}>
        Runs rotate through shared accounts. Personal accounts serve only their
        owner.
      </SettingsHint>
    </>
  );
}

// ── Add forms ──────────────────────────────────────────────────────────────

type ClaudeAccountKind = "sign-in" | "setup-token" | "federation" | "api-key";

/** How a Claude account is added: a subscription, by signing in or by pasting
 *  a setup token made elsewhere, or an Anthropic API organization through
 *  workload identity or a static API key. */
const CLAUDE_KIND_ITEMS: { value: ClaudeAccountKind; label: string }[] = [
  { value: "sign-in", label: "Claude subscription · sign in" },
  { value: "setup-token", label: "Claude subscription · setup token" },
  { value: "federation", label: "Claude API · workload identity" },
  { value: "api-key", label: "Claude API · API key" },
];

function ClaudeKindField({
  value,
  onChange,
  disabled,
}: {
  value: ClaudeAccountKind;
  onChange: (kind: ClaudeAccountKind) => void;
  disabled?: boolean;
}) {
  return (
    <Field label="Kind">
      <Select.Root
        items={CLAUDE_KIND_ITEMS}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const kind = CLAUDE_KIND_ITEMS.find((k) => k.value === next);
          if (kind) onChange(kind.value);
        }}
      >
        <Select.Trigger aria-label="Kind" />
        <Select.Popup>
          {CLAUDE_KIND_ITEMS.map((k) => (
            <Select.Item key={k.value} value={k.value}>
              {k.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
    </Field>
  );
}

function AddClaudeAccountForm(props: {
  onAccountAdded: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<ClaudeAccountKind>("sign-in");
  return kind === "sign-in" ? (
    <AddClaudeSignInForm {...props} onKindChange={setKind} />
  ) : kind === "setup-token" ? (
    <AddClaudeSubscriptionForm {...props} onKindChange={setKind} />
  ) : (
    <AddClaudeApiAccountForm {...props} kind={kind} onKindChange={setKind} />
  );
}

/** POST /claude-accounts/api: an API key or federation settings. */
interface ClaudeApiAccountRequest {
  name: string;
  owner?: string;
  apiKey?: string;
  federation?: ClaudeFederationInfo;
}

function ReadonlyValue({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <Input
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        spellCheck={false}
      />
    </Field>
  );
}

function AddClaudeApiAccountForm({
  kind,
  onKindChange,
  onAccountAdded,
  onDone,
}: {
  kind: "federation" | "api-key";
  onKindChange: (kind: ClaudeAccountKind) => void;
  onAccountAdded: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [federation, setFederation] = useState<ClaudeFederationInfo>({
    organizationId: "",
    federationRuleId: "",
    serviceAccountId: "",
    workspaceId: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: setup, error: setupError } = useClaudeFederationSetupResource(
    kind === "federation",
  );

  const field = (key: keyof ClaudeFederationInfo) => ({
    value: federation[key] ?? "",
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setFederation((prev) => ({ ...prev, [key]: event.target.value })),
    autoCapitalize: "none" as const,
    autoComplete: "off",
    spellCheck: false,
  });

  const enrollBlocked = kind === "federation" && setup?.canEnroll === false;
  const ready = Boolean(
    name.trim() &&
    (kind === "api-key"
      ? apiKey.trim()
      : !enrollBlocked &&
        federation.organizationId.trim() &&
        federation.federationRuleId.trim() &&
        federation.serviceAccountId.trim()),
  );

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const body: ClaudeApiAccountRequest = { name: name.trim() };
      if (owner.trim()) body.owner = owner.trim();
      if (kind === "api-key") body.apiKey = apiKey.replace(/\s+/g, "");
      else body.federation = federation;
      const added = await request<ClaudeAccountInfo & { warning?: string }>(
        "/claude-accounts/api",
        {
          method: "POST",
          body,
          label: "Could not add Claude API account",
        },
      );
      toast(
        added.warning
          ? `Added ${providerAccountLabel(added)}. ${added.warning}`
          : `Added ${providerAccountLabel(added)}`,
      );
      onAccountAdded();
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add Claude API account"));
      setSaving(false);
    }
  }

  return (
    <>
      <Modal.Header
        title="Add Claude account"
        description="A Claude API account serves Mythos, which Anthropic offers to verified API organizations. Its runs are billed to that organization."
      />
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !saving) void handleAdd();
        }}
      >
        <div className="flex flex-col gap-3">
          <ClaudeKindField value={kind} onChange={onKindChange} />
          <Field label="Name">
            <Input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme API"
              autoComplete="off"
            />
          </Field>
          {kind === "api-key" ? (
            <>
              <Field label="API key">
                <Input
                  required
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-ant-api03-…"
                />
              </Field>
              <p className="m-0 text-meta leading-relaxed text-faint">
                Create a key in the Claude Console. Workload identity avoids
                storing a long-lived key and is required by some programs.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-md bg-surface px-4 py-3">
                <SettingRowDescription>
                  In the Claude Console, add an identity issuer and a federation
                  rule bound to a service account with these values. No secret
                  is stored here.
                </SettingRowDescription>
                {enrollBlocked ? (
                  <InlineAlert>
                    Only the host operator can add a workload identity account.
                    Add a Claude API key instead.
                  </InlineAlert>
                ) : setup ? (
                  <>
                    <ReadonlyValue label="Issuer URL" value={setup.issuer} />
                    {setup.publicIssuer ? (
                      <ReadonlyValue label="JWKS URL" value={setup.jwksUrl} />
                    ) : (
                      <>
                        <ReadonlyValue label="Inline JWKS" value={setup.jwks} />
                        <p className="m-0 text-meta leading-relaxed text-faint">
                          Anthropic can't reach this server's address, so paste
                          the key set instead of a JWKS URL.
                        </p>
                      </>
                    )}
                    <ReadonlyValue label="Subject" value={setup.subject} />
                    <ReadonlyValue label="Audience" value={setup.audience} />
                  </>
                ) : setupError ? (
                  <InlineAlert>
                    {errorMessage(
                      setupError,
                      "Could not load workload identity settings",
                    )}
                  </InlineAlert>
                ) : (
                  <LoadingState placement="row">Loading…</LoadingState>
                )}
              </div>
              <Field label="Organization ID">
                <Input
                  required
                  placeholder="00000000-0000-0000-0000-000000000000"
                  {...field("organizationId")}
                />
              </Field>
              <Field label="Federation rule ID">
                <Input
                  required
                  placeholder="fdrl_…"
                  {...field("federationRuleId")}
                />
              </Field>
              <Field label="Service account ID">
                <Input
                  required
                  placeholder="svac_…"
                  {...field("serviceAccountId")}
                />
              </Field>
              <Field label="Workspace ID (optional)">
                <Input
                  placeholder="wrkspc_… or default"
                  {...field("workspaceId")}
                />
              </Field>
            </>
          )}
          <Field
            label="Owner"
            title="Personal: this person's Mythos runs use the account first. Automations: only automation runs use it. Shared pool: used by everyone and by automations."
          >
            <OwnerSelect value={owner} onChange={setOwner} label="Owner" />
          </Field>
        </div>

        {error && <InlineAlert>{error}</InlineAlert>}

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={saving || !ready}>
            {saving
              ? kind === "federation"
                ? "Testing exchange…"
                : "Validating…"
              : "Add account"}
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

/** GET/POST /claude-accounts/token-login: the server running
 *  `claude setup-token` for a new subscription account. */
interface ClaudeTokenLogin {
  id: string;
  name: string;
  state: "starting" | "awaiting_sign_in" | "done" | "error" | "cancelled";
  url?: string;
  error?: string;
  account?: ClaudeAccountInfo;
}

function AddClaudeSignInForm({
  onAccountAdded,
  onDone,
  onKindChange,
}: {
  onAccountAdded: () => void;
  onDone: () => void;
  onKindChange: (kind: ClaudeAccountKind) => void;
}) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [login, setLogin] = useState<ClaudeTokenLogin | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending =
    !!login &&
    (login.state === "starting" || login.state === "awaiting_sign_in");
  const loginPath = login
    ? `/claude-accounts/token-login/${encodeURIComponent(login.id)}`
    : null;

  const cancelPending = useEffectEvent(() => {
    if (!pending || !loginPath) return;
    void request(loginPath, {
      method: "DELETE",
      label: "Could not cancel Claude sign-in",
    }).catch(() => undefined);
  });
  useEffect(() => () => cancelPending(), []);

  function settle(next: ClaudeTokenLogin) {
    setLogin(next);
    if (next.state !== "done") return;
    toast(
      `Claude account ${next.account ? providerAccountLabel(next.account) : next.name} connected`,
    );
    onAccountAdded();
    onDone();
  }
  const poll = useEffectEvent(async () => {
    if (!loginPath) return;
    try {
      settle(
        await request<ClaudeTokenLogin>(loginPath, {
          label: "Could not refresh Claude sign-in",
        }),
      );
    } catch {
      // Keep polling. One failed refresh does not end the sign-in.
    }
  });
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [pending]);

  async function handleStart() {
    setBusy(true);
    setError(null);
    setCode("");
    try {
      const trimmedOwner = owner.trim();
      const account = { name: name.trim() };
      settle(
        await request<ClaudeTokenLogin>("/claude-accounts/token-login", {
          method: "POST",
          body: trimmedOwner ? { ...account, owner: trimmedOwner } : account,
          label: "Could not start Claude sign-in",
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not start Claude sign-in"));
    }
    setBusy(false);
  }

  async function handleSubmitCode() {
    if (!loginPath) return;
    setBusy(true);
    setError(null);
    try {
      settle(
        await request<ClaudeTokenLogin>(loginPath, {
          method: "POST",
          body: { code },
          label: "Could not send the code",
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not send the code"));
    }
    setBusy(false);
  }

  return (
    <>
      <Modal.Header
        title="Add Claude account"
        description="Sign in with a Claude subscription. The sign-in lasts about one year."
      />
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (pending) {
            if (code.trim()) void handleSubmitCode();
          } else if (name.trim()) void handleStart();
        }}
      >
        <div className="flex flex-col gap-3">
          <ClaudeKindField
            value="sign-in"
            onChange={onKindChange}
            disabled={pending}
          />
          <Field label="Email">
            <Input
              required
              type="email"
              autoComplete="email"
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              placeholder="person@example.com"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            label="Owner"
            title="Personal sub: this person's runs use the account first, with the shared pool as backup. Automations: only automation runs use it, before the shared pool. Shared pool: used by everyone and by automations."
          >
            <OwnerSelect
              value={owner}
              onChange={setOwner}
              label="Owner"
              disabled={pending}
            />
          </Field>
        </div>

        {pending && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col gap-3 rounded-md bg-surface px-4 py-3"
          >
            {login?.url ? (
              <>
                <SettingRowDescription>
                  Approve the sign-in in your browser. If no browser opened, or
                  it is on another device, open the link and paste the code
                  Claude shows.
                </SettingRowDescription>
                <Button
                  render={
                    <a
                      className="self-start"
                      href={login.url}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                  icon={<IconPlug size={20} />}
                >
                  Open Claude sign-in
                </Button>
                <Field label="Code">
                  <Input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Paste the code from Claude (…#…)"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              </>
            ) : (
              <LoadingState placement="row">Starting sign-in…</LoadingState>
            )}
          </div>
        )}

        {(error || login?.state === "error") && (
          <InlineAlert>{error || login?.error || "Sign-in failed"}</InlineAlert>
        )}

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          {pending ? (
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !code.trim()}
            >
              {busy ? "Sending…" : "Use code"}
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !name.trim()}
            >
              {busy
                ? "Starting…"
                : login?.state === "error"
                  ? "Try again"
                  : "Sign in with Claude"}
            </Button>
          )}
        </Modal.Footer>
      </form>
    </>
  );
}

function AddClaudeSubscriptionForm({
  onAccountAdded,
  onDone,
  onKindChange,
}: {
  onAccountAdded: () => void;
  onDone: () => void;
  onKindChange: (kind: ClaudeAccountKind) => void;
}) {
  const [account, setAccount] = useState<ClaudeAccountInfo | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ id?: string; done: boolean }>({ done: false });
  useLayoutEffect(() => {
    pending.current.id = login?.id;
  });

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void request<{ id: string; url: string }>("/claude-accounts/oauth-login", {
      method: "POST",
      body: { accountId: account.id },
      label: "Could not start Claude sign-in",
    }).then(
      (nextLogin) => {
        if (!cancelled) setLogin(nextLogin);
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(errorMessage(cause, "Could not start Claude sign-in"));
      },
    );
    return () => {
      cancelled = true;
      abortPendingOAuth(pending);
    };
  }, [account]);

  async function handleAddToken() {
    setSaving(true);
    setError(null);
    try {
      const account = {
        name: name.trim(),
        token: token.replace(/\s+/g, ""),
      };
      const trimmedOwner = owner.trim();
      const added = await request<ClaudeAccountInfo>("/claude-accounts", {
        method: "POST",
        body: trimmedOwner ? { ...account, owner: trimmedOwner } : account,
        label: "Could not add Anthropic account",
      });
      setAccount(added);
      onAccountAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add Anthropic account"));
    }
    setSaving(false);
  }

  async function handleConnectUsage() {
    if (!login) return;
    setSaving(true);
    setError(null);
    try {
      const result = await request<{ account?: ClaudeAccountInfo }>(
        `/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`,
        {
          method: "POST",
          body: { code },
          label: "Could not connect Anthropic usage tracking",
        },
      );
      pending.current.done = true;
      toast(
        `Usage tracking connected for ${
          result.account
            ? providerAccountLabel(result.account)
            : account
              ? providerAccountLabel(account)
              : "Claude"
        }`,
      );
      onAccountAdded();
      onDone();
    } catch (cause) {
      setError(
        errorMessage(cause, "Could not connect Anthropic usage tracking"),
      );
      setSaving(false);
    }
  }

  if (account) {
    return (
      <>
        <Modal.Header
          title="Connect usage tracking"
          description="The setup token is connected for model runs."
        />
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (login && code.trim() && !saving) void handleConnectUsage();
          }}
        >
          <div className="flex flex-col gap-3 rounded-md bg-surface px-4 py-3">
            {login ? (
              <Button
                render={
                  <a
                    className="self-start"
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
                icon={<IconPlug size={20} />}
              >
                Open Claude sign-in
              </Button>
            ) : !error ? (
              <LoadingState placement="row">Preparing sign-in…</LoadingState>
            ) : null}
            <SettingRowDescription>
              Sign in with the same Claude account to show usage and reset
              times. Claude asks you to reconnect about every 30 days.
            </SettingRowDescription>
            <Field label="Code">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Paste the code from Claude (…#…)"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <p className="m-0 text-meta leading-relaxed text-faint">
              You can finish later. Runs can use this account without usage
              tracking.
            </p>
          </div>

          {error && <InlineAlert>{error}</InlineAlert>}

          <Modal.Footer>
            <Button
              variant="ghost"
              type="button"
              disabled={saving}
              onClick={onDone}
            >
              Finish later
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={saving || !login || !code.trim()}
            >
              {saving ? "Connecting…" : "Connect usage"}
            </Button>
          </Modal.Footer>
        </form>
      </>
    );
  }

  const ready = Boolean(name.trim() && token.trim());
  return (
    <>
      <Modal.Header
        title="Add Claude account"
        description="Claude uses a setup token for model runs and a separate sign-in for usage tracking."
      />
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !saving) void handleAddToken();
        }}
      >
        <div className="flex flex-col gap-3">
          <ClaudeKindField value="setup-token" onChange={onKindChange} />
          <Field label="Email">
            <Input
              required
              type="email"
              autoComplete="email"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="person@example.com"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Setup token">
            <Input
              required
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-ant-oat01-…"
            />
          </Field>
          <p className="m-0 text-meta leading-relaxed text-faint">
            Run <code>claude setup-token</code> on any computer signed into this
            Claude account. The token powers model runs for about one year.
          </p>
          <Field
            label="Owner"
            title="Personal sub: this person's runs use the account first, with the shared pool as backup. Automations: only automation runs use it, before the shared pool. Shared pool: used by everyone and by automations."
          >
            <OwnerSelect value={owner} onChange={setOwner} label="Owner" />
          </Field>
        </div>

        {error && <InlineAlert>{error}</InlineAlert>}

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={saving || !ready}>
            {saving ? "Validating…" : "Continue"}
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

interface CodexDeviceLogin {
  id: string;
  name: string;
  state: "starting" | "awaiting_code" | "done" | "error" | "cancelled";
  url?: string;
  code?: string;
  error?: string;
  account?: CodexAccountInfo;
}

/** How a Codex account is added: a ChatGPT sign-in, an existing CODEX_HOME
 *  directory, or a plain API key. */
const KIND_ITEMS = [
  { value: "device", label: "ChatGPT sign-in · device code" },
  { value: "oauth", label: "ChatGPT sign-in · link and paste" },
  { value: "home", label: "ChatGPT login · existing CODEX_HOME directory" },
  { value: "api_key", label: "OpenAI API key" },
];

function AddCodexAccountForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"device" | "oauth" | "api_key" | "home">(
    "device",
  );
  const [value, setValue] = useState("");
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  // Paste-link OAuth flow (kind "oauth") — the codex analog of the Claude
  // sign-in: open the URL anywhere, paste back the localhost redirect.
  const [oauth, setOauth] = useState<{ id: string; url: string } | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [pendingDone, setPendingDone] = useState(false);

  const cleanupPendingLogin = useEffectEvent(() => {
    if (pendingDone) return;
    const deviceLoginId =
      login && (login.state === "starting" || login.state === "awaiting_code")
        ? login.id
        : null;
    if (deviceLoginId) {
      void request(
        `/codex-accounts/device-login/${encodeURIComponent(deviceLoginId)}`,
        { method: "DELETE", label: "Could not cancel ChatGPT sign-in" },
      ).catch(() => undefined);
    }
    if (oauth) {
      void request(
        `/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`,
        { method: "DELETE", label: "Could not cancel ChatGPT sign-in" },
      ).catch(() => undefined);
    }
  });
  useEffect(() => () => cleanupPendingLogin(), []);

  const pollDeviceLoginTick = useEffectEvent(async () => {
    if (!login?.id) return;
    try {
      const next = await request<CodexDeviceLogin>(
        `/codex-accounts/device-login/${encodeURIComponent(login.id)}`,
        { label: "Could not refresh ChatGPT sign-in" },
      );
      setLogin(next);
      if (next.state === "done") {
        setPendingDone(true);
        onAdded();
      }
    } catch {
      // Keep polling. A transient refresh failure does not end the device flow.
    }
  });
  const loginId = login?.id;
  const loginState = login?.state;
  useEffect(() => {
    if (!loginId || loginState === "done" || loginState === "error") return;
    const timer = setInterval(() => void pollDeviceLoginTick(), 2000);
    return () => clearInterval(timer);
  }, [loginId, loginState]);

  async function handleStartDeviceLogin() {
    setSaving(true);
    setError(null);
    try {
      const next = await request<CodexDeviceLogin>(
        "/codex-accounts/device-login",
        {
          method: "POST",
          body: owner.trim() ? { owner: owner.trim() } : {},
          label: "Could not start ChatGPT device sign-in",
        },
      );
      setLogin(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not start ChatGPT device sign-in"));
    }
    setSaving(false);
  }

  async function handleStartOauth() {
    setSaving(true);
    setError(null);
    try {
      const next = await request<{ id: string; url: string }>(
        "/codex-accounts/oauth-login",
        {
          method: "POST",
          body: owner.trim() ? { owner: owner.trim() } : {},
          label: "Could not start ChatGPT sign-in",
        },
      );
      setOauth(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not start ChatGPT sign-in"));
    }
    setSaving(false);
  }

  async function handleCompleteOauth() {
    if (!oauth) return;
    setSaving(true);
    setError(null);
    try {
      const { account } = await request<{ account: CodexAccountInfo }>(
        `/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`,
        {
          method: "POST",
          body: { code: oauthCode },
          label: "Could not complete ChatGPT sign-in",
        },
      );
      toast(`Codex account ${providerAccountLabel(account)} added to the pool`);
      setPendingDone(true);
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not complete ChatGPT sign-in"));
      setSaving(false);
    }
  }

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const account =
        kind === "api_key"
          ? { name: name.trim(), kind, value: value.trim() }
          : { kind, value: value.trim() };
      const trimmedOwner = owner.trim();
      await request("/codex-accounts", {
        method: "POST",
        body: trimmedOwner ? { ...account, owner: trimmedOwner } : account,
        label: "Could not add OpenAI account",
      });
      setPendingDone(true);
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add OpenAI account"));
      setSaving(false);
    }
  }

  const loginPending =
    login && (login.state === "starting" || login.state === "awaiting_code");

  return (
    <>
      <Modal.Header
        title="Add Codex account"
        description={
          kind === "device" ? (
            <>
              You'll get a link and a code to enter on any device. Device-code
              login must be on in the ChatGPT workspace's security settings.
            </>
          ) : kind === "oauth" ? (
            <>
              Sign in with ChatGPT on any device. Works even where device-code
              login is disabled. After signing in you'll land on a{" "}
              <code>localhost</code> page that fails to load; copy that page's
              full address and paste it back here.
            </>
          ) : kind === "home" ? (
            <>
              On the VPS run{" "}
              <code>
                CODEX_HOME=~/.codex-accounts/&lt;account&gt; codex login
              </code>{" "}
              (or copy an <code>auth.json</code> from another machine into that
              directory), then register the directory here.
            </>
          ) : (
            <>For platform billing, paste an OpenAI API key.</>
          )
        }
      />

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          if (kind === "device") {
            if (!loginPending && login?.state !== "done")
              void handleStartDeviceLogin();
          } else if (kind === "oauth") {
            if (oauth) {
              if (oauthCode.trim()) void handleCompleteOauth();
            } else void handleStartOauth();
          } else if (value.trim() && (kind !== "api_key" || name.trim()))
            void handleAdd();
        }}
      >
        <div className="flex flex-col gap-3">
          {kind === "api_key" && (
            <Field label="Name">
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Platform key"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          )}
          <Field label="Kind">
            <Select.Root
              items={KIND_ITEMS}
              value={kind}
              disabled={!!login || !!oauth}
              onValueChange={(next) => {
                if (
                  next === "device" ||
                  next === "oauth" ||
                  next === "api_key" ||
                  next === "home"
                )
                  setKind(next);
              }}
            >
              <Select.Trigger aria-label="Kind" />
              <Select.Popup>
                {KIND_ITEMS.map((k) => (
                  <Select.Item key={k.value} value={k.value}>
                    {k.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </Field>
          {kind !== "device" && kind !== "oauth" && (
            <Field label={kind === "api_key" ? "API key" : "CODEX_HOME path"}>
              <Input
                type={kind === "api_key" ? "password" : "text"}
                required
                autoComplete={kind === "api_key" ? "off" : undefined}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  kind === "api_key" ? "sk-…" : "~/.codex-accounts/team"
                }
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          )}
          <Field
            label="Owner"
            title="Personal sub: this person's runs use the account first, with the shared pool as backup. Automations: only automation runs use it, before the shared pool. Shared pool: used by everyone and by automations."
          >
            <OwnerSelect
              value={owner}
              onChange={setOwner}
              label="Owner"
              disabled={!!login || !!oauth}
            />
          </Field>
        </div>

        {login && (
          // A well inside the dialog, so the live sign-in stands apart
          // from the fields without another border.
          <div
            role="status"
            aria-live="polite"
            className="rounded-md bg-surface px-4 py-3 text-supporting"
          >
            {login.state === "starting" && (
              <div className="text-dim">Starting sign-in…</div>
            )}
            {login.state === "awaiting_code" && (
              <>
                <div>
                  1. Open{" "}
                  <a
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link underline"
                  >
                    {login.url}
                  </a>{" "}
                  and sign in to the ChatGPT account.
                </div>
                <div className="mt-1.5">
                  2. Enter this one-time code (expires in 15 min):
                </div>
                {login.code && (
                  <div className="my-2">
                    <DeviceCode
                      code={login.code}
                      className="text-section-title"
                    />
                  </div>
                )}
                <div className="text-dim">
                  Waiting for the sign-in to complete… this panel updates by
                  itself.
                </div>
              </>
            )}
            {login.state === "done" && (
              <div>
                Signed in.{" "}
                {login.account
                  ? providerAccountLabel(login.account)
                  : "Account"}{" "}
                added to the pool.
              </div>
            )}
            {login.state === "error" && (
              <InlineAlert
                className="whitespace-pre-wrap"
                onRetry={() => setLogin(null)}
                retryLabel="Try again"
              >
                {login.error || "Sign-in failed."}
              </InlineAlert>
            )}
          </div>
        )}

        {oauth && (
          <div className="rounded-md bg-surface px-4 py-3 text-supporting">
            <div>
              1. Open{" "}
              <a
                href={oauth.url}
                target="_blank"
                rel="noreferrer"
                className="text-link underline"
              >
                the ChatGPT sign-in
              </a>{" "}
              and sign in to the account.
            </div>
            <div className="mt-1.5">
              2. The browser lands on a <code>localhost</code> page that can't
              load. Copy its full address (starts with{" "}
              <code>http://localhost:1455/…</code>) and paste it:
            </div>
            <Input
              className="mt-2"
              value={oauthCode}
              onChange={(e) => setOauthCode(e.target.value)}
              placeholder="http://localhost:1455/auth/callback?code=…"
              aria-label="Pasted sign-in redirect URL"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        )}

        {error && <InlineAlert>{error}</InlineAlert>}

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                {loginPending || oauth ? "Cancel sign-in" : "Cancel"}
              </Button>
            }
          />
          {kind === "device" ? (
            <Button
              variant="primary"
              type="submit"
              disabled={saving || !!loginPending || login?.state === "done"}
            >
              {saving
                ? "Starting…"
                : loginPending
                  ? "Waiting for sign-in…"
                  : "Start sign-in"}
            </Button>
          ) : kind === "oauth" ? (
            oauth ? (
              <Button
                variant="primary"
                type="submit"
                disabled={saving || !oauthCode.trim()}
              >
                {saving ? "Connecting…" : "Connect"}
              </Button>
            ) : (
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? "Starting…" : "Start sign-in"}
              </Button>
            )
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={
                saving || !value.trim() || (kind === "api_key" && !name.trim())
              }
            >
              {saving ? "Adding…" : "Add account"}
            </Button>
          )}
        </Modal.Footer>
      </form>
    </>
  );
}

interface XaiDeviceLogin {
  id: string;
  state: "starting" | "awaiting_code" | "done" | "error" | "cancelled";
  url?: string;
  code?: string;
  error?: string;
  account?: XaiAccountInfo;
}

/** SuperGrok sign-in: device code only, the same shape as the ChatGPT device
 * flow. The server runs the OAuth exchange itself, so nothing needs a VPS
 * shell or a Pi extension. */
function AddXaiAccountForm({ onAdded }: { onAdded: () => void }) {
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<XaiDeviceLogin | null>(null);
  const [pendingDone, setPendingDone] = useState(false);

  const cleanupPendingLogin = useEffectEvent(() => {
    if (pendingDone) return;
    if (
      login &&
      (login.state === "starting" || login.state === "awaiting_code")
    ) {
      void request(
        `/xai-accounts/device-login/${encodeURIComponent(login.id)}`,
        { method: "DELETE", label: "Could not cancel xAI sign-in" },
      ).catch(() => undefined);
    }
  });
  useEffect(() => () => cleanupPendingLogin(), []);

  const pollDeviceLoginTick = useEffectEvent(async () => {
    if (!login?.id) return;
    try {
      const next = await request<XaiDeviceLogin>(
        `/xai-accounts/device-login/${encodeURIComponent(login.id)}`,
        { label: "Could not refresh xAI sign-in" },
      );
      setLogin(next);
      if (next.state === "done") {
        setPendingDone(true);
        onAdded();
      }
    } catch {
      // Keep polling. A transient refresh failure does not end the device flow.
    }
  });
  const loginId = login?.id;
  const loginState = login?.state;
  useEffect(() => {
    if (!loginId || loginState === "done" || loginState === "error") return;
    const timer = setInterval(() => void pollDeviceLoginTick(), 2000);
    return () => clearInterval(timer);
  }, [loginId, loginState]);

  async function handleStartDeviceLogin() {
    setSaving(true);
    setError(null);
    try {
      const next = await request<XaiDeviceLogin>("/xai-accounts/device-login", {
        method: "POST",
        body: owner.trim() ? { owner: owner.trim() } : {},
        label: "Could not start xAI sign-in",
      });
      setLogin(next);
    } catch (cause) {
      setError(errorMessage(cause, "Could not start xAI sign-in"));
    }
    setSaving(false);
  }

  const loginPending =
    login && (login.state === "starting" || login.state === "awaiting_code");

  return (
    <>
      <Modal.Header
        title="Add xAI account"
        description="Sign in with a SuperGrok or X Premium account from here. You'll get a link and a one-time code to enter on any device. Runs on Grok models then draw on that subscription's quota, not API credits."
      />

      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          if (!loginPending && login?.state !== "done")
            void handleStartDeviceLogin();
        }}
      >
        <Field
          label="Owner"
          title="Personal sub: this person's runs use the account first, with the shared pool as backup. Automations: only automation runs use it, before the shared pool. Shared pool: used by everyone and by automations."
        >
          <OwnerSelect
            value={owner}
            onChange={setOwner}
            label="Owner"
            disabled={!!login}
          />
        </Field>

        {login && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md bg-surface px-4 py-3 text-supporting"
          >
            {login.state === "starting" && (
              <div className="text-dim">Starting sign-in…</div>
            )}
            {login.state === "awaiting_code" && (
              <>
                <div>
                  1. Open{" "}
                  <a
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link underline"
                  >
                    {login.url}
                  </a>{" "}
                  and sign in to the xAI account.
                </div>
                <div className="mt-1.5">
                  2. Confirm this one-time code if the page asks for it:
                </div>
                {login.code && (
                  <div className="my-2">
                    <DeviceCode
                      code={login.code}
                      className="text-section-title"
                    />
                  </div>
                )}
                <div className="text-dim">
                  Waiting for the sign-in to complete… this panel updates by
                  itself.
                </div>
              </>
            )}
            {login.state === "done" && (
              <div>
                Signed in.{" "}
                {login.account
                  ? providerAccountLabel(login.account)
                  : "Account"}{" "}
                added to the pool.
              </div>
            )}
            {login.state === "error" && (
              <InlineAlert
                className="whitespace-pre-wrap"
                onRetry={() => setLogin(null)}
                retryLabel="Try again"
              >
                {login.error || "Sign-in failed."}
              </InlineAlert>
            )}
          </div>
        )}

        {error && <InlineAlert>{error}</InlineAlert>}

        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={saving}>
                {loginPending ? "Cancel sign-in" : "Cancel"}
              </Button>
            }
          />
          <Button
            variant="primary"
            type="submit"
            disabled={saving || !!loginPending || login?.state === "done"}
          >
            {saving
              ? "Starting…"
              : loginPending
                ? "Waiting for sign-in…"
                : "Start sign-in"}
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}
