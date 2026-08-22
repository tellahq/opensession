import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState, useCallback, useRef } from "react";
import { Menu } from "../ui/menu";
import { OptionSelect } from "../ui/select";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { DeviceCode } from "../ui/device-code";
import { Modal } from "../ui/modal";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { InlineAlert, Skeleton, SkeletonBar } from "../ui/state";
import { PulseDot } from "../ui/status";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsFormTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  SettingsSection,
  StatusChip,
  rowMenuTriggerClasses,
  settingsInputClass,
} from "../ui/settings";
import {
  IconArrowUpRight,
  IconDotsHorizontal,
  IconPlug,
  IconTrash,
  IconSliders,
  IconHistory,
  IconPlus,
} from "./icons";
import { displayName } from "../brand-logos";
import { IconTile } from "./BrandTile";
import { UserAvatar } from "./UserAvatar";
import { AGENT_NAME, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { ProjectsSection } from "./ProjectsSection";
import {
  connectCodeStorage,
  disconnectCodeStorage,
  fetchCodeStorageStatus,
  relativeTime,
  type CodeStorageStatus,
} from "../lib/api";

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "needs-auth" | "unreachable" | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
}

interface AgentHealth {
  status?: string;
  activeSessions?: number;
  [key: string]: unknown;
}

interface ConnectionsData {
  mcpServers: McpConnection[];
  agents: Record<string, AgentHealth>;
}

const STATUS_META: Record<McpConnection["status"], { label: string; dot: string; bad?: boolean }> = {
  connected: { label: "Connected", dot: "var(--green)" },
  ready: { label: "Ready", dot: "var(--green)" },
  "needs-env": { label: "Needs setup", dot: "var(--yellow)", bad: true },
  "needs-auth": { label: "Sign in required", dot: "var(--yellow)", bad: true },
  unreachable: { label: "Unreachable", dot: "var(--red)", bad: true },
  missing: { label: "Missing", dot: "var(--red)", bad: true },
};

const MCP_BLURBS: Record<string, string> = {
  linear: "Issues and projects: read and update Linear",
  plain: "Customer support threads from Plain",
  sentry: "Errors and performance issues",
  workos: "User & organization admin",
  tinybird: "Analytics queries over product events",
  stripe: "Billing, subscriptions & refunds",
  amplitude: "Product analytics events",
  grafana: "Dashboards, logs & metrics",
  incident: "incident.io: incidents and on-call",
  slack: "Post & read Slack messages",
  ahrefs: "SEO, keywords & backlink data",
  github: "Repos, issues & pull requests",
  circle: "Community & support workspace",
};

const AGENT_BLURBS: Record<string, string> = {
  slack: "Mentions & worktree channels in Slack",
  linear: "Delegated Linear issues become sessions",
  plain: "Support escalations from Plain",
  stripe: "Inbound billing events",
  "grafana-poller": "Polls Grafana alerts into sessions",
  github: "Inbound repository events",
  codestorage: "Branch pushes & sync events from code.storage",
};

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9" rx="2" fill="currentColor" opacity="0.9" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

