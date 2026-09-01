import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { GITHUB_APP_GRANT_PERMISSIONS } from "../../shared/github-app-permissions";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useRef,
} from "react";
import { Menu } from "../ui/menu";
import { OptionSelect } from "../ui/select";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { DeviceCode } from "../ui/device-code";
import { Modal } from "../ui/modal";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { InlineAlert } from "../ui/state";
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
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { ProjectsSection } from "./ProjectsSection";
import { GithubPrivateKeyField } from "./GithubPrivateKeyField";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import { parseMcpEnvironment } from "../lib/mcp-form";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  itemsCenter: {
    alignItems: "center",
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
  textFg: {
    color: "var(--text)",
  },
  flexShrink0: {
    flexShrink: "0",
  },
  gap1: {
    gap: "4px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  textGreen: {
    color: "var(--green)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  rounded: {
    borderRadius: "var(--radius-xs)",
    cornerShape: "var(--cs)",
  },
  pyPx: {
    paddingBlock: "1px",
  },
  mt1: {
    marginTop: "4px",
  },
  textRed: {
    color: "var(--red)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  mt3px: {
    marginTop: "3px",
  },
  shrink0: {
    flexShrink: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  mrAuto: {
    marginRight: "auto",
  },
  underline: {
    textDecorationLine: "underline",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  beforeInsetX0: {
    "::before": {
      content: '""',
      insetInline: "0 !important",
    },
  },
  h9: {
    height: "calc(4px * 9)",
  },
  bgFg: {
    backgroundColor: "var(--text)",
  },
  textBg: {
    color: "var(--bg)",
  },
  hoverBgFg85: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "color-mix(in oklab, var(--text) 85%, transparent)",
      },
    },
  },
  gapX2: {
    columnGap: "calc(4px * 2)",
  },
  gapY1: {
    rowGap: "4px",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  gapX3: {
    columnGap: "calc(4px * 3)",
  },
  size30px: {
    width: "30px",
    height: "30px",
  },
  ml2: {
    marginLeft: "calc(4px * 2)",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  py35: {
    paddingBlock: "calc(4px * 3.5)",
  },
  selfStart: {
    alignSelf: "flex-start",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  px1: {
    paddingInline: "4px",
  },
  text092em: {
    fontSize: "0.92em",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  mb18px: {
    marginBottom: "18px",
  },
  gap35: {
    gap: "calc(4px * 3.5)",
  },
});

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status:
    | "connected"
    | "ready"
    | "needs-env"
    | "needs-auth"
    | "unreachable"
    | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
}

interface ConnectionsData {
  mcpServers: McpConnection[];
}

const STATUS_META: Record<
  McpConnection["status"],
  { label: string; dot: string; bad?: boolean }
> = {
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
  "apple-build": "Credential-free Swift and unsigned iOS builds",
  "apple-release": "Restricted ad-hoc and TestFlight release tools",
  vercel: "Projects, deployments & logs",
  vero: "Broadcasts and customer journeys",
};

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="10.5"
        width="14"
        height="9"
        rx="2"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
      />
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
      <SectionHeading>MCP servers: tools inside every session</SectionHeading>
      <SettingCardSkeleton rows={5} icon={40} label="Checking connections" />
    </>
  );
}

