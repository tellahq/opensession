import { useEffect, useState } from "react";
import {
  fetchSandboxStatus,
  saveSandboxDefault,
  type SandboxStatusInfo,
} from "../../lib/api";
import { fetchRepos, type RepoInfo } from "../../lib/api/repos";
import { errorMessage } from "../../lib/error-message";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";

type Scope = "workspace" | "personal";

function providerLabel(id: string): string {
  if (id === "none") return "This machine";
  if (id === "daytona") return "Sandbox · Daytona";
  if (id === "box") return "Sandbox · Boat";
  if (id === "tart") return "Sandbox · Mac VM";
  return id;
}

function SandboxDefaultRow({
  scope,
  canManage = true,
}: {
  scope: Scope;
  canManage?: boolean;
}) {
  const user = getCurrentUser();
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    fetchSandboxStatus(user)
      .then(setStatus)
      .catch((error) =>
        setLoadError(
          errorMessage(error, "Failed to load available sandbox providers"),
        ),
      );
  }, [user]);

  if (!status?.defaults) {
    return (
      <SettingRow
        title="Default sandbox"
        desc={loadError || "Loading available sandbox providers…"}
        control={
          <span className="text-supporting text-faint">
            {loadError ? "Unavailable" : "Loading…"}
          </span>
        }
      />
    );
  }

  const providers = status.connections?.length
    ? status.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => ({ id: connection.provider }))
    : status.providers.filter(
        (provider) => provider.configured && provider.certified,
      );
  const workspace = status.defaults.workspace || "none";
  const value =
    scope === "workspace" ? workspace : status.defaults.personal || "workspace";
  const available = new Set<string>(providers.map((provider) => provider.id));
  const unavailableSelection =
    value !== "workspace" && value !== "none" && !available.has(value)
      ? [
          {
            value,
            label: `${providerLabel(value)} · unavailable`,
            disabled: true,
          },
        ]
      : [];
  const options = [
    ...(scope === "personal"
      ? [
          {
            value: "workspace",
            label: `Workspace default · ${providerLabel(workspace)}`,
          },
        ]
      : []),
    { value: "none", label: "This machine" },
    ...unavailableSelection,
    ...providers.map((provider) => ({
      value: provider.id,
      label: providerLabel(provider.id),
    })),
  ];

  async function save(next: string) {
    setSaving(true);
    await (async () => {
      const response = await saveSandboxDefault({ scope, value: next, user });
      setStatus((current) =>
        current ? { ...current, defaults: response.defaults } : current,
      );
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Failed to save sandbox default"), {
          variant: "error",
        });
        fetchSandboxStatus(user)
          .then(setStatus)
          .catch(() => {
            // The save error is already visible and the pre-save status remains valid.
          });
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  return (
    <SettingRow
      title="New sessions run in"
      desc={
        scope === "personal"
          ? "Where your new sessions run. The Sandbox choice in the new session menu overrides this per session."
          : "Where new sessions run for everyone, and which provider a Sandbox means."
      }
      control={
        <div className={saving ? "pointer-events-none opacity-60" : undefined}>
          <Select
            label={`${scope === "personal" ? "Personal" : "Workspace"} default environment`}
            value={value}
            options={options}
            onChange={(next) => void save(next)}
            disabled={scope === "workspace" && !canManage}
          />
        </div>
      }
    />
  );
}

export function PersonalSandboxDefaultRow() {
  return <SandboxDefaultRow scope="personal" />;
}

/**
 * Per-project overrides. A project set here always starts its new sessions
 * there, whatever the workspace or a person chose; only the per-session
 * choice in the new session menu beats it.
 */