export function SectionHeading({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return <SettingsGroupLabel actions={actions}>{children}</SettingsGroupLabel>;
}

function ConnectionsSkeleton() {
  return (
    <>
      <SectionHeading>Agents: how work reaches {AGENT_NAME}</SectionHeading>
      <Skeleton
        label="Checking connections"
        className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <SettingsSection key={index} className="flex flex-col gap-2 p-3.5">
            <div className="flex items-center gap-2.5">
              <SkeletonBar className="size-[30px] shrink-0 rounded-control" />
              <SkeletonBar className="w-[38%]" />
              <SkeletonBar className="ml-auto h-5 w-16 rounded-[999px]" />
            </div>
            <SkeletonBar className="h-2.5 w-[72%]" />
            <SkeletonBar className="h-2.5 w-[34%]" />
          </SettingsSection>
        ))}
      </Skeleton>

      <SectionHeading>MCP servers: tools inside every session</SectionHeading>
      <SettingCardSkeleton rows={5} icon={40} label="Checking connections" />
    </>
  );
}

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections${force ? "?refresh=1" : ""}`);
      if (res.ok) setData(await res.json());
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => {
    document.title = docTitle("Connections");
    load();
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // OAuth grants per HTTP server (mcp-oauth.ts): shared + per-user badges.
  const [oauthByName, setOauthByName] = useState<
    Record<
      string,
      { shared?: { connectedBy?: string }; users: string[]; capable?: boolean }
    >
  >({});
  const loadOauth = useCallback(async (servers: McpConnection[]) => {
    const entries = await Promise.all(
      servers
        .map(async (s) => {
          try {
            const res = await fetch(
              `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth`,
            );
            return res.ok ? ([s.name, await res.json()] as const) : null;
          } catch {
            return null;
          }
        }),
    );
    setOauthByName(Object.fromEntries(entries.filter(Boolean) as any));
  }, []);
  useEffect(() => {
    if (data?.mcpServers) void loadOauth(data.mcpServers);
  }, [data, loadOauth]);

  // Start a browser OAuth flow (workspace-wide or the signed-in user's own
  // account) and open the consent in a new tab; re-poll status for a while
  // so the badge appears once they approve.
  async function handleOauthConnect(s: McpConnection, scope: "shared" | "me") {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      window.open(body.url, "_blank", "noopener");
      let polls = 0;
      const t = setInterval(() => {
        if (++polls > 24 || !data?.mcpServers) return clearInterval(t);
        void loadOauth(data.mcpServers);
      }, 5000);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleOauthDisconnect(s: McpConnection, scope: "shared" | "me") {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth${scope === "me" ? "?scope=me" : ""}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error((await res.json()).error || `Failed: ${res.status}`);
      if (data?.mcpServers) void loadOauth(data.mcpServers);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleRemove(name: string) {
    if (!confirm(`Remove MCP server "${name}"? New sessions will no longer get its tools.`)) return;
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleRestrict(s: McpConnection) {
    const current = (s.allowedUsers || []).join(", ");
    const answer = prompt(
      `Restrict "${s.name}" to these people (comma-separated configured names, e.g. "Alice, Bob").\n` +
        `Leave blank to make it available to everyone.`,
      current,
    );
    if (answer === null) return; // cancelled
    const allowedUsers = answer
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedUsers }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Connections"
        actions={
          <>
            <Button
              variant="soft"
              icon={<IconHistory size={16} className={refreshing ? "animate-spin" : ""} />}
              onClick={() => load(true)}
              disabled={refreshing}
            >
              {refreshing ? "Checking…" : "Re-check"}
            </Button>
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setShowAdd(true)}
            >
              Add MCP server
            </Button>
          </>
        }
      />

      {removeError && (
        <InlineAlert onDismiss={() => setRemoveError(null)}>{removeError}</InlineAlert>
      )}

      {showAdd && (
        <AddMcpForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load(true);
          }}
        />
      )}

      {!data ? (
        <ConnectionsSkeleton />
      ) : (
        <>
          <SectionHeading>Agents: how work reaches {AGENT_NAME}</SectionHeading>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {Object.entries(data.agents).map(([name, health]) => {
              const ok = health?.status === "operational";
              const count = typeof health?.activeSessions === "number" ? health.activeSessions : null;
              return (
                <SettingsSection key={name} className="flex flex-col gap-2 p-3.5">
                  <div className="flex items-center gap-2.5">
                    <IconTile name={name} size={30} />
                    <span className="min-w-0 flex-1 truncate text-item-title font-medium text-fg">
                      {displayName(name)}
                    </span>
                    <StatusChip
                      label={ok ? "Operational" : String(health?.status || "down")}
                      dot={ok ? "var(--green)" : "var(--red)"}
                    />
                  </div>
                  <div className="text-label leading-snug text-dim">
                    {AGENT_BLURBS[name] || "Inbound agent"}
                  </div>
                  {count !== null && (
                    <div className="text-label text-faint">
                      {count.toLocaleString()} active session{count === 1 ? "" : "s"}
                    </div>
                  )}
                </SettingsSection>
              );
            })}
          </div>

          <SectionHeading>MCP servers: tools inside every session</SectionHeading>
          <SettingCard>
            {data.mcpServers.map((s) => {
              const meta = STATUS_META[s.status];
              const restricted = !!s.allowedUsers?.length;
              return (
                <div
                  key={s.name}
                  className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-hover"
                >
                  <IconTile name={s.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-item-title font-medium text-fg">
                        {displayName(s.name)}
                      </span>
                      {restricted && (
                        <span
                          className="flex flex-shrink-0 items-center gap-1 rounded-full bg-active px-1.5 py-0.5 text-meta font-medium text-dim"
                          title={`Only these people's sessions get this server: ${s.allowedUsers!.join(", ")}`}
                        >
                          <LockIcon /> {s.allowedUsers!.join(", ")}
                        </span>
                      )}
                      {(oauthByName[s.name]?.shared || oauthByName[s.name]?.users.length) ? (
                        <span
                          className="flex flex-shrink-0 items-center gap-1 rounded-full bg-active px-1.5 py-0.5 text-meta font-medium text-green"
                          title={[
                            oauthByName[s.name]?.shared
                              ? `Workspace grant${oauthByName[s.name]!.shared!.connectedBy ? ` (by ${oauthByName[s.name]!.shared!.connectedBy})` : ""}`
                              : null,
                            oauthByName[s.name]!.users.length
                              ? `Personal: ${oauthByName[s.name]!.users.join(", ")}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          OAuth
                          {oauthByName[s.name]?.shared ? " · workspace" : ""}
                          {oauthByName[s.name]!.users.length
                            ? ` · ${oauthByName[s.name]!.users.join(", ")}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-label text-dim">
                      {MCP_BLURBS[s.name] || "MCP server"}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-meta text-faint">
                      <span className="rounded bg-active px-1.5 py-px">{s.transport}</span>
                      <span className="truncate" title={s.target}>{s.target}</span>
                    </div>
                    {meta.bad && s.detail && (
                      <div className="mt-1 truncate text-meta text-red" title={s.detail}>
                        {s.detail}
                      </div>
                    )}
                  </div>
                  <StatusChip label={meta.label} dot={meta.dot} />
                  <Menu.Root>
                    <Menu.Trigger
                      className={cn(
                        rowMenuTriggerClasses,
                        "opacity-0 transition-[color,opacity,background] group-hover:opacity-100 data-[popup-open]:opacity-100",
                      )}
                      aria-label={`Manage ${s.name}`}
                    >
                      <IconDotsHorizontal size={18} />
                    </Menu.Trigger>
                    <Menu.Popup align="end" sideOffset={4}>
                      {(s.transport === "http" || oauthByName[s.name]?.capable) && (
                        <>
                          <Menu.Item onClick={() => handleOauthConnect(s, "shared")}>
                            <IconPlus size={16} className="text-faint" />
                            {oauthByName[s.name]?.shared
                              ? "Reconnect (workspace)"
                              : "Connect (workspace)"}
                          </Menu.Item>
                          <Menu.Item onClick={() => handleOauthConnect(s, "me")}>
                            <IconPlus size={16} className="text-faint" />
                            Connect my account
                          </Menu.Item>
                          {(oauthByName[s.name]?.shared ||
                            oauthByName[s.name]?.users.length) ? (
                            <Menu.Item
                              onClick={() =>
                                handleOauthDisconnect(
                                  s,
                                  oauthByName[s.name]?.shared ? "shared" : "me",
                                )
                              }
                            >
                              <IconTrash size={16} className="text-faint" />
                              Disconnect OAuth
                            </Menu.Item>
                          ) : null}
                          <Menu.Separator />
                        </>
                      )}
                      <Menu.Item onClick={() => handleRestrict(s)}>
                        <IconSliders size={16} className="text-faint" />
                        {restricted ? "Edit access" : "Restrict access"}
                      </Menu.Item>
                      <Menu.Item
                        onClick={() => handleRemove(s.name)}
                        className="text-red data-[highlighted]:bg-red-soft"
                      >
                        <IconTrash size={16} />
                        Remove server
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Root>
                </div>
              );
            })}
          </SettingCard>

          <GithubAccounts />

          <CodeStorageCard />

          <ProjectsSection />

          <PlainRouter />
        </>
      )}
    </SettingsPanel>
  );
}

interface GithubAuthData {
  enabled: boolean;
  clientIdConfigured: boolean;
  /** A client id resolves (shipped app, env, or config) — connect is on offer
   *  even when the sign-in gate (webAuthRequired) is off. */
  connectAvailable: boolean;
  /** Where that App client id came from, so the blocked-PAT note can name the
   *  exact thing to unset. null when no App is configured. */
  appConfigSource?: "env" | "config" | null;
  /** The workspace is behind GitHub sign-in (operator mode). False = simple
   *  mode: one user, no session, the single connected account is the identity. */
  webAuthRequired: boolean;
  /** github.com/apps/<slug>/installations/new, or null until the app slug ships. */
  appInstallUrl: string | null;
  /** Captured install/app-setup intent: the org the App is owned by, so the
   *  wizard prefills the org owner. null for a single-user install. */
  appOrg?: string | null;
  /** Connecting should also turn on per-user sign-in (set at install with an
   *  org). Inert until the connect handler consumes it. */
  authOnConnect?: boolean;
  /** Simple mode: the single connected login, if exactly one. */
  soleLogin?: string | null;
  accounts: { login: string; name?: string; connectedAt: string; scopes?: string }[];
  team: {
    name: string;
    github: string;
    connected: boolean;
    /** Connected once, but GitHub has since revoked the renewal — reconnecting
     *  is the only fix, so the row says so instead of reading "Connected". */
    needsReconnect?: boolean;
    canManage: boolean;
  }[];
}

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/**
 * GitHub user auth — opt-in per-user tokens so interactive sessions open PRs
 * as the actual session owner instead of the bot. Connect runs GitHub's
 * device flow: show a code, the person enters it on github.com, we poll until
 * GitHub hands over their token (stored server-side, never shown here).
 */
