import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import { errorMessage } from "../lib/error-message";
import {
  PHASE_DOT,
  PHASE_LABEL,
  PersonalGithubApiError,
  acceptPersonalGithubDisclosure,
  beginPersonalGithubManifest,
  disconnectPersonalGithub,
  fetchPersonalGithubStatus,
  isVerifiedSignInRequired,
  manifestSubmission,
  personalGithubAppSettingsUrl,
  personalGithubDescription,
  personalGithubPhase,
  personalRepositoryIsListed,
  registerPersonalRepository,
  type PersonalGithubStatus,
  type PersonalGithubRefresh,
  type PersonalRepositoryRegistration,
  pollPersonalGithubGrant,
  refreshPersonalGithub,
  startPersonalGithubGrant,
  type ManifestSubmission,
  type PersonalGithubDisclosure,
} from "../lib/personal-github";
import {
  INITIAL_PERSONAL_GITHUB_STATE,
  canStartConnection,
  personalGithubReducer,
  personalGithubScope,
  personalRepositoryScope,
  type PersonalGithubState,
} from "../lib/personal-github-state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DeviceCode } from "../ui/device-code";
import { Menu } from "../ui/menu";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
  StatusChip,
  rowMenuTriggerClasses,
} from "../ui/settings";
import { ResponsiveDialog } from "../ui/sheet";
import { InlineAlert } from "../ui/state";
import { PulseDot } from "../ui/status";
import { IconTile } from "./BrandTile";
import {
  IconArrowUpRight,
  IconDotsHorizontal,
  IconHistory,
  IconPlug,
  IconShieldCheck,
  IconTrash,
} from "./icons";
import { useAuthStatus } from "./UserPicker";

/**
 * Settings > Account > Personal GitHub App (issue #390).
 *
 * One private GitHub App per person, created through GitHub's manifest flow
 * and authorized with a device code, so a session can later reach the
 * repositories that person picks without the workspace bot. The server keeps
 * every secret; this card only ever holds a disclosure receipt and a
 * device-flow id, in memory, under one signed-in account.
 *
 * The shared-server disclosure is the gate: it is rendered in full, from the
 * server's versioned copy, and the checkbox under it is what makes the
 * connect button live. Nothing is created on GitHub until the server has
 * recorded that acceptance. Once connected, the same text stays one tap away
 * so it is never something a person agreed to once and can no longer find.
 */
export function PersonalGithubConnection() {
  const auth = useAuthStatus();
  const scope = personalGithubScope(auth);
  if (!scope) {
    return auth?.required && auth.authenticated ? (
      <>
        <SettingsGroupLabel>Personal GitHub App</SettingsGroupLabel>
        <SettingsHint>
          Sign out and sign in with GitHub again to connect a personal App with
          a verified account identity.
        </SettingsHint>
      </>
    ) : null;
  }
  return <AccountPersonalGithubConnection key={scope} scope={scope} />;
}

