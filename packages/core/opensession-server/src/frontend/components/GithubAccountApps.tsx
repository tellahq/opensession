import { useCallback, useEffect, useState } from "react";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import { githubManifestAction } from "../lib/github-app-setup";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { DeviceCode } from "../ui/device-code";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { InlineAlert } from "../ui/state";
import { IconArrowUpRight } from "./icons";
import { StateChip, setupRequest } from "./setup-shared";

/** One additional per-account GitHub App, as GET /api/connections/github/apps
 *  reports it. */
interface AccountApp {
  id: string;
  owner: string;
  ownerType: "User" | "Organization" | null;
  slug: string;
  keyConfigured: boolean;
  webhookConfigured: boolean;
  installUrl: string;
  settingsUrl: string;
  /** Null when GitHub could not be asked. */
  installed: boolean | null;
  accounts: { login: string; needsReconnect?: boolean }[];
}

interface AccountAppsData {
  primary: { configured: boolean; slug: string | null; owner: string | null };
  apps: AccountApp[];
}

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

type OwnerType = "personal" | "organization";

/**
 * The GitHub accounts beyond the first App's own. GitHub installs a private
 * App only on the account that owns it, so each further account (a personal
 * account with a fork, a second organization) gets its own App, created with
 * the same manifest flow as the first. Open Session picks the App by
 * repository owner.
 */