// The create-app form on GitHub can be pre-filled with URL query parameters
// (docs.github.com/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
// `device_flow_enabled` is undocumented but pre-ticks the Enable Device Flow
// box — so the only thing left to do by hand is generate a client secret. It
// is treated as best-effort: the wizard still asks the user to confirm Device
// Flow is on, in case GitHub ever drops the param. GitHub ignores unknown
// params, so this can only under-fill, never error.
// Blank org creates the app under the signed-in personal account; an org login
// creates it under that organization (so the org owns it and it can reach org
// repos). Same query params either way.
function buildGithubAppCreateUrl(name: string, org: string): string {
  const params = new URLSearchParams({
    name,
    url: "http://localhost:3850",
    public: "false",
    webhook_active: "false",
    contents: "write",
    pull_requests: "write",
    members: "read",
    metadata: "read",
    device_flow_enabled: "true",
  }).toString();
  const base = org.trim()
    ? `https://github.com/organizations/${encodeURIComponent(org.trim())}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `${base}?${params}`;
}

// GitHub derives the app slug from its name: lowercased, every run of
// non-alphanumerics collapsed to one hyphen. Previewed so the user recognises
// their slug on the settings page before it exists.
function deriveGithubAppSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// App names are unique across all of GitHub, so a bare "Open Session" is almost
// always taken. A short random suffix in parens makes the pre-filled name land
// first try and reads as a deliberate tag rather than a typo; still editable,
// well under GitHub's 34-char cap, and slugifies to open-session-<suffix>.
function generateGithubAppName(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `Open Session (${suffix})`;
}

function WizardCheck({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-supporting leading-snug text-dim">
      <span className="mt-[3px] shrink-0 text-green">✓</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Guided setup for a bring-your-own GitHub App: create it on GitHub (form
 * pre-filled), paste its id/slug/secret, install it on the repos you pick, then
 * connect. It lives outside the card so saving the client id — which re-renders
 * the card from "no app" to "app configured" — doesn't unmount it mid-flow.
 */
function GithubAppWizard({
  open,
  onOpenChange,
  clientId,
  setClientId,
  slug,
  setSlug,
  secret,
  setSecret,
  onSaveApp,
  saving,
  configured,
  connected,
  installUrl,
  onConnect,
  error,
  flow,
  onCancelFlow,
  intentOrg,
  onClearIntent,
  inline = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  setClientId: (v: string) => void;
  slug: string;
  setSlug: (v: string) => void;
  secret: string;
  setSecret: (v: string) => void;
  onSaveApp: (appOrg: string) => void;
  saving: boolean;
  configured: boolean;
  connected: boolean;
  installUrl: string | null;
  onConnect: () => void;
  error: string | null;
  flow: DeviceFlow | null;
  onCancelFlow: () => void;
  /** Org captured at install (config appOrg): prefills the owner and shows the
   *  wizard is finishing sign-in setup. null for a single-user install. */
  intentOrg?: string | null;
  /** Clear the captured org intent (switch the owner back to single-user). */
  onClearIntent: () => void;
  /** Onboarding keeps setup in the page instead of opening a dialog. */
  inline?: boolean;
}) {
  const [step, setStep] = useState(1);
  // A likely-unique app name, minted once per open so the pre-filled name and
  // the slug we preview stay in step.
  const [appName, setAppName] = useState("Open Session");
  // Where the app is created: the person's own account, or an org they name.
  const [appOwner, setAppOwner] = useState<"you" | "org">("you");
  // The org login, used only when appOwner is "org".
  const [appOrg, setAppOrg] = useState("");
  // Opening jumps to where the user actually is (an already-configured app
  // resumes at install, a fresh start begins at create) and mints a fresh name.
  useEffect(() => {
    if (open) {
      setStep(configured ? 3 : 1);
      setAppName(generateGithubAppName());
      // An org install/app-setup prefills the owner and the org login, so the
      // wizard resumes finishing the sign-in setup it was told to do.
      setAppOwner(intentOrg ? "org" : "you");
      setAppOrg(intentOrg ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Saving the client id flips `configured`; carry the user from paste to
  // install without a manual step.
  useEffect(() => {
    if (open && configured && step === 2) setStep(3);
  }, [open, configured, step]);
  // Connected is the finish line — nothing left to guide.
  useEffect(() => {
    if (open && connected) onOpenChange(false);
  }, [open, connected, onOpenChange]);

  // The last step needs no preamble: arriving on it starts the device flow once
  // and drops the user straight on the code. The ref stops a re-render (or
  // strict mode's double invoke) from opening a second flow; leaving the step
  // rearms it, so Back → Next or a retry can start again.
  const connectStartedRef = useRef(false);
  useEffect(() => {
    if (step !== 4) {
      connectStartedRef.current = false;
      return;
    }
    if (!open || connectStartedRef.current) return;
    connectStartedRef.current = true;
    if (!flow) onConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  // Focus each step's primary control as the user arrives on it (and on open).
  const stepFocusRef = useRef<HTMLElement | null>(null);
  const setStepFocus = useCallback((el: HTMLElement | null) => {
    stepFocusRef.current = el;
  }, []);
  useEffect(() => {
    if (open) stepFocusRef.current?.focus();
  }, [open, step]);

  const createUrl = buildGithubAppCreateUrl(appName, appOwner === "org" ? appOrg : "");
  // Creating in an org needs its login to build the URL, so block until it's given.
  const createReady = appOwner === "you" || !!appOrg.trim();
  const previewSlug = deriveGithubAppSlug(appName);
  const canSave = !!clientId.trim() && !!slug.trim() && !!secret.trim();
  const stepMeta = [
    {
      title: "Create the app",
      description:
        appOwner === "org"
          ? `Create one private app under ${appOrg.trim() || "your organization"}.`
          : "Create one private app for this GitHub account.",
    },
    {
      title: "Paste the details",
      description: "Copy the three values from the app settings page.",
    },
    {
      title: "Install on your repos",
      description: "Choose which repositories Open Session can use.",
    },
    {
      title: "Connect",
      description: "Authorize the GitHub account every session will use.",
    },
  ];
  const currentStep = stepMeta[step - 1]!;

  function changeAppOwner(next: "you" | "org") {
    if (next === "you" && intentOrg) {
      if (!confirm("Stays single-user, no sign-in.")) return;
      onClearIntent();
    }
    setAppOwner(next);
  }

  const content = (
    <>
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-supporting text-dim">Create under</span>
              {inline ? (
                <OptionSelect
                  label="Create under"
                  value={appOwner}
                  options={[
                    { value: "you", label: "My GitHub account" },
                    { value: "org", label: "A GitHub organization" },
                  ]}
                  onChange={changeAppOwner}
                />
              ) : (
                <Segmented
                  label="Create under"
                  size="sm"
                  value={appOwner}
                  onValueChange={(next) => changeAppOwner(next as "you" | "org")}
                >
                  <SegmentedOption value="you">You</SegmentedOption>
                  <SegmentedOption value="org">Organization</SegmentedOption>
                </Segmented>
              )}
              {appOwner === "org" && (
                <>
                  <input
                    type="text"
                    className={cn(settingsInputClass, "font-mono")}
                    value={appOrg}
                    onChange={(e) => setAppOrg(e.target.value)}
                    placeholder="my-org"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Organization login"
                  />
                  {!inline && intentOrg && (
                    <div className="text-meta leading-snug text-dim">
                      Finishing sign-in setup for {intentOrg}.
                    </div>
                  )}
                  {!inline && (
                    <div className="text-meta leading-snug text-faint">
                      For a team, create it in your organization so the org owns
                      the app and it can reach org repos. You need permission to
                      create apps in the org.
                    </div>
                  )}
                </>
              )}
            </div>
            {createReady ? (
              <Button
                ref={setStepFocus}
                variant="primary"
                icon={<IconArrowUpRight size={20} />}
                render={<a href={createUrl} target="_blank" rel="noreferrer" />}
              >
                Create app on GitHub
              </Button>
            ) : (
              <Button
                ref={setStepFocus}
                variant="primary"
                disabled
                icon={<IconArrowUpRight size={20} />}
              >
                Create app on GitHub
              </Button>
            )}
            <div className="text-supporting leading-snug text-dim">
              Opens a pre-filled form. On that page:
            </div>
            {/* An annotated screenshot could slot in here, but GitHub's settings
                UI changes, so the text carries the flow and stays correct. */}
            <ul className="flex flex-col gap-2">
              <WizardCheck>
                Confirm <span className="text-fg">Device Flow</span> is checked.
              </WizardCheck>
              <WizardCheck>
                Click <span className="text-fg">Create GitHub App</span>.
              </WizardCheck>
            </ul>
            {!inline && (
              <div className="text-meta leading-snug text-faint">
                Pre-filled: name{" "}
                <span className="font-mono text-dim">{appName}</span>, permissions
                (Contents + Pull requests, read &amp; write; Members, read), private,
                no webhook. Names are unique on GitHub, so tweak it if it's taken.
              </div>
            )}
            <Modal.Footer>
              <button
                type="button"
                className="mr-auto text-supporting text-dim underline hover:text-fg"
                onClick={() => setStep(2)}
              >
                I already have an app
              </button>
              {!inline && (
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => {
                  if (!slug.trim()) setSlug(previewSlug);
                  setStep(2);
                }}
              >
                Next
              </Button>
            </Modal.Footer>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="text-supporting leading-snug text-dim">
              On your new app's settings page:
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-supporting text-fg">Client ID</label>
                <input
                  ref={setStepFocus}
                  type="text"
                  className={cn(settingsInputClass, "font-mono")}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Iv23…"
                  aria-label="GitHub App client ID"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="text-meta leading-snug text-faint">
                  In <span className="text-dim">About</span> at the top: the{" "}
                  <span className="text-dim">Client ID</span>, not the App ID above
                  it.
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-supporting text-fg">App slug</label>
                <input
                  type="text"
                  className={cn(settingsInputClass, "font-mono")}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={previewSlug}
                  aria-label="GitHub App slug"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="text-meta leading-snug text-faint">
                  From the app's URL{" "}
                  <span className="font-mono text-dim">
                    github.com/settings/apps/{previewSlug}
                  </span>
                  . Pre-filled, so fix it only if you renamed the app.
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-supporting text-fg">Client secret</label>
                <input
                  type="password"
                  className={cn(settingsInputClass, "font-mono")}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Client secret"
                  aria-label="GitHub App client secret"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="text-meta leading-snug text-faint">
                  In <span className="text-dim">Client secrets</span>, click{" "}
                  <span className="text-dim">Generate a new client secret</span>, then
                  copy it (shown once). Required.
                </span>
              </div>
            </div>
            <div className="text-meta leading-snug text-faint">
              Ignore GitHub's “generate a private key” banner. Open Session uses
              device flow and doesn't need one.
            </div>
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                className="mr-auto"
              >
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() => onSaveApp(appOwner === "org" ? appOrg.trim() : "")}
                disabled={!canSave || saving}
              >
                {saving ? "Saving…" : "Save and continue"}
              </Button>
            </Modal.Footer>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div className="text-supporting leading-snug text-dim">
              Install the app on the repositories you want to use. Its access
              reaches only the repos you pick here.
            </div>
            {installUrl && (
              <Button
                ref={setStepFocus}
                variant="primary"
                icon={<IconArrowUpRight size={20} />}
                render={<a href={installUrl} target="_blank" rel="noreferrer" />}
              >
                Install on your repositories
              </Button>
            )}
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => setStep(2)}
                className="mr-auto"
              >
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(4)}>
                Next
              </Button>
            </Modal.Footer>
          </div>
        )}

        {step === 4 && (
          <div className="flex flex-col gap-4">
            {appOwner === "org" && (
              <div className="text-supporting leading-snug text-dim">
                This turns on GitHub sign-in for this workspace. You'll be signed
                in as the first admin.
              </div>
            )}
            {flow ? (
              <div className="flex flex-col gap-2.5">
                <div className="text-supporting text-dim">
                  Enter this code at{" "}
                  <span className="font-medium text-fg">
                    {flow.verificationUri.replace(/^https:\/\//, "")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <DeviceCode code={flow.userCode} />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconArrowUpRight size={20} />}
                    render={
                      <a href={flow.verificationUri} target="_blank" rel="noreferrer" />
                    }
                  >
                    Open GitHub
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-supporting text-dim">
                  <PulseDot size={7} />
                  <span>Waiting for GitHub…</span>
                </div>
              </div>
            ) : error ? (
              <InlineAlert onRetry={onConnect} retryLabel="Try again">
                {error}
              </InlineAlert>
            ) : (
              <div className="flex items-center gap-2 text-supporting text-dim">
                <PulseDot size={7} />
                <span>Starting…</span>
              </div>
            )}
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => {
                  if (flow) onCancelFlow();
                  setStep(3);
                }}
                className="mr-auto"
              >
                Back
              </Button>
            </Modal.Footer>
          </div>
        )}
    </>
  );

  if (inline && !open) return null;

  if (inline) {
    return (
      <div className="mt-3 grid grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] items-start gap-3 phone:grid-cols-1">
        <div className="px-2 py-4 phone:px-1 phone:pb-0">
          <div className="text-meta font-semibold text-faint">Step {step} of 4</div>
          <h2 className="m-0 mt-1 text-section-title font-title tracking-[-0.02em] text-fg">
            {currentStep.title}
          </h2>
          <p className="m-0 mt-2 max-w-[28ch] text-supporting leading-relaxed text-dim">
            {currentStep.description}
          </p>
        </div>
        <SettingsSection className="p-4">{content}</SettingsSection>
      </div>
    );
  }

  return (
    <Modal.Root open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <Modal.Content widthClassName="max-w-[34rem]" initialFocus={stepFocusRef}>
        <Modal.Header
          title="Set up a GitHub App"
          description={`Step ${step} of 4 · ${currentStep.title}`}
        />
        {content}
      </Modal.Content>
    </Modal.Root>
  );
}

/** `personal`: only the signed-in user's own row (the Account page);
 *  default shows the whole team roster (admin overview). */
export function GithubAccounts({
  personal = false,
  onboarding = false,
  onChanged,
}: {
  personal?: boolean;
  onboarding?: boolean;
  onChanged?: () => void;
} = {}) {
  const [data, setData] = useState<GithubAuthData | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [flowState, setFlowState] = useState<"idle" | "starting" | "waiting">("idle");
  const [error, setError] = useState<string | null>(null);
  // Simple-mode "bring your own GitHub App" form: client id + slug (+ secret)
  // written to config.json, so the device flow lights up with no env var and no
  // restart.
  const [appClientId, setAppClientId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [savingApp, setSavingApp] = useState(false);
  // The guided "create your app on GitHub, then paste + install + connect"
  // wizard, launched from the App option below.
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github`);
      if (res.ok) setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the device flow until GitHub reports authorized / expired.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/connections/github/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: flow.deviceCode }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (body.status === "ok") {
          setFlow(null);
          setFlowState("idle");
          // authEnabled: this connect flipped the workspace into sign-in mode and
          // the browser now holds the session cookie. A full reload re-runs the
          // app's auth bootstrap so every panel reflects operator mode, rather
          // than patching one card's state.
          if (body.authEnabled) {
            window.location.reload();
            return;
          }
          load();
          onChanged?.();
          return;
        }
        if (body.status === "slow_down") intervalMs = Math.max(body.interval, 5) * 1000;
        if (body.status === "error") {
          setError(body.error);
          setFlow(null);
          setFlowState("idle");
          return;
        }
      } catch {}
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, load, onChanged]);

  async function startConnect() {
    setError(null);
    setFlowState("starting");
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github/device`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setFlow(body);
      setFlowState("waiting");
    } catch (e: any) {
      setError(e.message);
      setFlowState("idle");
    }
  }

  async function saveApp(appOrg: string) {
    const clientId = appClientId.trim();
    const slug = appSlug.trim();
    const secret = appSecret.trim();
    // The secret is required: the device-flow token expires and is refreshed
    // with it, so without one the connection would stop after ~8h.
    if (!clientId || !slug || !secret) return;
    setError(null);
    setSavingApp(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github/app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An org owner also records the sign-in intent server-side; a blank org
        // is a personal, single-user App.
        body: JSON.stringify({ clientId, slug, secret, appOrg }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setAppClientId("");
      setAppSlug("");
      setAppSecret("");
      // getConfig() re-reads on the file change, so the reload shows the App as
      // configured and switches the card to its device-flow connect.
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingApp(false);
    }
  }

  async function removeApp() {
    if (
      !confirm(
        "Remove the GitHub App configuration? You'll need to set up an app again before you can connect GitHub.",
      )
    )
      return;
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github/app`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    }
  }

  // Switching the wizard owner back to "You" clears the captured org intent
  // (appOrg + authOnConnect) so a later connect stays single-user. The DELETE
  // /app route clears both; at intent stage there are no App keys yet to remove.
  async function clearOrgIntent() {
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github/app`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed: ${res.status}`);
      }
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function disconnect(login: string) {
    if (!confirm(`Disconnect @${login}? Your GitHub actions will be unavailable until you reconnect.`)) return;
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/github/account/${encodeURIComponent(login)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (!data) return null;

  // The device-flow well and the just-connected note render the same in both
  // the operator roster and the simple-mode card, so they're built once here.
  const deviceFlowWell = flow ? (
    // A well, not a sentence: the code, the link and the status used to run
    // together on one line that overflowed the card on anything narrower than a
    // desktop. Three short stacked lines — what to do, the two controls, what
    // we're waiting for — never wrap badly and let the code be the thing the eye
    // lands on.
    <div className="flex flex-col gap-2.5 px-5 py-3.5">
      <div className="text-supporting text-dim">
        Enter this code at{" "}
        <span className="font-medium text-fg">
          {flow.verificationUri.replace(/^https:\/\//, "")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <DeviceCode code={flow.userCode} />
        <Button
          size="sm"
          variant="primary"
          icon={<IconArrowUpRight size={20} />}
          render={<a href={flow.verificationUri} target="_blank" rel="noreferrer" />}
        >
          Open GitHub
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-supporting text-dim">
        {/* Dot and status are one item: as two siblings of a wrapping row, a
            phone breaks between them and leaves the dot orphaned on its own
            line. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <PulseDot size={7} />
          <span className="min-w-0">
            Waiting for GitHub. Sign in as the account you want to connect.
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            setFlow(null);
            setFlowState("idle");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  // ── Simple mode ──
  // No web sign-in, so no roster and no authUser: the card is one shared account
  // (the install's single user), and every session acts as it. Connect is a
  // GitHub App device flow, available once an app's client id is configured
  // (data.connectAvailable) via the setup wizard or an env var. The operator
  // roster below is untouched.
  if (!data.webAuthRequired) {
    const account = data.accounts[0];
    const connected = !!account;
    return (
      <>
        {!onboarding && <SectionHeading>GitHub</SectionHeading>}
        {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
        <SettingCard>
          <SettingRow className="items-start gap-x-3">
            {connected ? (
              <span className="flex size-[30px] shrink-0 items-center justify-center">
                <UserAvatar
                  name={account.name || account.login}
                  login={account.login}
                  size={28}
                />
              </span>
            ) : (
              <IconTile name="github" size={30} />
            )}
            <SettingRowText>
              <SettingRowTitle className="truncate">
                {connected ? account.name || account.login : "GitHub"}
                {connected && (
                  <span className="ml-2 text-label font-normal text-faint">
                    @{account.login}
                  </span>
                )}
              </SettingRowTitle>
              <SettingRowDescription className="leading-snug">
                {connected
                  ? `All sessions clone and open pull requests as @${account.login}.`
                  : "Connect a GitHub App to clone your private repositories and open pull requests."}
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl className="flex items-center gap-3">
              <StatusChip
                label={connected ? "Connected" : "Not connected"}
                dot={
                  connected
                    ? "var(--green)"
                    : "var(--line-strong, var(--text-faint))"
                }
              />
              {connected && (
                <Menu.Root>
                  <Menu.Trigger
                    className={rowMenuTriggerClasses}
                    aria-label={`Manage @${account.login}`}
                  >
                    <IconDotsHorizontal size={18} />
                  </Menu.Trigger>
                  <Menu.Popup align="end" sideOffset={4}>
                    {/* Reconnect re-runs the device flow, which exists only with
                        a configured App. */}
                    {data.connectAvailable && (
                      <Menu.Item onClick={startConnect} disabled={flowState !== "idle"}>
                        <IconPlug size={16} className="text-faint" />
                        Reconnect
                      </Menu.Item>
                    )}
                    <Menu.Item
                      onClick={() => disconnect(account.login)}
                      className="text-red data-[highlighted]:bg-red-soft"
                    >
                      <IconTrash size={16} />
                      Disconnect
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Root>
              )}
            </SettingRowControl>
          </SettingRow>

          {/* Not connected: the GitHub App device flow. The connect button
              appears once an app client id is configured (data.connectAvailable,
              set by the wizard or an env var); before that the setup wizard is
              the entry point. */}
          {!onboarding && !connected &&
            (data.connectAvailable
              ? flowState !== "waiting" && (
                  <div className="flex flex-col gap-2.5 px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Button
                        variant="primary"
                        onClick={startConnect}
                        disabled={flowState !== "idle"}
                      >
                        {flowState === "starting" ? "Starting…" : "Connect GitHub App"}
                      </Button>
                      {data.appInstallUrl && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<IconArrowUpRight size={20} />}
                          render={
                            <a
                              href={data.appInstallUrl}
                              target="_blank"
                              rel="noreferrer"
                            />
                          }
                        >
                          Install on your repositories
                        </Button>
                      )}
                    </div>
                    <div className="text-meta leading-snug text-faint">
                      Authorize with a one-time code. No sign-in here, so every
                      session shares the connected account.
                    </div>
                    {/* A config-set app can be cleared live; an env-set one only
                        gets named, since it needs a restart to change. */}
                    {data.appConfigSource === "config" ? (
                      <button
                        type="button"
                        className="self-start text-meta text-dim underline hover:text-fg"
                        onClick={removeApp}
                      >
                        Remove app
                      </button>
                    ) : (
                      <div className="text-meta leading-snug text-faint">
                        Set via{" "}
                        <code className="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.92em] text-dim">
                          OPENSESSION_GITHUB_CLIENT_ID
                        </code>
                        . Unset and restart to change.
                      </div>
                    )}
                  </div>
                )
              : (
                  <div className="flex flex-col gap-4 px-5 py-3.5">
                    <div className="text-meta leading-snug text-faint">
                      No sign-in here, so every session shares one GitHub account.
                      Turn on GitHub sign-in for per-person accounts.
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="text-label font-medium text-fg">GitHub App</div>
                      <div className="text-meta leading-snug text-faint">
                        Install your own app on the repos you choose, then authorize
                        with a one-time code.
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Button variant="primary" onClick={() => setWizardOpen(true)}>
                          Set up GitHub App
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}

          {!onboarding && deviceFlowWell}

          {/* A configured App's user-to-server token reaches only repos the App
              is installed on, so managing the install is ongoing. A quiet link
              once connected, not a pending step. */}
          {connected && data.appInstallUrl && (
            <div className="px-5 py-3.5">
              <a
                href={data.appInstallUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-meta text-dim underline hover:text-fg"
              >
                Manage which repositories the app can access
                <IconArrowUpRight size={14} />
              </a>
            </div>
          )}
        </SettingCard>
        {/* Rendered outside the card so it survives the card re-rendering from
            "no app" to "app configured" the moment the client id is saved. */}
        <GithubAppWizard
          open={onboarding ? !connected : wizardOpen}
          onOpenChange={setWizardOpen}
          clientId={appClientId}
          setClientId={setAppClientId}
          slug={appSlug}
          setSlug={setAppSlug}
          secret={appSecret}
          setSecret={setAppSecret}
          onSaveApp={saveApp}
          saving={savingApp}
          configured={data.connectAvailable}
          connected={connected}
          installUrl={data.appInstallUrl}
          onConnect={startConnect}
          error={error}
          flow={flow}
          onCancelFlow={() => {
            setFlow(null);
            setFlowState("idle");
          }}
          intentOrg={data.appOrg}
          onClearIntent={clearOrgIntent}
          inline={onboarding}
        />
      </>
    );
  }

  const active = data.enabled && data.clientIdConfigured;
  // The only account this card can hold is your own. GitHub's device flow is
  // rejected unless the login that authorizes matches the signed-in user, so
  // once you are connected there is nothing left to connect. A button that
  // stays put reads as "add another account", which is not on offer.
  const own = data.team.find((m) => m.canManage);
  const needsReconnect = !!own?.needsReconnect;
  const showConnect = !own?.connected || needsReconnect;
  const ownAccount = own
    ? data.accounts.find((a) => a.login.toLowerCase() === own.github.toLowerCase())
    : undefined;
  // Personal view is one row, not a brand row plus a roster of one: with a
  // single possible account the second row only ever repeated the first.
  // Unconnected it is the tool ("GitHub", using the bot); connected it is the
  // account, so the thing you check at a glance is whose name is on your PRs.
  const signedIn = personal && !!own && active && own.connected;

  return (
    <>
      {!onboarding && (
        <SectionHeading>{personal ? "GitHub" : "GitHub accounts"}</SectionHeading>
      )}
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingCard>
        {/* The shared row primitives, not a local flex row: their `flex-wrap`
            plus the text column's min width is what drops the chip and button
            to their own line on a phone instead of squeezing the description
            into a one-word column. The admin row is top-aligned because its
            description runs several lines; the compact personal row stays
            centered with its button. */}
        <SettingRow className={cn("gap-x-3", !personal && "items-start")}>
          {signedIn ? (
            // Same 30px slot as the brand tile, so the row's text column does
            // not shift when the tile gives way to the avatar.
            <span className="flex size-[30px] shrink-0 items-center justify-center">
              <UserAvatar name={own!.name} login={own!.github} size={28} />
            </span>
          ) : (
            <IconTile name="github" size={30} />
          )}
          <SettingRowText>
            <SettingRowTitle className={cn(personal && "truncate")}>
              {signedIn ? own!.name : personal ? "GitHub" : "Per-user GitHub auth"}
              {signedIn && (
                <span className="ml-2 text-label font-normal text-faint">@{own!.github}</span>
              )}
            </SettingRowTitle>
            {!personal && (
              <SettingRowDescription className="leading-snug">
                {active
                  ? "Interactive sessions of a connected teammate open PRs as their own GitHub account. Everyone else (and all automations) keeps the bot."
                  : "Off. Sessions open PRs as the bot account. Opt in via config: integrations.github { userPrAuth: true, oauthClientId } in ~/.opensession/config.json."}
              </SettingRowDescription>
            )}
            {personal && active && (
              <SettingRowDescription className="text-meta text-faint">
                {signedIn && ownAccount
                  ? `since ${new Date(ownAccount.connectedAt).toLocaleDateString()}`
                  : signedIn
                    ? "Sessions open PRs as you"
                    : "Using the workspace bot"}
              </SettingRowDescription>
            )}
          </SettingRowText>
          <SettingRowControl className="flex items-center gap-3">
            {/* Personal: the chip reports YOUR connection, and an unconnected
                row says so with its Connect button alone, the way every tool
                row above it does. The admin row reports the workspace switch. */}
            {personal ? (
              (signedIn || !active) && (
                <StatusChip
                  label={
                    !active
                      ? data.enabled
                        ? "Missing client id"
                        : "Disabled"
                      : needsReconnect
                        ? "Reconnect needed"
                        : "Connected"
                  }
                  dot={
                    !active
                      ? "var(--yellow)"
                      : needsReconnect
                        ? "var(--red)"
                        : "var(--green)"
                  }
                />
              )
            ) : (
              <StatusChip
                label={active ? "Enabled" : data.enabled ? "Missing client id" : "Disabled"}
                dot={active ? "var(--green)" : "var(--yellow)"}
              />
            )}
            {active && showConnect && flowState !== "waiting" && (
              <Button
                size="sm"
                onClick={startConnect}
                disabled={flowState === "starting"}
              >
                {flowState === "starting"
                  ? "Starting…"
                  : needsReconnect
                    ? "Reconnect"
                    : personal
                      ? "Connect"
                      : "Connect account"}
              </Button>
            )}
            {signedIn && (
              // Reconnect lives here rather than as a second button: a healthy
              // row has nothing to press, but re-authorizing has to stay
              // reachable for the day the token misbehaves without GitHub
              // having told us yet.
              <Menu.Root>
                <Menu.Trigger
                  className={rowMenuTriggerClasses}
                  aria-label={`Manage @${own!.github}`}
                >
                  <IconDotsHorizontal size={18} />
                </Menu.Trigger>
                <Menu.Popup align="end" sideOffset={4}>
                  <Menu.Item onClick={startConnect} disabled={flowState !== "idle"}>
                    <IconPlug size={16} className="text-faint" />
                    Reconnect
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => disconnect(own!.github)}
                    className="text-red data-[highlighted]:bg-red-soft"
                  >
                    <IconTrash size={16} />
                    Disconnect
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Root>
            )}
          </SettingRowControl>
        </SettingRow>

        {deviceFlowWell}

        {active &&
          !personal &&
          data.team.map((m) => {
            const account = data.accounts.find(
              (a) => a.login.toLowerCase() === m.github.toLowerCase(),
            );
            return (
              <SettingRow key={m.github} className="gap-x-3 py-3">
                {/* Keep the smaller settings-avatar step inside the same slot
                    as the GitHub tile so every row's text stays aligned. */}
                <span className="flex size-[30px] shrink-0 items-center justify-center">
                  <UserAvatar name={m.name} login={m.github} size={28} />
                </span>
                <SettingRowText>
                  <SettingRowTitle className="truncate">
                    {m.name}
                    <span className="ml-2 text-label font-normal text-faint">@{m.github}</span>
                  </SettingRowTitle>
                  {/* Under the name rather than beside it: as a third column it
                      had nothing to shrink into on a phone and overlapped the
                      name it belongs to. */}
                  {account && (
                    <SettingRowDescription className="text-meta text-faint">
                      since {new Date(account.connectedAt).toLocaleDateString()}
                    </SettingRowDescription>
                  )}
                </SettingRowText>
                <SettingRowControl className="flex items-center gap-3">
                  <StatusChip
                    label={
                      m.needsReconnect
                        ? "Reconnect needed"
                        : m.connected
                          ? "Connected"
                          : "Not connected"
                    }
                    dot={
                      m.needsReconnect
                        ? "var(--red)"
                        : m.connected
                          ? "var(--green)"
                          : "var(--line-strong, var(--text-faint))"
                    }
                  />
                  {m.connected && m.canManage && (
                    // Behind the ⋯ rather than beside the chip: a connected row
                    // needs no button of its own, and a neutral "Disconnect"
                    // sitting where an unconnected row shows "Connect" made the
                    // two states look identical.
                    <Menu.Root>
                      <Menu.Trigger
                        className={rowMenuTriggerClasses}
                        aria-label={`Manage @${m.github}`}
                      >
                        <IconDotsHorizontal size={18} />
                      </Menu.Trigger>
                      <Menu.Popup align="end" sideOffset={4}>
                        <Menu.Item
                          onClick={() => disconnect(m.github)}
                          className="text-red data-[highlighted]:bg-red-soft"
                        >
                          <IconTrash size={16} />
                          Disconnect
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Root>
                  )}
                </SettingRowControl>
              </SettingRow>
            );
          })}
      </SettingCard>
      {personal && !onboarding && (
        <SettingsHint>
          {active
            ? "Connect GitHub to open pull requests as yourself in interactive sessions. Automations and unconnected teammates use the workspace bot."
            : "Personal GitHub sign-in is not enabled for this workspace. Pull requests use the workspace bot."}
        </SettingsHint>
      )}
    </>
  );
}