interface McpOauthStatus {
  shared?: { connectedBy?: string };
  users: string[];
  capable?: boolean;
  manualToken?: boolean;
}

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [tokenConnect, setTokenConnect] = useState<McpConnection | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const next = await request<ConnectionsData>(
        `/connections${force ? "?refresh=1" : ""}`,
        { label: "Could not load connections" },
      );
      setData(next);
    } catch {
      // Keep the last successful snapshot; connection rows expose their own state.
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    document.title = docTitle("Connections");
    void load();
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  const [oauthByName, setOauthByName] = useState<
    Record<string, McpOauthStatus>
  >({});
  const loadOauth = useCallback(async (servers: McpConnection[]) => {
    const entries = await Promise.all(
      servers.map(async (server) => {
        try {
          const status = await request<McpOauthStatus>(
            `/connections/mcp/${encodeURIComponent(server.name)}/oauth`,
            { label: `Could not load ${server.name} OAuth status` },
          );
          return [server.name, status] as const;
        } catch {
          return null;
        }
      }),
    );
    const connected = entries.filter(
      (entry): entry is readonly [string, McpOauthStatus] => entry !== null,
    );
    setOauthByName(Object.fromEntries(connected));
  }, []);
  useEffect(() => {
    if (data?.mcpServers) void loadOauth(data.mcpServers);
  }, [data, loadOauth]);

  async function handleOauthConnect(
    server: McpConnection,
    scope: "shared" | "me",
  ) {
    try {
      const { url } = await request<{ url: string }>(
        `/connections/mcp/${encodeURIComponent(server.name)}/oauth/start`,
        {
          method: "POST",
          body: { scope },
          label: `Could not connect ${server.name}`,
        },
      );
      window.open(url, "_blank", "noopener");
      let polls = 0;
      const timer = setInterval(() => {
        polls += 1;
        if (polls > 24 || !data?.mcpServers) {
          clearInterval(timer);
          return;
        }
        void loadOauth(data.mcpServers);
      }, 5000);
    } catch (cause) {
      setRemoveError(errorMessage(cause, `Could not connect ${server.name}`));
    }
  }

  async function handleOauthDisconnect(
    server: McpConnection,
    scope: "shared" | "me",
  ) {
    try {
      await request(
        `/connections/mcp/${encodeURIComponent(server.name)}/oauth${
          scope === "me" ? "?scope=me" : ""
        }`,
        {
          method: "DELETE",
          label: `Could not disconnect ${server.name}`,
        },
      );
      if (data?.mcpServers) void loadOauth(data.mcpServers);
    } catch (cause) {
      setRemoveError(
        errorMessage(cause, `Could not disconnect ${server.name}`),
      );
    }
  }

  async function handleRemove(name: string) {
    if (
      !confirm(
        `Remove MCP server "${name}"? New sessions will no longer get its tools.`,
      )
    ) {
      return;
    }
    try {
      await request(`/connections/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
        label: `Could not remove ${name}`,
      });
      void load(true);
    } catch (cause) {
      setRemoveError(errorMessage(cause, `Could not remove ${name}`));
    }
  }

  async function handleRestrict(server: McpConnection) {
    const current = (server.allowedUsers || []).join(", ");
    const answer = prompt(
      `Restrict "${server.name}" to these people (comma-separated configured names, e.g. "Alice, Bob").\n` +
        "Leave blank to make it available to everyone.",
      current,
    );
    if (answer === null) return;
    const allowedUsers = answer
      .split(",")
      .map((user) => user.trim())
      .filter(Boolean);
    try {
      await request(`/connections/mcp/${encodeURIComponent(server.name)}`, {
        method: "PUT",
        body: { allowedUsers },
        label: `Could not update ${server.name}`,
      });
      void load(true);
    } catch (cause) {
      setRemoveError(errorMessage(cause, `Could not update ${server.name}`));
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
              icon={
                <IconHistory
                  size={16}
                  className={refreshing ? utilityClassName("animate-spin") : ""}
                />
              }
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
        <InlineAlert onDismiss={() => setRemoveError(null)}>
          {removeError}
        </InlineAlert>
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
          <SectionHeading>
            MCP servers: tools inside every session
          </SectionHeading>
          <SettingCard>
            {data.mcpServers.map((s) => {
              const meta = STATUS_META[s.status];
              const restricted = !!s.allowedUsers?.length;
              return (
                <div
                  key={s.name}
                  {...mergeStylexProps(
                    "group",
                    sx.flex,
                    sx.itemsStart,
                    sx.gap3,
                    sx.px5,
                    sx.py3,
                    sx.transitionColors,
                    sx.hoverBgHover,
                  )}
                >
                  <IconTile name={s.name} />
                  <div {...stylex.props(sx.minW0, sx.flex1)}>
                    <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
                      <span
                        {...stylex.props(
                          sx.truncate,
                          sx.fontMedium,
                          sx.textFg,
                          typography.itemTitle,
                        )}
                      >
                        {displayName(s.name)}
                      </span>
                      {restricted && (
                        <span
                          {...stylex.props(
                            sx.flex,
                            sx.flexShrink0,
                            sx.itemsCenter,
                            sx.gap1,
                            sx.roundedFull,
                            sx.bgActive,
                            sx.px15,
                            sx.py05,
                            sx.fontMedium,
                            sx.textDim,
                            typography.meta,
                          )}
                          title={`Only these people's sessions get this server: ${s.allowedUsers!.join(", ")}`}
                        >
                          <LockIcon /> {s.allowedUsers!.join(", ")}
                        </span>
                      )}
                      {oauthByName[s.name]?.shared ||
                      oauthByName[s.name]?.users.length ? (
                        <span
                          {...stylex.props(
                            sx.flex,
                            sx.flexShrink0,
                            sx.itemsCenter,
                            sx.gap1,
                            sx.roundedFull,
                            sx.bgActive,
                            sx.px15,
                            sx.py05,
                            sx.fontMedium,
                            sx.textGreen,
                            typography.meta,
                          )}
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
                    <div
                      {...stylex.props(
                        sx.truncate,
                        sx.textDim,
                        typography.label,
                      )}
                    >
                      {MCP_BLURBS[s.name] || "MCP server"}
                    </div>
                    <div
                      {...stylex.props(
                        sx.mt05,
                        sx.flex,
                        sx.itemsCenter,
                        sx.gap15,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      <span
                        {...stylex.props(
                          sx.rounded,
                          sx.bgActive,
                          sx.px15,
                          sx.pyPx,
                        )}
                      >
                        {s.transport}
                      </span>
                      <span {...stylex.props(sx.truncate)} title={s.target}>
                        {s.target}
                      </span>
                    </div>
                    {meta.bad && s.detail && (
                      <div
                        {...stylex.props(
                          sx.mt1,
                          sx.truncate,
                          sx.textRed,
                          typography.meta,
                        )}
                        title={s.detail}
                      >
                        {s.detail}
                      </div>
                    )}
                  </div>
                  <StatusChip label={meta.label} dot={meta.dot} />
                  <Menu.Root>
                    <Menu.Trigger
                      className={cn(
                        rowMenuTriggerClasses,
                        utilityClassName(
                          "opacity-0 transition-[color,opacity,background] group-hover:opacity-100 data-[popup-open]:opacity-100",
                        ),
                      )}
                      aria-label={`Manage ${s.name}`}
                    >
                      <IconDotsHorizontal size={18} />
                    </Menu.Trigger>
                    <Menu.Popup align="end" sideOffset={4}>
                      {(s.transport === "http" ||
                        oauthByName[s.name]?.capable) && (
                        <>
                          <Menu.Item
                            onClick={() => handleOauthConnect(s, "shared")}
                          >
                            <IconPlus
                              size={16}
                              className={mergeStylexOverrideClassName(
                                "",
                                sx.textFaint,
                              )}
                            />
                            {oauthByName[s.name]?.shared
                              ? "Reconnect (workspace)"
                              : "Connect (workspace)"}
                          </Menu.Item>
                          <Menu.Item
                            onClick={() => handleOauthConnect(s, "me")}
                          >
                            <IconPlus
                              size={16}
                              className={mergeStylexOverrideClassName(
                                "",
                                sx.textFaint,
                              )}
                            />
                            Connect my account
                          </Menu.Item>
                          {s.transport === "http" &&
                          oauthByName[s.name]?.manualToken ? (
                            <Menu.Item onClick={() => setTokenConnect(s)}>
                              <IconPlus
                                size={16}
                                className={mergeStylexOverrideClassName(
                                  "",
                                  sx.textFaint,
                                )}
                              />
                              Connect with API token
                            </Menu.Item>
                          ) : null}
                          {oauthByName[s.name]?.shared ||
                          oauthByName[s.name]?.users.length ? (
                            <Menu.Item
                              onClick={() =>
                                handleOauthDisconnect(
                                  s,
                                  oauthByName[s.name]?.shared ? "shared" : "me",
                                )
                              }
                            >
                              <IconTrash
                                size={16}
                                className={mergeStylexOverrideClassName(
                                  "",
                                  sx.textFaint,
                                )}
                              />
                              Disconnect OAuth
                            </Menu.Item>
                          ) : null}
                          <Menu.Separator />
                        </>
                      )}
                      <Menu.Item onClick={() => handleRestrict(s)}>
                        <IconSliders
                          size={16}
                          className={mergeStylexOverrideClassName(
                            "",
                            sx.textFaint,
                          )}
                        />
                        {restricted ? "Edit access" : "Restrict access"}
                      </Menu.Item>
                      <Menu.Item
                        onClick={() => handleRemove(s.name)}
                        className={mergeStylexOverrideClassName(
                          "data-[highlighted]:bg-red-soft",
                          sx.textRed,
                        )}
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

          <ProjectsSection />
        </>
      )}
      <ConnectTokenDialog
        server={tokenConnect}
        onClose={() => setTokenConnect(null)}
        onConnected={() => {
          setTokenConnect(null);
          if (data?.mcpServers) void loadOauth(data.mcpServers);
        }}
      />
    </SettingsPanel>
  );
}

interface GithubAuthData {
  enabled: boolean;
  clientIdConfigured: boolean;
  /** A client id resolves (shipped app, env, or config) — connect is on offer
   *  even when the sign-in gate (webAuthRequired) is off. */
  connectAvailable: boolean;
  /** Where that App client id came from, so config controls can name the
   *  exact thing to unset. null when no App is configured. */
  appConfigSource?: "env" | "config" | null;
  /** The workspace is behind GitHub sign-in (operator mode). False = simple
   *  mode: one user, no session, the single connected account is the identity. */
  webAuthRequired: boolean;
  /** github.com/apps/<slug>/installations/new, or null until the app slug ships. */
  appInstallUrl: string | null;
  /** Current public ingress origin. Empty means callbacks remain private-only. */
  webhookBaseUrl: string;
  /** Captured install/app-setup intent: the org the App is owned by, so the
   *  wizard prefills the org owner. null for a single-user install. */
  appOrg?: string | null;
  /** Connecting should also turn on per-user sign-in. Inert until the connect
   *  handler consumes it, so setup cannot lock the operator out. */
  authOnConnect?: boolean;
  /** Simple mode: the single connected login, if exactly one. */
  soleLogin?: string | null;
  accounts: {
    login: string;
    name?: string;
    connectedAt: string;
    scopes?: string;
  }[];
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

const PERSONAL_GITHUB_CONNECT_INTENT = "opensession:personal-github-connect";

/** Carry the main onboarding card's sign-in action across the step boundary.
 * The dedicated account step consumes this once its connection data arrives. */
export function queuePersonalGithubConnect() {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(PERSONAL_GITHUB_CONNECT_INTENT, "1");
  }
}

/**
 * GitHub user auth — opt-in per-user tokens so interactive sessions open PRs
 * as the actual session owner instead of the bot. Connect runs GitHub's
 * device flow: show a code, the person enters it on github.com, we poll until
 * GitHub hands over their token (stored server-side, never shown here).
 */
// The create-app form on GitHub can be pre-filled with URL query parameters
// (docs.github.com/apps/sharing-github-apps/registering-a-github-app-using-url-parameters).
// Device Flow is not one of the supported parameters, so the wizard asks the
// user to enable it manually after creating the App.
// Blank org creates the app under the signed-in personal account; an org login
// creates it under that organization (so the org owns it and it can reach org
// repos). Same query params either way.
function buildGithubAppCreateUrl(
  name: string,
  org: string,
  webhookBaseUrl: string,
): string {
  const params = new URLSearchParams({
    name,
    url: "http://localhost:3850",
    public: "false",
    ...(webhookBaseUrl
      ? {
          webhook_url: `${webhookBaseUrl.replace(/\/$/, "")}/github/webhook`,
          webhook_active: "true",
        }
      : {}),
    // The canonical grant set — the same permissions the install tokens mint
    // request, so the App is not born missing `issues` or `checks` (the drift
    // this builder used to have: no issues, no checks).
    ...GITHUB_APP_GRANT_PERMISSIONS,
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
    <li
      {...stylex.props(
        sx.flex,
        sx.itemsStart,
        sx.gap2,
        sx.leadingSnug,
        sx.textDim,
        typography.supporting,
      )}
    >
      <span {...stylex.props(sx.mt3px, sx.shrink0, sx.textGreen)}>✓</span>
      <span {...stylex.props(sx.minW0)}>{children}</span>
    </li>
  );
}

/**
 * Guided setup for a bring-your-own GitHub App: create it on GitHub (form
 * pre-filled), enter its id/slug/secret, upload its key, install it on the repos
 * you pick, then connect. It lives outside the card so saving the client id — which re-renders
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
  privateKey,
  setPrivateKey,
  onSaveApp,
  saving,
  configured,
  connected,
  installUrl,
  webhookBaseUrl,
  onConnect,
  error,
  flow,
  onCancelFlow,
  intentOrg,
  onClearIntent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  setClientId: (v: string) => void;
  slug: string;
  setSlug: (v: string) => void;
  secret: string;
  setSecret: (v: string) => void;
  privateKey: string;
  setPrivateKey: (v: string) => void;
  onSaveApp: (appOrg: string) => void;
  saving: boolean;
  configured: boolean;
  connected: boolean;
  installUrl: string | null;
  webhookBaseUrl: string;
  onConnect: () => void;
  error: string | null;
  flow: DeviceFlow | null;
  onCancelFlow: () => void;
  /** Org captured at install (config appOrg): prefills the App owner. */
  intentOrg?: string | null;
  /** Clear the captured org owner when switching to a personal App. */
  onClearIntent: () => void;
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
  const openReset = useEffectEvent(() => {
    if (open) {
      setStep(configured ? 3 : 1);
      setAppName(generateGithubAppName());
      // An org install/app-setup prefills the owner and the org login, so the
      // wizard resumes finishing the sign-in setup it was told to do.
      setAppOwner(intentOrg ? "org" : "you");
      setAppOrg(intentOrg ?? "");
    }
  });
  useEffect(() => {
    openReset();
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
  const maybeConnect = useEffectEvent(() => {
    if (step !== 4) {
      connectStartedRef.current = false;
      return;
    }
    if (!open || connectStartedRef.current) return;
    connectStartedRef.current = true;
    if (!flow) onConnect();
  });
  useEffect(() => {
    maybeConnect();
  }, [open, step]);

  // Focus each step's primary control as the user arrives on it (and on open).
  const stepFocusRef = useRef<HTMLElement | null>(null);
  const setStepFocus = (el: HTMLElement | null) => {
    stepFocusRef.current = el;
  };
  useEffect(() => {
    if (open) stepFocusRef.current?.focus();
  }, [open, step]);

  const createUrl = buildGithubAppCreateUrl(
    appName,
    appOwner === "org" ? appOrg : "",
    webhookBaseUrl,
  );
  // Creating in an org needs its login to build the URL, so block until it's given.
  const createReady = appOwner === "you" || !!appOrg.trim();
  const previewSlug = deriveGithubAppSlug(appName);
  const canSave = !!clientId.trim() && !!slug.trim() && !!secret.trim();
  const titles = [
    "Create the app",
    "Add the details",
    "Install on your repos",
    "Connect",
  ];

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => !saving && onOpenChange(next)}
    >
      <Modal.Content
        widthClassName={utilityClassName("max-w-[34rem]")}
        initialFocus={stepFocusRef}
      >
        <Modal.Header
          title="Set up a GitHub App"
          description={`Step ${step} of 4 · ${titles[step - 1]}`}
        />

        {step === 1 && (
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
            <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15)}>
              <span {...stylex.props(sx.textDim, typography.supporting)}>
                Create under
              </span>
              <Segmented
                label="Create under"
                size="sm"
                value={appOwner}
                onValueChange={(next) => {
                  // Switching to a personal App drops the captured org owner,
                  // but sign-in is still enabled only after GitHub connects.
                  if (next === "you" && intentOrg) {
                    if (
                      !confirm("Switch the App owner to your personal account?")
                    )
                      return;
                    onClearIntent();
                  }
                  setAppOwner(next as "you" | "org");
                }}
              >
                <SegmentedOption value="you">You</SegmentedOption>
                <SegmentedOption value="org">Organization</SegmentedOption>
              </Segmented>
              {appOwner === "org" && (
                <>
                  <input
                    type="text"
                    className={cn(
                      settingsInputClass,
                      utilityClassName("font-mono"),
                    )}
                    value={appOrg}
                    onChange={(e) => setAppOrg(e.target.value)}
                    placeholder="my-org"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Organization login"
                  />
                  {intentOrg && (
                    <div
                      {...stylex.props(
                        sx.leadingSnug,
                        sx.textDim,
                        typography.meta,
                      )}
                    >
                      Finishing sign-in setup for {intentOrg}.
                    </div>
                  )}
                  <div
                    {...stylex.props(
                      sx.leadingSnug,
                      sx.textFaint,
                      typography.meta,
                    )}
                  >
                    For a team, create it in your organization so the org owns
                    the app and it can reach org repos. You need permission to
                    create apps in the org.
                  </div>
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
            <div
              {...stylex.props(
                sx.leadingSnug,
                sx.textDim,
                typography.supporting,
              )}
            >
              Opens a pre-filled form. On that page:
            </div>
            {/* An annotated screenshot could slot in here, but GitHub's settings
                UI changes, so the text carries the flow and stays correct. */}
            <ul {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
              <WizardCheck>
                Confirm <span {...stylex.props(sx.textFg)}>Device Flow</span> is
                checked.
              </WizardCheck>
              <WizardCheck>
                Click{" "}
                <span {...stylex.props(sx.textFg)}>Create GitHub App</span>.
              </WizardCheck>
            </ul>
            <div
              {...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}
            >
              Pre-filled: name{" "}
              <span {...stylex.props(sx.fontMono, sx.textDim)}>{appName}</span>,
              permissions (Actions, Checks, statuses, and Deployments read;
              Contents, Issues, and Pull requests write; Members read), and
              private. Names are unique on GitHub, so tweak it if it's taken.
            </div>
            <Modal.Footer>
              <button
                type="button"
                {...stylex.props(
                  sx.mrAuto,
                  sx.textDim,
                  sx.underline,
                  sx.hoverTextFg,
                  typography.supporting,
                )}
                onClick={() => setStep(2)}
              >
                I already have an app
              </button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
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
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
            <div
              {...stylex.props(
                sx.leadingSnug,
                sx.textDim,
                typography.supporting,
              )}
            >
              On your new app's settings page:
            </div>
            <div {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}>
              <div {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
                <label {...stylex.props(sx.textFg, typography.supporting)}>
                  Client ID
                </label>
                <input
                  ref={setStepFocus}
                  type="text"
                  className={cn(
                    settingsInputClass,
                    utilityClassName("font-mono"),
                  )}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Iv23…"
                  aria-label="GitHub App client ID"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span
                  {...stylex.props(
                    sx.leadingSnug,
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  In <span {...stylex.props(sx.textDim)}>About</span> at the
                  top: the <span {...stylex.props(sx.textDim)}>Client ID</span>,
                  not the App ID above it.
                </span>
              </div>
              <div {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
                <label {...stylex.props(sx.textFg, typography.supporting)}>
                  App slug
                </label>
                <input
                  type="text"
                  className={cn(
                    settingsInputClass,
                    utilityClassName("font-mono"),
                  )}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={previewSlug}
                  aria-label="GitHub App slug"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span
                  {...stylex.props(
                    sx.leadingSnug,
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  From the app's URL{" "}
                  <span {...stylex.props(sx.fontMono, sx.textDim)}>
                    github.com/settings/apps/{previewSlug}
                  </span>
                  . Pre-filled, so fix it only if you renamed the app.
                </span>
              </div>
              <div {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
                <label {...stylex.props(sx.textFg, typography.supporting)}>
                  Client secret
                </label>
                <input
                  type="password"
                  className={cn(
                    settingsInputClass,
                    utilityClassName("font-mono"),
                  )}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Client secret"
                  aria-label="GitHub App client secret"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span
                  {...stylex.props(
                    sx.leadingSnug,
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  In <span {...stylex.props(sx.textDim)}>Client secrets</span>,
                  click{" "}
                  <span {...stylex.props(sx.textDim)}>
                    Generate a new client secret
                  </span>
                  , then copy it (shown once). Required.
                </span>
              </div>
              <GithubPrivateKeyField
                configured={false}
                required={false}
                saving={saving}
                value={privateKey}
                onChange={setPrivateKey}
                description={
                  <>
                    In <span {...stylex.props(sx.textDim)}>Private keys</span>,
                    click{" "}
                    <span {...stylex.props(sx.textDim)}>
                      Generate a private key
                    </span>
                    , then choose the downloaded .pem file. Lets the bot and PR
                    checks run on the App; leave blank for sign-in only.
                  </>
                }
              />
            </div>
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                className={mergeStylexOverrideClassName("", sx.mrAuto)}
              >
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  onSaveApp(appOwner === "org" ? appOrg.trim() : "")
                }
                disabled={!canSave || saving}
              >
                {saving ? "Saving…" : "Save and continue"}
              </Button>
            </Modal.Footer>
          </div>
        )}

        {step === 3 && (
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
            <div
              {...stylex.props(
                sx.leadingSnug,
                sx.textDim,
                typography.supporting,
              )}
            >
              Install the app on the repositories you want to use. Its access
              reaches only the repos you pick here.
            </div>
            {installUrl && (
              <Button
                ref={setStepFocus}
                variant="primary"
                icon={<IconArrowUpRight size={20} />}
                render={
                  <a href={installUrl} target="_blank" rel="noreferrer" />
                }
              >
                Install on your repositories
              </Button>
            )}
            <Modal.Footer>
              <Button
                variant="ghost"
                onClick={() => setStep(2)}
                className={mergeStylexOverrideClassName("", sx.mrAuto)}
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
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
            {appOwner === "org" && (
              <div
                {...stylex.props(
                  sx.leadingSnug,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                This turns on GitHub sign-in for this workspace. You'll be
                signed in as the first admin.
              </div>
            )}
            {flow ? (
              <div {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
                <div {...stylex.props(sx.textDim, typography.supporting)}>
                  Enter this code at{" "}
                  <span {...stylex.props(sx.fontMedium, sx.textFg)}>
                    {flow.verificationUri.replace(/^https:\/\//, "")}
                  </span>
                </div>
                <div
                  {...stylex.props(
                    sx.flex,
                    sx.flexWrap,
                    sx.itemsCenter,
                    sx.gap25,
                  )}
                >
                  <DeviceCode code={flow.userCode} />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconArrowUpRight size={20} />}
                    render={
                      <a
                        href={flow.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Open GitHub
                  </Button>
                </div>
                <div
                  {...stylex.props(
                    sx.flex,
                    sx.itemsCenter,
                    sx.gap2,
                    sx.textDim,
                    typography.supporting,
                  )}
                >
                  <PulseDot size={7} />
                  <span>
                    Waiting for GitHub. Authorize there, then close that tab.
                  </span>
                </div>
              </div>
            ) : error ? (
              <InlineAlert onRetry={onConnect} retryLabel="Try again">
                {error}
              </InlineAlert>
            ) : (
              <div
                {...stylex.props(
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.textDim,
                  typography.supporting,
                )}
              >
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
                className={mergeStylexOverrideClassName("", sx.mrAuto)}
              >
                Back
              </Button>
            </Modal.Footer>
          </div>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/** `personal`: only the signed-in user's own row (the Account page);
 *  default shows the whole team roster (admin overview). */
export function GithubAccounts({
  personal = false,
  showHeading = true,
  showHint = true,
  loadingFallback = null,
  onConnectRequest,
  onContentSizeChange,
  cardClassName,
  cancelOutside = false,
}: {
  personal?: boolean;
  showHeading?: boolean;
  showHint?: boolean;
  loadingFallback?: React.ReactNode;
  /** Replace the first sign-in action while a parent flow moves the user to a
   * dedicated authorization step. Reconnect actions stay local. */
  onConnectRequest?: () => void;
  /** Notify an embedding modal after async account or device-flow content changes. */
  onContentSizeChange?: () => void;
  cardClassName?: string;
  /** Put device-flow cancellation below the card on focused onboarding steps. */
  cancelOutside?: boolean;
} = {}) {
  const [data, setData] = useState<GithubAuthData | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [flowState, setFlowState] = useState<"idle" | "starting" | "waiting">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // Simple-mode "bring your own GitHub App" form: client id + slug (+ secret)
  // written to config.json, so the device flow lights up with no env var and no
  // restart.
  const [appClientId, setAppClientId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [appPrivateKey, setAppPrivateKey] = useState("");
  const [savingApp, setSavingApp] = useState(false);
  // The guided "create your app on GitHub, then paste + install + connect"
  // wizard, launched from the App option below.
  const [wizardOpen, setWizardOpen] = useState(false);
  const queuedConnectStarted = useRef(false);
  const notifyContentSizeChange = useEffectEvent(() => onContentSizeChange?.());

  useEffect(() => {
    notifyContentSizeChange();
  }, [data, flow, flowState, error]);

  const load = useCallback(async () => {
    try {
      setData(
        await request<GithubAuthData>("/connections/github", {
          label: "Could not load GitHub accounts",
        }),
      );
    } catch {
      // Keep the last successful account snapshot during transient refreshes.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await request<
          | { status: "pending" }
          | { status: "slow_down"; interval: number }
          | { status: "ok"; authEnabled?: boolean }
          | { status: "error"; error: string }
        >("/connections/github/device/poll", {
          method: "POST",
          body: { deviceCode: flow.deviceCode },
          label: "Could not check GitHub authorization",
        });
        if (cancelled) return;
        if (result.status === "ok") {
          setFlow(null);
          setFlowState("idle");
          if (result.authEnabled) {
            window.location.reload();
            return;
          }
          void load();
          return;
        }
        if (result.status === "slow_down") {
          intervalMs = Math.max(result.interval, 5) * 1000;
        } else if (result.status === "error") {
          setError(result.error);
          setFlow(null);
          setFlowState("idle");
          return;
        }
      } catch {
        // Authorization polling tolerates transient network failures.
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, load]);

  async function startConnect() {
    setError(null);
    setFlowState("starting");
    try {
      const nextFlow = await request<DeviceFlow>("/connections/github/device", {
        method: "POST",
        label: "Could not start GitHub authorization",
      });
      setFlow(nextFlow);
      setFlowState("waiting");
    } catch (cause) {
      setError(errorMessage(cause, "Could not start GitHub authorization"));
      setFlowState("idle");
    }
  }

  function cancelConnect() {
    setFlow(null);
    setFlowState("idle");
  }

  const startQueuedConnect = useEffectEvent(() => {
    queuedConnectStarted.current = true;
    window.sessionStorage.removeItem(PERSONAL_GITHUB_CONNECT_INTENT);
    void startConnect();
  });
  useEffect(() => {
    // The main onboarding card supplies onConnectRequest and only queues this
    // intent. The dedicated personal step has no override, so it consumes the
    // intent and opens the device-code instructions without asking for a
    // second click on an identical card.
    if (
      !personal ||
      onConnectRequest ||
      !data ||
      queuedConnectStarted.current ||
      window.sessionStorage.getItem(PERSONAL_GITHUB_CONNECT_INTENT) !== "1"
    ) {
      return;
    }
    const own = data.team.find((member) => member.canManage);
    const canStart = data.webAuthRequired
      ? data.enabled &&
        data.clientIdConfigured &&
        (!own?.connected || own.needsReconnect === true)
      : data.connectAvailable && data.accounts.length === 0;
    if (canStart) startQueuedConnect();
    else window.sessionStorage.removeItem(PERSONAL_GITHUB_CONNECT_INTENT);
  }, [data, onConnectRequest, personal]);

  async function saveApp(appOrg: string) {
    const clientId = appClientId.trim();
    const slug = appSlug.trim();
    const secret = appSecret.trim();
    const privateKey = appPrivateKey.trim();
    if (!clientId || !slug || !secret) return;
    setError(null);
    setSavingApp(true);
    try {
      await request("/connections/github/app", {
        method: "POST",
        body: { clientId, slug, secret, appOrg, privateKey },
        label: "Could not save GitHub App",
      });
      setAppClientId("");
      setAppSlug("");
      setAppSecret("");
      setAppPrivateKey("");
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not save GitHub App"));
    }
    setSavingApp(false);
  }

  async function removeApp() {
    if (
      !confirm(
        "Remove the GitHub App configuration? You'll need to set up an app again before you can connect GitHub.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      await request("/connections/github/app", {
        method: "DELETE",
        label: "Could not remove GitHub App",
      });
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not remove GitHub App"));
    }
  }

  async function clearOrgIntent() {
    try {
      await request("/connections/github/app", {
        method: "DELETE",
        label: "Could not clear GitHub organization setup",
      });
      void load();
    } catch (cause) {
      setError(
        errorMessage(cause, "Could not clear GitHub organization setup"),
      );
    }
  }

  async function disconnect(login: string) {
    if (
      !confirm(
        `Disconnect @${login}? Your GitHub actions will be unavailable until you reconnect.`,
      )
    ) {
      return;
    }
    try {
      await request(
        `/connections/github/account/${encodeURIComponent(login)}`,
        { method: "DELETE", label: `Could not disconnect @${login}` },
      );
      void load();
    } catch (cause) {
      setError(errorMessage(cause, `Could not disconnect @${login}`));
    }
  }

  if (!data) return loadingFallback;

  // The device-flow well and the just-connected note render the same in both
  // the operator roster and the simple-mode card, so they're built once here.
  const deviceFlowWell = flow ? (
    // A well, not a sentence: the code, the link and the status used to run
    // together on one line that overflowed the card on anything narrower than a
    // desktop. Three short stacked lines — what to do, the two controls, what
    // we're waiting for — never wrap badly and let the code be the thing the eye
    // lands on.
    <div
      {...stylex.props(
        sx.flex,
        sx.flexCol,
        sx.gap4,
        sx.px5,
        sx.py4,
        sx.beforeInsetX0,
      )}
    >
      <div {...stylex.props(sx.textDim, typography.supporting)}>
        Enter this code at{" "}
        <span {...stylex.props(sx.fontMedium, sx.textFg)}>
          {flow.verificationUri.replace(/^https:\/\//, "")}
        </span>
      </div>
      <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap25)}>
        <DeviceCode
          code={flow.userCode}
          className={mergeStylexOverrideClassName("", sx.h9)}
        />
        <Button
          size="md"
          variant="primary"
          className={mergeStylexOverrideClassName(
            "",
            sx.h9,
            sx.bgFg,
            sx.textBg,
            sx.hoverBgFg85,
          )}
          icon={<IconArrowUpRight size={20} />}
          render={
            <a href={flow.verificationUri} target="_blank" rel="noreferrer" />
          }
        >
          Open GitHub
        </Button>
      </div>
      <div
        {...stylex.props(
          sx.flex,
          sx.flexWrap,
          sx.itemsCenter,
          sx.gapX2,
          sx.gapY1,
          sx.textDim,
          typography.supporting,
        )}
      >
        {/* Dot and status are one item: as two siblings of a wrapping row, a
            phone breaks between them and leaves the dot orphaned on its own
            line. */}
        <span
          {...stylex.props(
            sx.flex,
            sx.minW0,
            sx.flex1,
            sx.itemsCenter,
            sx.gap2,
          )}
        >
          <PulseDot size={7} />
          <span {...stylex.props(sx.minW0)}>
            Waiting for GitHub. Authorize there, then close that tab and return
            here.
          </span>
        </span>
        {!cancelOutside && (
          <Button
            size="sm"
            variant="ghost"
            className={mergeStylexOverrideClassName("", sx.mlAuto)}
            onClick={cancelConnect}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  ) : null;
  const outsideCancel =
    cancelOutside && flow ? (
      <div {...stylex.props(sx.mt3, sx.flex, sx.justifyCenter)}>
        <Button size="sm" variant="ghost" onClick={cancelConnect}>
          Cancel
        </Button>
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
        {showHeading && <SectionHeading>GitHub</SectionHeading>}
        {error && (
          <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
        )}
        <SettingCard className={cardClassName}>
          <SettingRow
            className={mergeStylexOverrideClassName(
              "",
              sx.itemsStart,
              sx.gapX3,
            )}
          >
            {connected ? (
              <span
                {...stylex.props(
                  sx.flex,
                  sx.size30px,
                  sx.shrink0,
                  sx.itemsCenter,
                  sx.justifyCenter,
                )}
              >
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
              <SettingRowTitle
                className={mergeStylexOverrideClassName("", sx.truncate)}
              >
                {connected ? account.name || account.login : "GitHub"}
                {connected && (
                  <span
                    {...stylex.props(
                      sx.ml2,
                      sx.fontNormal,
                      sx.textFaint,
                      typography.label,
                    )}
                  >
                    @{account.login}
                  </span>
                )}
              </SettingRowTitle>
              <SettingRowDescription
                className={mergeStylexOverrideClassName("", sx.leadingSnug)}
              >
                {connected
                  ? `All sessions clone and open pull requests as @${account.login}.`
                  : data.connectAvailable
                    ? "Sign in so sessions can clone private repositories and open pull requests as you."
                    : "Set up a GitHub App to access private repositories and open pull requests."}
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl
              className={mergeStylexOverrideClassName(
                "",
                sx.flex,
                sx.itemsCenter,
                sx.gap3,
              )}
            >
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
                      <Menu.Item
                        onClick={startConnect}
                        disabled={flowState !== "idle"}
                      >
                        <IconPlug
                          size={16}
                          className={mergeStylexOverrideClassName(
                            "",
                            sx.textFaint,
                          )}
                        />
                        Reconnect
                      </Menu.Item>
                    )}
                    <Menu.Item
                      onClick={() => disconnect(account.login)}
                      className={mergeStylexOverrideClassName(
                        "data-[highlighted]:bg-red-soft",
                        sx.textRed,
                      )}
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
          {!connected &&
            (data.connectAvailable ? (
              flowState !== "waiting" && (
                <div
                  {...stylex.props(
                    sx.flex,
                    sx.flexCol,
                    sx.gap25,
                    sx.px5,
                    sx.py35,
                  )}
                >
                  <div
                    {...stylex.props(
                      sx.flex,
                      sx.flexWrap,
                      sx.itemsCenter,
                      sx.gap25,
                    )}
                  >
                    <Button
                      variant="primary"
                      onClick={onConnectRequest ?? startConnect}
                      disabled={flowState !== "idle"}
                    >
                      {flowState === "starting"
                        ? "Starting…"
                        : "Sign in with GitHub"}
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
                        Manage repositories
                      </Button>
                    )}
                  </div>
                  <div
                    {...stylex.props(
                      sx.leadingSnug,
                      sx.textFaint,
                      typography.meta,
                    )}
                  >
                    GitHub opens in a new tab. Authorize with the one-time code,
                    then close that tab and return here. Every session shares
                    the connected account.
                  </div>
                  {/* A config-set app can be cleared live; an env-set one only
                        gets named, since it needs a restart to change. */}
                  {data.appConfigSource === "config" ? (
                    <button
                      type="button"
                      {...stylex.props(
                        sx.selfStart,
                        sx.textDim,
                        sx.underline,
                        sx.hoverTextFg,
                        typography.meta,
                      )}
                      onClick={removeApp}
                    >
                      Remove app
                    </button>
                  ) : (
                    <div
                      {...stylex.props(
                        sx.leadingSnug,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      Set via{" "}
                      <code
                        {...stylex.props(
                          sx.roundedSm,
                          sx.bgSurface,
                          sx.px1,
                          sx.py05,
                          sx.fontMono,
                          sx.text092em,
                          sx.textDim,
                        )}
                      >
                        OPENSESSION_GITHUB_CLIENT_ID
                      </code>
                      . Unset and restart to change.
                    </div>
                  )}
                </div>
              )
            ) : (
              <div
                {...stylex.props(sx.flex, sx.flexCol, sx.gap4, sx.px5, sx.py35)}
              >
                <div
                  {...stylex.props(
                    sx.leadingSnug,
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  No sign-in here, so every session shares one GitHub account.
                  Turn on GitHub sign-in for per-person accounts.
                </div>
                <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
                  <div
                    {...stylex.props(
                      sx.fontMedium,
                      sx.textFg,
                      typography.label,
                    )}
                  >
                    GitHub App
                  </div>
                  <div
                    {...stylex.props(
                      sx.leadingSnug,
                      sx.textFaint,
                      typography.meta,
                    )}
                  >
                    Install your own app on the repos you choose, then authorize
                    with a one-time code.
                  </div>
                  <div
                    {...stylex.props(
                      sx.flex,
                      sx.flexWrap,
                      sx.itemsCenter,
                      sx.gap25,
                    )}
                  >
                    <Button
                      variant="primary"
                      onClick={() =>
                        void load().then(() => setWizardOpen(true))
                      }
                    >
                      Set up GitHub App
                    </Button>
                  </div>
                </div>
              </div>
            ))}

          {deviceFlowWell}

          {/* A configured App's user-to-server token reaches only repos the App
              is installed on, so managing the install is ongoing. A quiet link
              once connected, not a pending step. */}
          {connected && data.appInstallUrl && (
            <div {...stylex.props(sx.px5, sx.py35)}>
              <a
                href={data.appInstallUrl}
                target="_blank"
                rel="noreferrer"
                {...stylex.props(
                  sx.inlineFlex,
                  sx.itemsCenter,
                  sx.gap1,
                  sx.textDim,
                  sx.underline,
                  sx.hoverTextFg,
                  typography.meta,
                )}
              >
                Manage which repositories the app can access
                <IconArrowUpRight size={14} />
              </a>
            </div>
          )}
        </SettingCard>
        {outsideCancel}
        {/* Rendered outside the card so it survives the card re-rendering from
            "no app" to "app configured" the moment the client id is saved. */}
        <GithubAppWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          clientId={appClientId}
          setClientId={setAppClientId}
          slug={appSlug}
          setSlug={setAppSlug}
          secret={appSecret}
          setSecret={setAppSecret}
          privateKey={appPrivateKey}
          setPrivateKey={setAppPrivateKey}
          onSaveApp={saveApp}
          saving={savingApp}
          configured={data.connectAvailable}
          connected={connected}
          installUrl={data.appInstallUrl}
          webhookBaseUrl={data.webhookBaseUrl}
          onConnect={startConnect}
          error={error}
          flow={flow}
          onCancelFlow={() => {
            setFlow(null);
            setFlowState("idle");
          }}
          intentOrg={data.appOrg}
          onClearIntent={clearOrgIntent}
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
    ? data.accounts.find(
        (a) => a.login.toLowerCase() === own.github.toLowerCase(),
      )
    : undefined;
  // Personal view is one row, not a brand row plus a roster of one: with a
  // single possible account the second row only ever repeated the first.
  // Unconnected it is the tool ("GitHub", using the bot); connected it is the
  // account, so the thing you check at a glance is whose name is on your PRs.
  const signedIn = personal && !!own && active && own.connected;

  return (
    <>
      {showHeading && (
        <SectionHeading>
          {personal ? "GitHub" : "GitHub accounts"}
        </SectionHeading>
      )}
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingCard className={cardClassName}>
        {/* The shared row primitives, not a local flex row: their `flex-wrap`
            plus the text column's min width is what drops the chip and button
            to their own line on a phone instead of squeezing the description
            into a one-word column. The admin row is top-aligned because its
            description runs several lines; the compact personal row stays
            centered with its button. */}
        <SettingRow
          className={cn(
            utilityClassName("gap-x-3"),
            !personal && utilityClassName("items-start"),
          )}
        >
          {signedIn ? (
            // Same 30px slot as the brand tile, so the row's text column does
            // not shift when the tile gives way to the avatar.
            <span
              {...stylex.props(
                sx.flex,
                sx.size30px,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
              )}
            >
              <UserAvatar name={own!.name} login={own!.github} size={28} />
            </span>
          ) : (
            <IconTile name="github" size={30} />
          )}
          <SettingRowText>
            <SettingRowTitle
              className={cn(personal && utilityClassName("truncate"))}
            >
              {signedIn
                ? own!.name
                : personal
                  ? "GitHub"
                  : "Per-user GitHub auth"}
              {signedIn && (
                <span
                  {...stylex.props(
                    sx.ml2,
                    sx.fontNormal,
                    sx.textFaint,
                    typography.label,
                  )}
                >
                  @{own!.github}
                </span>
              )}
            </SettingRowTitle>
            {!personal && (
              <SettingRowDescription
                className={mergeStylexOverrideClassName("", sx.leadingSnug)}
              >
                {active
                  ? "Interactive sessions of a connected teammate open PRs as their own GitHub account. Trusted GitHub automations use the repository-scoped App credential."
                  : "Off. Interactive sessions use the workspace credential. Configure the GitHub App in Settings → Integrations and the sign-in method in Settings → Authentication."}
              </SettingRowDescription>
            )}
            {personal && active && (
              <SettingRowDescription
                className={mergeStylexOverrideClassName(
                  "",
                  sx.textFaint,
                  typography.meta,
                )}
              >
                {signedIn && ownAccount
                  ? `since ${new Date(ownAccount.connectedAt).toLocaleDateString()}`
                  : signedIn
                    ? "Sessions open PRs as you"
                    : "Using the workspace bot"}
              </SettingRowDescription>
            )}
          </SettingRowText>
          <SettingRowControl
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.itemsCenter,
              sx.gap3,
            )}
          >
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
                label={
                  active
                    ? "Enabled"
                    : data.enabled
                      ? "Missing client id"
                      : "Disabled"
                }
                dot={active ? "var(--green)" : "var(--yellow)"}
              />
            )}
            {active && showConnect && flowState !== "waiting" && (
              <Button
                size="sm"
                onClick={onConnectRequest ?? startConnect}
                disabled={flowState === "starting"}
              >
                {flowState === "starting"
                  ? "Starting…"
                  : needsReconnect
                    ? "Reconnect"
                    : personal
                      ? "Sign in"
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
                  <Menu.Item
                    onClick={startConnect}
                    disabled={flowState !== "idle"}
                  >
                    <IconPlug
                      size={16}
                      className={mergeStylexOverrideClassName("", sx.textFaint)}
                    />
                    Reconnect
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => disconnect(own!.github)}
                    className={mergeStylexOverrideClassName(
                      "data-[highlighted]:bg-red-soft",
                      sx.textRed,
                    )}
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
              <SettingRow
                key={m.github}
                className={mergeStylexOverrideClassName("", sx.gapX3, sx.py3)}
              >
                {/* Keep the smaller settings-avatar step inside the same slot
                    as the GitHub tile so every row's text stays aligned. */}
                <span
                  {...stylex.props(
                    sx.flex,
                    sx.size30px,
                    sx.shrink0,
                    sx.itemsCenter,
                    sx.justifyCenter,
                  )}
                >
                  <UserAvatar name={m.name} login={m.github} size={28} />
                </span>
                <SettingRowText>
                  <SettingRowTitle
                    className={mergeStylexOverrideClassName("", sx.truncate)}
                  >
                    {m.name}
                    <span
                      {...stylex.props(
                        sx.ml2,
                        sx.fontNormal,
                        sx.textFaint,
                        typography.label,
                      )}
                    >
                      @{m.github}
                    </span>
                  </SettingRowTitle>
                  {/* Under the name rather than beside it: as a third column it
                      had nothing to shrink into on a phone and overlapped the
                      name it belongs to. */}
                  {account && (
                    <SettingRowDescription
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      since {new Date(account.connectedAt).toLocaleDateString()}
                    </SettingRowDescription>
                  )}
                </SettingRowText>
                <SettingRowControl
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.flex,
                    sx.itemsCenter,
                    sx.gap3,
                  )}
                >
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
                  {m.connected &&
                    m.canManage && (
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
                            className={mergeStylexOverrideClassName(
                              "data-[highlighted]:bg-red-soft",
                              sx.textRed,
                            )}
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
      {outsideCancel}
      {personal && showHint && (
        <SettingsHint>
          {active
            ? "Sign in with GitHub to open pull requests as yourself in interactive sessions. Automations and unconnected teammates use the workspace bot."
            : "Personal GitHub sign-in is not enabled for this workspace. Pull requests use the workspace bot."}
        </SettingsHint>
      )}
    </>
  );
}

const TOKEN_CONNECT_URLS: Record<string, { url: string; label: string }> = {
  vercel: {
    url: "https://vercel.com/account/settings/tokens",
    label: "vercel.com/account/settings/tokens",
  },
  vero: {
    url: "https://help.getvero.com/vero-ai/mcp-authentication",
    label: "Vero's MCP authentication guide",
  },
};

/**
 * Paste-a-token connect for providers whose hosted MCP gates OAuth client
 * registration (Vercel approves only clients it has reviewed). Any teammate
 * can mint a personal token; the server validates it live against the
 * provider's API before storing it as a grant.
 */
function ConnectTokenDialog({
  server,
  onClose,
  onConnected,
}: {
  server: McpConnection | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [scope, setScope] = useState<"shared" | "me">("shared");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (server) {
      setScope("shared");
      setToken("");
      setError(null);
    }
  }, [server]);
  if (!server) return null;
  const active = server;
  const tokenPage = TOKEN_CONNECT_URLS[active.name];

  async function connect() {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await request(
        `/connections/mcp/${encodeURIComponent(active.name)}/token`,
        {
          method: "POST",
          body: { token: token.trim(), scope },
          label: `Could not connect ${active.name}`,
        },
      );
      onConnected();
    } catch (cause) {
      setError(errorMessage(cause, `Could not connect ${active.name}`));
    }
    setSaving(false);
  }

  return (
    <Modal.Root
      open={!!server}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal.Content widthClassName={utilityClassName("max-w-[30rem]")}>
        <Modal.Header
          title={`Connect ${displayName(server.name)} with an API token`}
          description="The token is checked with the provider, then stored for agent runs."
        />
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
          {tokenPage ? (
            <div
              {...stylex.props(
                sx.leadingSnug,
                sx.textDim,
                typography.supporting,
              )}
            >
              Create a token at{" "}
              <a
                {...stylex.props(sx.underline, sx.hoverTextFg)}
                href={tokenPage.url}
                target="_blank"
                rel="noreferrer"
              >
                {tokenPage.label}
              </a>
              , then paste it here.
            </div>
          ) : null}
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15)}>
            <span {...stylex.props(sx.textDim, typography.supporting)}>
              Connect as
            </span>
            <Segmented
              label="Connect as"
              size="sm"
              value={scope}
              onValueChange={(next) => setScope(next as "shared" | "me")}
            >
              <SegmentedOption value="shared">Workspace</SegmentedOption>
              <SegmentedOption value="me">My account</SegmentedOption>
            </Segmented>
          </div>
          <input
            type="password"
            className={cn(settingsInputClass, utilityClassName("font-mono"))}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste API token"
            autoComplete="off"
            spellCheck={false}
            aria-label="API token"
          />
          {error && <InlineAlert>{error}</InlineAlert>}
          <Modal.Footer>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!token.trim() || saving}
              onClick={() => void connect()}
            >
              {saving ? "Checking" : "Connect"}
            </Button>
          </Modal.Footer>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

function AddMcpForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
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
      const envValues = parseMcpEnvironment(env);
      const allowed = allowedUsers
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean);
      await request("/connections/mcp", {
        method: "POST",
        body: {
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args:
            transport === "stdio"
              ? args.split(/\s+/).filter(Boolean)
              : undefined,
          env: transport === "stdio" ? envValues : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
        },
        label: "Could not add MCP server",
      });
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add MCP server"));
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <SettingsForm
      className={mergeStylexOverrideClassName(
        "",
        sx.mb18px,
        sx.flex,
        sx.flexCol,
        sx.gap35,
      )}
    >
      <SettingsFormTitle>Add MCP server</SettingsFormTitle>

      <SettingsFormRow>
        <SettingsField>
          Name
          <input
            className={settingsInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="github"
          />
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
            onChange={(next) => {
              if (next === "http" || next === "stdio") setTransport(next);
            }}
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
              className={cn(
                settingsInputClass,
                utilityClassName("resize-y font-mono"),
              )}
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