function AccountPersonalGithubConnection({ scope }: { scope: string }) {
  const [state, dispatch] = useReducer(personalGithubReducer, {
    ...INITIAL_PERSONAL_GITHUB_STATE,
    scope,
    generation: 1,
  });
  const [submission, setSubmission] = useState<ManifestSubmission | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const isPhone = useIsPhone();
  const formRef = useRef<HTMLFormElement>(null);
  const generationRef = useRef(state.generation);
  const activeRef = useRef(true);
  // Keyed by the authenticated numeric identity. Layout cleanup fences pending
  // work before a replacement account can paint, including top-level redirects.
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    generationRef.current = state.generation;
  }, [state.generation]);
  const stale = (generation: number) =>
    !activeRef.current || generationRef.current !== generation;

  function belongsToAccount(result: { ownerGithubAccountId: number }) {
    if (scope === `github:${result.ownerGithubAccountId}`) return true;
    activeRef.current = false;
    setSubmission(null);
    setNotice(null);
    setDisclosureOpen(false);
    dispatch({
      type: "status.failed",
      generation: generationRef.current,
      signInRequired: true,
      message: "Your GitHub account changed. Reload to continue.",
    });
    return false;
  }

  async function load(generation: number) {
    if (stale(generation)) return;
    dispatch({ type: "status.start" });
    try {
      const data = await fetchPersonalGithubStatus();
      if (stale(generation)) return;
      if (!belongsToAccount(data)) return;
      dispatch({ type: "status.ok", generation, data });
    } catch (cause) {
      if (stale(generation)) return;
      dispatch({
        type: "status.failed",
        generation,
        message: errorMessage(cause, "Could not load your GitHub App status"),
        signInRequired: isVerifiedSignInRequired(cause),
      });
    }
  }

  const loadFromEffect = useEffectEvent(load);
  const acceptFromEffect = useEffectEvent(belongsToAccount);

  // Load once per bound account: the generation changes with the scope.
  useEffect(() => {
    if (!state.scope) return;
    void loadFromEffect(state.generation);
  }, [state.scope, state.generation]);

  // GitHub's manifest and authorization pages happen in other tabs or after a
  // round trip, so returning to this one re-reads the truth from the server
  // rather than trusting anything in the URL.
  useEffect(() => {
    if (!state.scope) return;
    const generation = state.generation;
    const refetch = () => {
      if (document.visibilityState !== "visible") return;
      void loadFromEffect(generation);
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [state.scope, state.generation]);

  // Device-flow polling, paced by the server's interval. Transient failures
  // keep polling; a server-reported failure ends the flow with its reason.
  useEffect(() => {
    if (state.operation.kind !== "grant") return;
    const { flowId, interval } = state.operation.flow;
    const generation = state.generation;
    const intervalMs = Math.max(interval, 5) * 1000;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await pollPersonalGithubGrant(flowId);
        if (cancelled || stale(generation)) return;
        if (!acceptFromEffect(result)) return;
        if (result.status === "connected") {
          dispatch({ type: "operation.done", generation });
          void loadFromEffect(generation);
          return;
        }
      } catch (cause) {
        if (cancelled || stale(generation)) return;
        if (cause instanceof PersonalGithubApiError) {
          dispatch({
            type: "operation.failed",
            generation,
            message:
              cause.code === "grant_missing"
                ? "The code expired before GitHub confirmed it. Authorize again."
                : cause.message,
          });
          return;
        }
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.operation, state.generation]);

  // The manifest leaves as a top-level form POST to GitHub, the only way
  // GitHub accepts one. Submitting from an effect keeps the hidden fields
  // rendered from state, so what is posted is exactly what was validated.
  useEffect(() => {
    if (submission && activeRef.current) formRef.current?.submit();
  }, [submission]);

  async function connect() {
    if (!canStartConnection(state) || state.status.kind !== "ready") return;
    const generation = state.generation;
    const version = state.status.data.disclosure.version;
    dispatch({ type: "operation.start", operation: { kind: "acknowledging" } });
    try {
      const receipt = await acceptPersonalGithubDisclosure(version);
      if (stale(generation)) return;
      if (!belongsToAccount(receipt)) return;
      dispatch({ type: "operation.start", operation: { kind: "preparing" } });
      const manifest = await beginPersonalGithubManifest(
        receipt.disclosureReceipt,
      );
      if (stale(generation)) return;
      if (!belongsToAccount(manifest)) return;
      const next = manifestSubmission(manifest);
      if (!next) {
        dispatch({
          type: "operation.failed",
          generation,
          message:
            "The server returned an unexpected GitHub address, so nothing was sent.",
        });
        return;
      }
      dispatch({ type: "operation.start", operation: { kind: "redirecting" } });
      setSubmission(next);
    } catch (cause) {
      if (stale(generation)) return;
      dispatch({
        type: "operation.failed",
        generation,
        message: errorMessage(cause, "Could not start creating the GitHub App"),
      });
    }
  }

  async function authorize() {
    if (state.operation.kind !== "none") return;
    const generation = state.generation;
    dispatch({ type: "operation.start", operation: { kind: "preparing" } });
    try {
      const flow = await startPersonalGithubGrant();
      if (stale(generation)) return;
      if (!belongsToAccount(flow)) return;
      dispatch({ type: "grant.started", generation, flow });
    } catch (cause) {
      if (stale(generation)) return;
      dispatch({
        type: "operation.failed",
        generation,
        message: errorMessage(cause, "Could not start GitHub authorization"),
      });
    }
  }

  async function refresh() {
    if (state.operation.kind !== "none") return;
    const generation = state.generation;
    setNotice(null);
    dispatch({ type: "operation.start", operation: { kind: "refreshing" } });
    try {
      const result = await refreshPersonalGithub();
      if (stale(generation)) return;
      if (!belongsToAccount(result)) return;
      const count = result.repositories.length;
      setNotice(
        count === 1
          ? "1 repository is reachable through your App."
          : `${count} repositories are reachable through your App.`,
      );
      dispatch({ type: "operation.done", generation });
      void load(generation);
    } catch (cause) {
      if (stale(generation)) return;
      dispatch({
        type: "operation.failed",
        generation,
        message: errorMessage(cause, "Could not refresh repositories"),
      });
    }
  }

  async function disconnect() {
    if (state.operation.kind !== "none") return;
    if (
      !confirm(
        "Disconnect your GitHub App? This revokes its authorization here. The App itself stays on GitHub until you delete it there.",
      )
    ) {
      return;
    }
    const generation = state.generation;
    setNotice(null);
    dispatch({ type: "operation.start", operation: { kind: "disconnecting" } });
    try {
      const result = await disconnectPersonalGithub();
      if (stale(generation) || !belongsToAccount(result)) return;
      dispatch({ type: "operation.done", generation });
      void load(generation);
    } catch (cause) {
      if (stale(generation)) return;
      dispatch({
        type: "operation.failed",
        generation,
        message: errorMessage(cause, "Could not disconnect the GitHub App"),
      });
    }
  }

  const disclosure =
    state.status.kind === "ready"
      ? state.status.data.disclosure
      : state.status.kind === "loading" || state.status.kind === "error"
        ? (state.status.previous?.disclosure ?? null)
        : null;

  return (
    <>
      <PersonalGithubCard
        state={state}
        notice={notice}
        onConsentChange={(accepted) => dispatch({ type: "consent", accepted })}
        onConnect={() => void connect()}
        onAuthorize={() => void authorize()}
        onCancelGrant={() => dispatch({ type: "grant.cancel" })}
        onRefresh={() => void refresh()}
        onDisconnect={() => void disconnect()}
        onReload={() => void load(state.generation)}
        onDismissError={() => dispatch({ type: "error.dismiss" })}
        onDismissNotice={() => setNotice(null)}
        onShowDisclosure={disclosure ? () => setDisclosureOpen(true) : null}
      />
      {/* Hidden on purpose: the browser posts it, nobody reads it. Only the
          manifest JSON and GitHub's own state travel; no App credential
          exists yet at this point. */}
      <form
        ref={formRef}
        method="post"
        action={submission?.action}
        className="hidden"
        aria-hidden="true"
        data-personal-github-manifest=""
      >
        <input
          type="hidden"
          name="manifest"
          value={submission?.manifest ?? ""}
          readOnly
        />
      </form>
      {disclosure && (
        <ResponsiveDialog
          open={disclosureOpen}
          onClose={() => setDisclosureOpen(false)}
          phone={isPhone}
          label="Server disclosure"
          modalClassName="w-[min(460px,calc(100vw-32px))]"
        >
          {(dismiss) => (
            <div className="flex flex-col gap-3.5 p-5">
              <div className="flex items-center gap-2 text-item-title font-semibold text-fg">
                <IconShieldCheck size={20} className="text-dim" />
                Server disclosure
              </div>
              <DisclosureText disclosure={disclosure} />
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  className="phone:min-h-11"
                  onClick={dismiss}
                >
                  Close
                </Button>
              </div>
            </div>
          )}
        </ResponsiveDialog>
      )}
    </>
  );
}

function DisclosureText({
  disclosure,
}: {
  disclosure: PersonalGithubDisclosure;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-supporting leading-relaxed text-fg">
        {disclosure.text}
      </p>
      <div className="text-meta text-faint">
        Disclosure version {disclosure.version}
      </div>
    </div>
  );
}

/**
 * The card itself, with every action handed in, so each state can be rendered
 * and checked on its own.
 */
export function PersonalGithubCard({
  state,
  notice,
  onConsentChange,
  onConnect,
  onAuthorize,
  onCancelGrant,
  onRefresh,
  onDisconnect,
  onReload,
  onDismissError,
  onDismissNotice,
  onShowDisclosure,
}: {
  state: PersonalGithubState;
  notice: string | null;
  onConsentChange: (accepted: boolean) => void;
  onConnect: () => void;
  onAuthorize: () => void;
  onCancelGrant: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onReload: () => void;
  onDismissError: () => void;
  onDismissNotice: () => void;
  /** null until the disclosure has arrived from the server. */
  onShowDisclosure: (() => void) | null;
}) {
  const heading = <SettingsGroupLabel>Personal GitHub App</SettingsGroupLabel>;
  const { status, operation } = state;

  if (
    status.kind === "idle" ||
    (status.kind === "loading" && !status.previous)
  ) {
    return (
      <>
        {heading}
        <SettingCardSkeleton
          rows={1}
          icon={30}
          label="Checking your GitHub App"
        />
      </>
    );
  }

  if (status.kind === "signin_required") {
    return (
      <>
        {heading}
        <SettingCard>
          <SettingRow className="gap-x-3">
            <IconTile name="github" size={30} />
            <SettingRowText>
              <SettingRowTitle>Personal GitHub App</SettingRowTitle>
              <SettingRowDescription className="leading-snug">
                Sign out and sign in with GitHub again so this server holds a
                verified account id for you. Nothing else changes.
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl className="flex items-center gap-3 phone:basis-full phone:justify-end">
              <StatusChip label="Sign in again" dot="var(--yellow)" />
            </SettingRowControl>
          </SettingRow>
        </SettingCard>
        <SettingsHint>{status.message}</SettingsHint>
      </>
    );
  }

  if (status.kind === "error" && !status.previous) {
    return (
      <>
        {heading}
        <InlineAlert onRetry={onReload}>{status.message}</InlineAlert>
      </>
    );
  }

  const data = status.kind === "ready" ? status.data : status.previous!;
  const connection = data.status;
  const phase = personalGithubPhase(connection);
  const busy = operation.kind !== "none";
  const reloading = status.kind === "loading";
  const connectLabel =
    operation.kind === "acknowledging"
      ? "Recording…"
      : operation.kind === "preparing"
        ? "Preparing…"
        : operation.kind === "redirecting"
          ? "Opening GitHub…"
          : "Create GitHub App";
  const canAuthorize = phase === "app_created" || phase === "reconnect";
  const appSettingsUrl = connection.app
    ? personalGithubAppSettingsUrl(connection.app.slug)
    : null;

  return (
    <>
      {heading}
      {status.kind === "error" && (
        <InlineAlert onRetry={onReload}>{status.message}</InlineAlert>
      )}
      {state.error && (
        <InlineAlert onDismiss={onDismissError}>{state.error}</InlineAlert>
      )}
      {notice && (
        <InlineAlert variant="info" onDismiss={onDismissNotice}>
          {notice}
        </InlineAlert>
      )}
      <SettingCard>
        <SettingRow className="gap-x-3">
          <IconTile name="github" size={30} />
          <SettingRowText>
            <SettingRowTitle className="truncate">
              {connection.app ? connection.app.slug : "Personal GitHub App"}
              {connection.userGrant && (
                <span className="ml-2 text-label font-normal text-faint">
                  @{connection.userGrant.grantedLogin}
                </span>
              )}
            </SettingRowTitle>
            <SettingRowDescription className="leading-snug">
              {personalGithubDescription(connection, data.repositoryAdmission)}
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl className="flex items-center gap-3 phone:basis-full phone:justify-end">
            <StatusChip label={PHASE_LABEL[phase]} dot={PHASE_DOT[phase]} />
            {connection.app && (
              <Menu.Root>
                <Menu.Trigger
                  className={rowMenuTriggerClasses}
                  aria-label={`Manage ${connection.app.slug}`}
                >
                  <IconDotsHorizontal size={18} />
                </Menu.Trigger>
                <Menu.Popup align="end" sideOffset={4}>
                  <Menu.Item onClick={onReload} disabled={reloading}>
                    <IconHistory size={16} className="text-faint" />
                    Check again
                  </Menu.Item>
                  {phase === "connected" && (
                    <Menu.Item onClick={onRefresh} disabled={busy}>
                      <IconHistory size={16} className="text-faint" />
                      Refresh repositories
                    </Menu.Item>
                  )}
                  {canAuthorize && (
                    <Menu.Item onClick={onAuthorize} disabled={busy}>
                      <IconPlug size={16} className="text-faint" />
                      Authorize
                    </Menu.Item>
                  )}
                  <Menu.Item
                    render={
                      <a
                        href={connection.app.installUrl}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    <IconArrowUpRight size={16} className="text-faint" />
                    Manage repositories on GitHub
                  </Menu.Item>
                  {onShowDisclosure && (
                    <Menu.Item onClick={onShowDisclosure}>
                      <IconShieldCheck size={16} className="text-faint" />
                      Server disclosure
                    </Menu.Item>
                  )}
                  <Menu.Separator />
                  <Menu.Item
                    onClick={onDisconnect}
                    disabled={busy}
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

        {phase === "none" && (
          // The disclosure is the body of the card, not a footnote: the
          // person reads it where the button is, and the button waits for
          // the checkbox under it.
          <div className="flex flex-col gap-4 px-5 py-4">
            <section
              aria-labelledby="personal-github-disclosure-title"
              className="flex flex-col gap-1.5"
            >
              <div
                id="personal-github-disclosure-title"
                className="text-label font-medium text-fg"
              >
                Before you connect
              </div>
              <DisclosureText disclosure={data.disclosure} />
            </section>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-supporting text-fg">
              <Checkbox
                checked={state.consent}
                onCheckedChange={(checked) => onConsentChange(checked === true)}
                disabled={busy}
              />
              <span>I understand and trust this server.</span>
            </label>
            <div className="flex flex-wrap items-center gap-2.5 phone:flex-col phone:items-start">
              <Button
                variant="primary"
                className="phone:min-h-11"
                onClick={onConnect}
                disabled={!canStartConnection(state)}
                aria-busy={busy || undefined}
              >
                {connectLabel}
              </Button>
              <div className="min-w-0 flex-1 text-meta leading-snug text-faint">
                GitHub opens in this tab to create a private App owned by you,
                then returns here. Repository sessions are not available yet.
              </div>
            </div>
          </div>
        )}

        {canAuthorize && (
          <div className="flex flex-col gap-2 px-5 py-3.5">
            <div className="text-supporting text-dim">
              Before authorizing, turn on “Enable Device Flow” in your GitHub
              App settings and save. GitHub cannot enable it during App
              creation.
            </div>
            {appSettingsUrl && (
              <Button
                size="sm"
                variant="ghost"
                className="self-start phone:min-h-11"
                icon={<IconArrowUpRight size={20} />}
                render={
                  <a href={appSettingsUrl} target="_blank" rel="noreferrer" />
                }
              >
                Open App settings
              </Button>
            )}
          </div>
        )}

        {canAuthorize &&
          operation.kind !== "grant" &&
          (operation.kind === "preparing" ? (
            <div className="flex items-center gap-2 px-5 py-3.5 text-supporting text-dim">
              <PulseDot size={7} />
              <span>Starting…</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-2.5 phone:flex-col phone:items-start">
                <Button
                  variant="primary"
                  className="phone:min-h-11"
                  onClick={onAuthorize}
                  disabled={busy}
                >
                  {phase === "reconnect" ? "Authorize again" : "Authorize"}
                </Button>
                {phase === "app_created" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconArrowUpRight size={20} />}
                    render={
                      <a
                        href={connection.app!.installUrl}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Install on repositories
                  </Button>
                )}
              </div>
              <div className="text-meta leading-snug text-faint">
                GitHub opens in a new tab. Authorize with the one-time code,
                then close that tab and return here.
              </div>
            </div>
          ))}

        {operation.kind === "grant" && (
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="text-supporting text-dim">
              Enter this code at{" "}
              <span className="font-medium text-fg">
                {operation.flow.verificationUri.replace(/^https:\/\//, "")}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 phone:flex-col phone:items-start">
              <DeviceCode
                code={operation.flow.userCode}
                className="phone:min-h-11"
              />
              <Button
                size="md"
                variant="primary"
                className="phone:min-h-11"
                icon={<IconArrowUpRight size={20} />}
                render={
                  <a
                    href={operation.flow.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                Open GitHub
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-supporting text-dim">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <PulseDot size={7} />
                <span className="min-w-0">
                  Waiting for GitHub. Authorize there, then close that tab and
                  return here.
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={onCancelGrant}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {(status.kind === "ready" || status.kind === "loading") &&
          operation.kind === "none" &&
          personalRepositoryScope(data) && (
            <PersonalGithubRepositories
              key={personalRepositoryScope(data)}
              data={data}
            />
          )}

        {connection.app && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <a
              href={connection.app!.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1 text-meta text-dim underline hover:text-fg"
            >
              Manage which repositories the App can access
              <IconArrowUpRight size={14} />
            </a>
            {connection.installation ? (
              <span className="text-meta text-faint">
                Installed on @{connection.installation.accountLogin}
                {connection.installation.repositorySelection === "selected"
                  ? ", selected repositories"
                  : ", all repositories"}
              </span>
            ) : (
              <span className="text-meta text-faint">
                Not installed on repositories yet.
              </span>
            )}
          </div>
        )}
      </SettingCard>
      <SettingsHint className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span>
          Your connection is personal, but the server is shared. Other users’
          agents can access your repository files, GitHub credentials, and
          session data.
        </span>
        {!data.repositoryAdmission && (
          <span>Repository sessions are not available yet.</span>
        )}
        {onShowDisclosure && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 underline"
            onClick={onShowDisclosure}
          >
            Read the server disclosure
          </Button>
        )}
      </SettingsHint>
    </>
  );
}

/** Discovery is not registration. Only a successful registration plus a fresh
 * owner-filtered catalog read produces registered-id feedback. */
function PersonalGithubRepositories({ data }: { data: PersonalGithubStatus }) {
  const [repositories, setRepositories] = useState<
    PersonalGithubRefresh["repositories"] | null
  >(null);
  const [registered, setRegistered] =
    useState<PersonalRepositoryRegistration | null>(null);
  const [pending, setPending] = useState<number | "discovery" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const locked = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function discover() {
    if (locked.current) return;
    locked.current = true;
    setPending("discovery");
    setError(null);
    setRegistered(null);
    setRepositories(null);
    try {
      const result = await refreshPersonalGithub();
      if (!active.current) return;
      if (result.ownerGithubAccountId !== data.ownerGithubAccountId) {
        setError("Your GitHub account changed. Reload to continue.");
      } else {
        setRepositories(result.repositories);
      }
    } catch (cause) {
      if (active.current)
        setError(errorMessage(cause, "Could not find repositories"));
    }
    locked.current = false;
    if (active.current) setPending(null);
  }

  async function register(repositoryId: number) {
    if (
      locked.current ||
      !repositories?.some((repo) => repo.repositoryId === repositoryId)
    )
      return;
    locked.current = true;
    setPending(repositoryId);
    setRegistered(null);
    setError(null);
    try {
      const result = await registerPersonalRepository(
        {
          appRecordId: data.status.app!.recordId,
          githubAppId: data.status.app!.githubAppId,
          installationId: data.status.installation!.installationId,
          repositoryId,
        },
        data.ownerGithubAccountId,
      );
      if (!active.current) return;
      const listed = await personalRepositoryIsListed(result.registryId);
      if (!active.current) return;
      if (listed) {
        setRegistered(result);
      } else {
        setRepositories(null);
        setError(
          "This repository is no longer available. Check repositories again.",
        );
      }
    } catch (cause) {
      if (!active.current) return;
      setRepositories(null);
      setError(errorMessage(cause, "Could not add repository"));
    }
    locked.current = false;
    if (active.current) setPending(null);
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-3.5">
      <div className="text-supporting font-medium text-fg">
        Personal repositories
      </div>
      <div className="text-meta text-dim">
        Choose a repository to add to Open Session. Finding it does not add it.
      </div>
      <Button
        variant="default"
        className="self-start phone:min-h-11"
        disabled={pending !== null}
        onClick={() => void discover()}
      >
        {pending === "discovery" ? "Checking…" : "Check repositories"}
      </Button>
      {error && <InlineAlert>{error}</InlineAlert>}
      {repositories?.length === 0 && (
        <div className="text-supporting text-dim">
          No repositories found. Check the App’s installation and try again.
        </div>
      )}
      {repositories?.map((repo) => (
        <div
          key={repo.repositoryId}
          className="flex items-center justify-between gap-3 phone:flex-col phone:items-start"
        >
          <div className="min-w-0 break-words text-supporting text-fg">
            {repo.fullName}{" "}
            <span className="text-meta text-faint">
              {repo.private ? "Private" : "Public"}
            </span>
          </div>
          <Button
            size="sm"
            variant="default"
            className="shrink-0 phone:min-h-11"
            disabled={
              pending !== null ||
              registered?.descriptor.repositoryId === repo.repositoryId
            }
            onClick={() => void register(repo.repositoryId)}
            aria-label={`Add ${repo.fullName}`}
          >
            {pending === repo.repositoryId
              ? "Adding…"
              : registered?.descriptor.repositoryId === repo.repositoryId
                ? "Added"
                : "Add repository"}
          </Button>
        </div>
      ))}
      {registered && (
        <div
          role="status"
          className="flex flex-col gap-1 text-supporting text-dim"
        >
          <span>
            {registered.descriptor.fullName} is registered. Select it when
            creating a session.
          </span>
          <span className="break-all text-meta text-faint">
            Repository ID: {registered.registryId}
          </span>
        </div>
      )}
    </div>
  );
}