/**
 * code.storage (Pierre) — connect the org + signing key entirely from this
 * card, no config-file editing. Disconnected: org + pasted PKCS8 PEM →
 * POST /api/setup/codestorage/connect. Connected: repo count (or the server's
 * precise error), plus the webhook receiver info the Pierre dashboard needs
 * (path, HMAC secret) and live delivery status from GET status.
 */
function CodeStorageCard() {
  const [status, setStatus] = useState<CodeStorageStatus | null>(null);
  const [org, setOrg] = useState("");
  const [pem, setPem] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchCodeStorageStatus());
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the delivery status live while the card shows the webhook section.
  useEffect(() => {
    if (!status?.configured) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [status?.configured, load]);

  async function connect() {
    setConnecting(true);
    setError(null);
    setNote(null);
    try {
      const res = await connectCodeStorage(org.trim(), pem);
      setPem("");
      setNote(
        `Connected. ${res.repoCount} repo${res.repoCount === 1 ? "" : "s"} visible. Register them under Settings → Setup → Repositories.`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
      await load();
    }
  }

  async function disconnect() {
    if (
      !confirm(
        "Disconnect code.storage? Sessions on code.storage repos lose push/pull until you reconnect. The key file stays on disk.",
      )
    )
      return;
    setError(null);
    try {
      const res = await disconnectCodeStorage();
      setNote(res.note || "Disconnected.");
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  function copy(value: string, which: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    });
  }

  if (!status) return null;
  const connected = status.configured;
  const wh = status.webhook;
  const last = wh?.lastDelivery ?? null;

  return (
    <>
      <SectionHeading>Code Storage: branch-based repo host</SectionHeading>
      {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
      <SettingCard>
        <div className="flex items-center gap-3 px-5 py-3">
          <IconTile name="codestorage" size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-item-title font-medium text-fg">code.storage (Pierre)</div>
            <div className="text-label leading-snug text-dim">
              {!connected
                ? "Host repos on code.storage, where sessions review branch diffs instead of PRs. Paste the org's signing key to connect; nothing else to configure."
                : status.error
                  ? `Configured for org "${status.org}", but the last check failed.`
                  : `Connected to org "${status.org}"${
                      typeof status.repoCount === "number"
                        ? ` · ${status.repoCount} repo${status.repoCount === 1 ? "" : "s"} visible`
                        : ""
                    }. Register repos under Settings → Setup → Repositories.`}
            </div>
          </div>
          <StatusChip
            label={connected ? (status.error ? "Error" : "Connected") : "Not connected"}
            dot={
              connected
                ? status.error
                  ? "var(--red)"
                  : "var(--green)"
                : "var(--line-strong, var(--text-faint))"
            }
          />
          {connected && (
            <Button
              size="sm"
              className="flex-shrink-0 hover:border-red hover:text-red"
              onClick={disconnect}
            >
              Disconnect
            </Button>
          )}
        </div>

        {note && <div className="px-5 py-2.5 text-label text-dim">{note}</div>}

        {!connected ? (
          <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
            <SettingsFormRow>
              <SettingsField>
                Organization
                <input
                  className={settingsInputClass}
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="acme"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label="code.storage organization"
                />
              </SettingsField>
            </SettingsFormRow>
            <SettingsField>
              Private key (PKCS8 PEM, its public half registered with the org in the
              Pierre dashboard)
              <textarea
                className={cn(settingsInputClass, "resize-y font-mono")}
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                rows={5}
                spellCheck={false}
                placeholder={"-----BEGIN PRIVATE KEY-----\n…"}
                aria-label="code.storage private key PEM"
              />
            </SettingsField>
            <div className="flex items-center gap-2.5">
              <Button
                variant="primary"
                disabled={connecting || !org.trim() || !pem.trim()}
                onClick={connect}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
              <span className="text-supporting text-faint">
                The key is stored on this server (mode 0600) and never leaves it.
              </span>
            </div>
          </div>
        ) : (
          <>
            {status.error && (
              <div className="border-t border-line px-5 py-2.5 text-label leading-snug text-red">
                {status.error}
              </div>
            )}
            {wh && (
              <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
                <div className="text-label font-medium text-fg">Webhook receiver</div>
                <div className="flex flex-wrap items-center gap-2 text-label text-dim">
                  <code className="rounded-sm bg-active px-1.5 py-0.5 font-mono text-fg">
                    POST {wh.path}
                  </code>
                  <span>
                    on the webhook server (127.0.0.1:{wh.port}, behind your TLS proxy)
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => copy(wh.path, "path")}>
                    {copied === "path" ? "Copied" : "Copy path"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-label text-dim">
                  <span>Secret</span>
                  <code className="max-w-[340px] truncate rounded-sm bg-active px-1.5 py-0.5 font-mono text-fg">
                    {showSecret ? wh.secret : "••••••••••••••••"}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => setShowSecret((s) => !s)}>
                    {showSecret ? "Hide" : "Reveal"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copy(wh.secret, "secret")}>
                    {copied === "secret" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <div className="text-supporting leading-snug text-faint">
                  Paste your public URL for this path plus the secret into the Pierre
                  dashboard → Webhooks, subscribed to push and repo.sync events.
                </div>
                <div
                  className={cn(
                    "text-meta",
                    last && !last.ok ? "text-red" : "text-faint",
                  )}
                >
                  {!last
                    ? "No verified deliveries received yet."
                    : last.ok
                      ? `Last event: ${last.event}${last.ref ? ` ${last.ref}` : ""}${last.repo ? ` (${last.repo})` : ""}, ${relativeTime(last.at)}`
                      : `Last delivery failed (${last.error}), ${relativeTime(last.at)}`}
                </div>
                {wh.lastRejected && (
                  <div className="text-supporting leading-snug text-red">
                    {wh.rejectedCount} unauthenticated request
                    {wh.rejectedCount === 1 ? "" : "s"} rejected ({wh.lastRejected.error}
                    ), last {relativeTime(wh.lastRejected.at)}. If these are your Pierre
                    deliveries, check that the secret in the dashboard matches; otherwise
                    it's internet noise and verified deliveries above are unaffected.
                  </div>
                )}
                {wh.syncFailures.map((f) => (
                  <div key={f.repo} className="text-meta text-red">
                    Sync failing for {f.repo}: {f.error} ({relativeTime(f.at)})
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SettingCard>
    </>
  );
}

interface ModelInfo {
  id: string;
  provider: "claude" | "codex";
  label: string;
  aliases: string[];
}

/**
 * Plain triage router — the pre-triage classifier that spam-gates new tickets
 * and routes very basic asks (simple refunds, how-do-I) to a cheaper model,
 * keeping Fable for tickets that benefit from real investigation. The prompt
 * is editable here; the JSON output contract is enforced in code.
 */
function PlainRouter() {
  const [cfg, setCfg] = useState<{
    prompt: string;
    isCustom: boolean;
    basicModel: string;
    defaultPrompt: string;
    defaultBasicModel: string;
  } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/connections/plain-router`)
      .then((r) => r.json())
      .then((b) => {
        setCfg(b);
        setDraft(b.prompt);
      })
      .catch(() => {});
    fetch(`${BASE_PATH}/api/models`)
      .then((r) => r.json())
      .then((b) => setModels((b.models || []).filter((m: ModelInfo) => m.provider === "claude")))
      .catch(() => {});
  }, []);

  async function save(patch: { prompt?: string; basicModel?: string }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/plain-router`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setCfg((c) => (c ? { ...c, ...body } : c));
      if ("prompt" in patch) setDraft(body.prompt);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  if (!cfg) return null;
  const dirty = draft !== cfg.prompt;

  return (
    <>
      <SectionHeading>Plain triage router: spam gate and model routing</SectionHeading>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingsSection className="min-w-0 max-w-[720px]">
        <div className="mb-2 text-supporting leading-[1.45] text-dim">
          Every new Plain ticket goes through one cheap Haiku call before triage: spam is skipped
          entirely, a very basic ask (simple refund, how-do-I) runs triage on the model below, and
          everything else runs on the triage automation's own model. Router errors fail open to
          full triage. Applies to the next ticket, with no restart.
        </div>
        <div className="flex min-w-0 items-center gap-2.5 text-meta text-faint">
          <span className="whitespace-nowrap">Model for basic tickets:</span>
          <OptionSelect
            className="min-w-0 flex-1"
            label="Model for basic tickets"
            value={cfg.basicModel}
            disabled={saving}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(basicModel) => save({ basicModel })}
          />
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          spellCheck={false}
          aria-label="Routing prompt"
          className={cn(settingsInputClass, "mt-2 resize-y text-body")}
        />
        <div className="mt-1.5 flex min-w-0 items-center gap-2.5 text-meta text-faint">
          <Button
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => save({ prompt: draft })}
          >
            {saving ? "Saving…" : "Save prompt"}
          </Button>
          <Button
            variant="soft"
            disabled={saving || (!cfg.isCustom && !dirty)}
            onClick={() => save({ prompt: "" })}
          >
            Reset to default
          </Button>
          <span className="min-w-0 truncate whitespace-nowrap">
            {dirty
              ? "Unsaved changes"
              : savedAt
                ? "Saved."
                : cfg.isCustom
                  ? "Custom prompt active"
                  : "Using the built-in default"}
          </span>
        </div>
      </SettingsSection>
    </>
  );
}

function AddMcpForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const envObj: Record<string, string> = {};
      for (const line of env.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) throw new Error(`Env line "${trimmed}" must be KEY=VALUE`);
        envObj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }

      const allowed = allowedUsers.split(",").map((u) => u.trim()).filter(Boolean);

      const res = await fetch(`${BASE_PATH}/api/connections/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
          env: transport === "stdio" ? envObj : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <SettingsForm className="mb-[18px] flex flex-col gap-3.5">
      <SettingsFormTitle>Add MCP server</SettingsFormTitle>

      <SettingsFormRow>
        <SettingsField>
          Name
          <input className={settingsInputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </SettingsField>
        <SettingsField>
          Transport
          <OptionSelect
            label="Transport"
            value={transport}
            options={[
              { value: "http", label: "http · remote MCP endpoint" },
              { value: "stdio", label: "stdio · local command" },
            ]}
            onChange={(next) => setTransport(next as any)}
          />
        </SettingsField>
      </SettingsFormRow>

      {transport === "http" ? (
        <SettingsField>
          URL
          <input
            className={settingsInputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
        </SettingsField>
      ) : (
        <>
          <SettingsFormRow>
            <SettingsField>
              Command
              <input
                className={settingsInputClass}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="~/bin/my-mcp"
              />
            </SettingsField>
            <SettingsField>
              Args (space-separated)
              <input
                className={settingsInputClass}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </SettingsField>
          </SettingsFormRow>
          <SettingsField>
            Env (KEY=VALUE, one per line, stored in mcp-config.json)
            <textarea
              className={cn(settingsInputClass, "resize-y font-mono")}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </SettingsField>
        </>
      )}

      <SettingsField>
        Allowed users (optional, comma-separated, blank for everyone)
        <input
          className={settingsInputClass}
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Alice, Bob"
        />
      </SettingsField>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