function ProjectSandboxDefaults({ canManage }: { canManage: boolean }) {
  const user = getCurrentUser();
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    fetchSandboxStatus(user)
      .then(setStatus)
      .catch(() => {});
    fetchRepos()
      .then(setRepos)
      .catch(() => {});
  }, [user]);
  if (!status?.defaults || !repos.length) return null;
  const defaults = status.defaults;
  const providers: string[] = status.connections?.length
    ? status.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => connection.provider)
    : status.providers
        .filter((provider) => provider.configured && provider.certified)
        .map((provider) => provider.id);
  if (!providers.length) return null;

  async function save(
    repo: string,
    scope: "repo" | "repo-portals",
    next: string,
  ) {
    setSaving(`${repo}:${scope}`);
    await saveSandboxDefault({ scope, value: next, user, repo })
      .then((response) =>
        setStatus((current) =>
          current ? { ...current, defaults: response.defaults } : current,
        ),
      )
      .catch((error) =>
        toast(errorMessage(error, "Failed to save the project default"), {
          variant: "error",
        }),
      )
      .finally(() => setSaving(null));
  }

  return (
    <>
      <SettingsGroupLabel>Projects</SettingsGroupLabel>
      <SettingCard>
        {repos.map((repo) => {
          const value = defaults.repos?.[repo.id] ?? "workspace";
          const unavailable =
            value !== "workspace" &&
            value !== "none" &&
            !providers.includes(value);
          const portals = defaults.portals?.[repo.id] ?? "none";
          const portalsUnavailable =
            portals !== "none" && !providers.includes(portals);
          const label = repo.label || repo.id;
          return (
            <div key={repo.id}>
              <SettingRow
                title={label}
                desc={
                  value === "workspace"
                    ? `Follows the workspace default (${providerLabel(defaults.workspace || "none")}).`
                    : "Every new session on this project starts here."
                }
                control={
                  <div
                    className={
                      saving === `${repo.id}:repo`
                        ? "pointer-events-none opacity-60"
                        : undefined
                    }
                  >
                    <Select
                      label={`${label} default environment`}
                      value={value}
                      options={[
                        { value: "workspace", label: "Workspace default" },
                        { value: "none", label: "This machine" },
                        ...(unavailable
                          ? [
                              {
                                value,
                                label: `${providerLabel(value)} · unavailable`,
                                disabled: true,
                              },
                            ]
                          : []),
                        ...providers.map((id) => ({
                          value: id,
                          label: providerLabel(id),
                        })),
                      ]}
                      onChange={(next) => void save(repo.id, "repo", next)}
                      disabled={!canManage}
                    />
                  </div>
                }
              />
              <SettingRow
                title={`${label} app`}
                desc={
                  portals === "none"
                    ? "Portals start beside the session: on this machine, or in its Sandbox."
                    : "Sessions on this machine run their Portals in a Sandbox of their own, started with the first Portal and refreshed after every turn."
                }
                control={
                  <div
                    className={
                      saving === `${repo.id}:repo-portals`
                        ? "pointer-events-none opacity-60"
                        : undefined
                    }
                  >
                    <Select
                      label={`${label} Portal environment`}
                      value={portals}
                      options={[
                        { value: "none", label: "With the session" },
                        ...(portalsUnavailable
                          ? [
                              {
                                value: portals,
                                label: `${providerLabel(portals)} · unavailable`,
                                disabled: true,
                              },
                            ]
                          : []),
                        ...providers.map((id) => ({
                          value: id,
                          label: providerLabel(id),
                        })),
                      ]}
                      onChange={(next) =>
                        void save(repo.id, "repo-portals", next)
                      }
                      disabled={!canManage}
                    />
                  </div>
                }
              />
            </div>
          );
        })}
      </SettingCard>
      <SettingsHint>
        A project set to a Sandbox always starts there, so its app runs in a
        Sandbox Portal instead of on this server. The per-session choice in the
        new session menu still wins. A project whose app is set to a Sandbox
        keeps its sessions on this machine and runs only the app remotely.
      </SettingsHint>
    </>
  );
}

export function WorkspaceSandboxDefaults({
  canManage = true,
}: {
  canManage?: boolean;
}) {
  return (
    <>
      <SettingsGroupLabel className="mt-0">
        Session environment
      </SettingsGroupLabel>
      <SettingCard>
        <SandboxDefaultRow scope="workspace" canManage={canManage} />
      </SettingCard>
      <SettingsHint>
        This machine runs sessions in a worktree on this server. Only tested
        providers appear here.
      </SettingsHint>
      <ProjectSandboxDefaults canManage={canManage} />
    </>
  );
}