export function GithubAccountApps() {
  const [data, setData] = useState<AccountAppsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<OwnerType>("personal");
  const [organization, setOrganization] = useState("");
  const [starting, setStarting] = useState(false);
  const [signIn, setSignIn] = useState<{
    appId: string;
    flow: DeviceFlow;
  } | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async (refresh = false) => {
    try {
      setData(
        await request<AccountAppsData>(
          `/connections/github/apps${refresh ? "?refresh=1" : ""}`,
          { label: "Could not load GitHub accounts" },
        ),
      );
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause, "Could not load GitHub accounts"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!signIn) return;
    let cancelled = false;
    let intervalMs = Math.max(signIn.flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await request<
          | { status: "pending" }
          | { status: "slow_down"; interval: number }
          | { status: "ok" }
          | { status: "error"; error: string }
        >(
          `/connections/github/apps/${encodeURIComponent(signIn.appId)}/device/poll`,
          {
            method: "POST",
            body: { deviceCode: signIn.flow.deviceCode },
            label: "Could not check GitHub authorization",
          },
        );
        if (cancelled) return;
        if (result.status === "ok") {
          setSignIn(null);
          void load();
          return;
        }
        if (result.status === "slow_down") {
          intervalMs = Math.max(result.interval, 5) * 1000;
        } else if (result.status === "error") {
          setError(result.error);
          setSignIn(null);
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
  }, [signIn, load]);

  async function addAccount() {
    if (starting) return;
    if (owner === "organization" && !organization.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const json =
        owner === "organization"
          ? {
              additional: true,
              owner,
              returnTo: "settings",
              organization: organization.trim(),
            }
          : { additional: true, owner, returnTo: "settings" };
      const body = await setupRequest<{ action: string; manifest: string }>(
        "/api/setup/github/manifest",
        { method: "POST", json },
      );
      const action = githubManifestAction(body.action);
      if (!action) {
        setError("GitHub returned an invalid App registration address");
        setStarting(false);
        return;
      }
      const form = document.createElement("form");
      form.method = "post";
      form.action = action;
      form.hidden = true;
      const manifest = document.createElement("input");
      manifest.type = "hidden";
      manifest.name = "manifest";
      manifest.value = body.manifest;
      form.append(manifest);
      document.body.append(form);
      form.submit();
    } catch (cause) {
      setError(errorMessage(cause, "Could not start GitHub App setup"));
      setStarting(false);
    }
  }

  async function startSignIn(app: AccountApp) {
    setError(null);
    try {
      const flow = await request<DeviceFlow>(
        `/connections/github/apps/${encodeURIComponent(app.id)}/device`,
        { method: "POST", label: "Could not start GitHub authorization" },
      );
      setSignIn({ appId: app.id, flow });
    } catch (cause) {
      setError(errorMessage(cause, "Could not start GitHub authorization"));
    }
  }

  async function signOut(app: AccountApp, login: string) {
    setError(null);
    try {
      await request(
        `/connections/github/apps/${encodeURIComponent(app.id)}/account/${encodeURIComponent(login)}`,
        { method: "DELETE", label: "Could not sign out" },
      );
      void load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not sign out"));
    }
  }

  function remove(app: AccountApp) {
    confirm({
      title: `Remove the GitHub App for ${app.owner}?`,
      description: `Open Session stops reaching ${app.owner}'s repositories. The App stays on GitHub until you delete it there.`,
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          try {
            await request(
              `/connections/github/apps/${encodeURIComponent(app.id)}`,
              { method: "DELETE", label: "Could not remove the GitHub App" },
            );
            void load();
          } catch (cause) {
            setError(errorMessage(cause, "Could not remove the GitHub App"));
          }
        })();
      },
    });
  }

  if (!data) {
    return loadError ? (
      <InlineAlert onRetry={() => void load()}>{loadError}</InlineAlert>
    ) : null;
  }
  if (!data.primary.configured) return null;

  return (
    <section
      aria-label="Other GitHub accounts"
      className="flex flex-col gap-3 border-t border-line pt-5"
    >
      <div className="flex flex-col gap-1">
        <div className="text-item-title font-semibold text-fg">
          Other GitHub accounts
        </div>
        <p className="m-0 text-supporting leading-snug text-dim">
          A private GitHub App installs only on the account that owns it
          {data.primary.owner ? ` (here, ${data.primary.owner})` : ""}. To work
          with repositories under another account, such as your personal
          account, add a GitHub App for it. Open Session picks the App by
          repository owner.
        </p>
      </div>

      {data.apps.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.apps.map((app) => {
            const account = app.accounts[0];
            const tone = !app.keyConfigured
              ? "warn"
              : app.installed === false
                ? "warn"
                : app.installed
                  ? "on"
                  : "off";
            const label = !app.keyConfigured
              ? "Key missing"
              : app.installed === false
                ? "Not installed"
                : app.installed
                  ? "Installed"
                  : "Couldn’t check";
            return (
              <li
                key={app.id}
                className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-all font-medium text-fg">
                    {app.owner}
                  </span>
                  <span className="text-meta text-faint">
                    {app.ownerType === "Organization"
                      ? "Organization"
                      : "Personal account"}
                  </span>
                  <span className="ml-auto">
                    <StateChip tone={tone} label={label} />
                  </span>
                </div>
                <div className="text-supporting text-dim">
                  {account
                    ? account.needsReconnect
                      ? `Signed in as ${account.login}, sign in again to keep working as you`
                      : `Signed in as ${account.login}`
                    : "Not signed in. Pushes use the App until you sign in."}
                </div>
                {signIn?.appId === app.id && (
                  <div className="flex flex-col gap-2 rounded-md bg-hover px-3 py-2.5">
                    <div className="text-supporting text-dim">
                      Enter this code at{" "}
                      <span className="font-medium text-fg">
                        {signIn.flow.verificationUri.replace(/^https:\/\//, "")}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DeviceCode code={signIn.flow.userCode} className="h-9" />
                      <Button
                        size="sm"
                        variant="primary"
                        className="phone:min-h-11"
                        icon={<IconArrowUpRight size={16} />}
                        render={
                          <a
                            href={signIn.flow.verificationUri}
                            target="_blank"
                            rel="noreferrer"
                          />
                        }
                      >
                        Open GitHub
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="phone:min-h-11"
                        onClick={() => setSignIn(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {app.installed !== true && (
                    <Button
                      size="sm"
                      className="phone:min-h-11"
                      icon={<IconArrowUpRight size={16} />}
                      render={
                        <a
                          href={app.settingsUrl}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      Enable Device Flow
                    </Button>
                  )}
                  {app.installed !== true && (
                    <Button
                      size="sm"
                      className="phone:min-h-11"
                      icon={<IconArrowUpRight size={16} />}
                      render={
                        <a
                          href={app.installUrl}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      Install on {app.owner}
                    </Button>
                  )}
                  {account && !account.needsReconnect ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="phone:min-h-11"
                      onClick={() => void signOut(app, account.login)}
                    >
                      Sign out
                    </Button>
                  ) : (
                    signIn?.appId !== app.id && (
                      <Button
                        size="sm"
                        className="phone:min-h-11"
                        onClick={() => void startSignIn(app)}
                      >
                        {account ? "Sign in again" : "Sign in"}
                      </Button>
                    )
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto phone:min-h-11"
                    onClick={() => remove(app)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-label font-medium text-dim">
          Add another account
        </div>
        <Segmented
          label="New GitHub App owner"
          value={owner}
          onValueChange={(value) => {
            if (value === "personal" || value === "organization")
              setOwner(value);
          }}
          className="w-full"
        >
          <SegmentedOption
            value="personal"
            className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
          >
            Personal account
          </SegmentedOption>
          <SegmentedOption
            value="organization"
            className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
          >
            Organization
          </SegmentedOption>
        </Segmented>
        {owner === "organization" && (
          <Input
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            placeholder="my-organization"
            aria-label="Organization ID"
            className="phone:min-h-11 phone:text-input-phone"
            disabled={starting}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            className="phone:min-h-11"
            disabled={
              starting || (owner === "organization" && !organization.trim())
            }
            onClick={() => void addAccount()}
          >
            Add GitHub account
          </Button>
          {data.apps.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="phone:min-h-11"
              onClick={() => void load(true)}
            >
              Refresh
            </Button>
          )}
        </div>
        <p className="m-0 text-meta leading-snug text-faint">
          For a personal account, sign in to GitHub as that account first.
        </p>
      </div>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {confirmElement}
    </section>
  );
}
