import { use, useEffect, useState } from "react";
import {
  createSessionApi,
  fetchSandboxStatus,
  saveSandboxDefault,
  type SandboxStatusInfo,
} from "../../lib/api";
import { NavigationContext } from "../../hooks/useNavigation";
import { BASE_PATH } from "../../lib/base";
import {
  buildSandboxCachingPrompt,
  projectSandboxOverrides,
} from "../../lib/sandbox-setup-prompt";
import { fetchRepos, type RepoInfo } from "../../lib/api/repos";
import {
  fetchSandboxLifecycle,
  saveRepoPreSetupScript,
  type SandboxLifecycleSettings,
} from "../../lib/api/sandboxes";
import {
  sandboxMachineChoices,
  splitSandboxChoice,
} from "../../lib/ready-sandbox-providers";
import { Button } from "../../ui/button";
import { SandboxScriptDialog } from "./SandboxScriptDialog";
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
  if (id === "usecomputer") return "Sandbox · use.computer";
  if (id === "modal") return "Sandbox · Modal";
  if (id.startsWith("modal:")) return `Sandbox · Modal · ${id.slice(6)} GPU`;
  return id;
}

function SandboxDefaultRow({ scope }: { scope: Scope }) {
  const user = getCurrentUser();
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [showOverrides, setShowOverrides] = useState(false);
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
    if (scope === "workspace") {
      fetchRepos()
        .then(setRepos)
        .catch(() => {});
    }
  }, [scope, user]);

  if (!status?.defaults) {
    return (
      <SettingRow
        title={scope === "personal" ? "Runs in" : "Default sandbox"}
        desc={loadError}
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
            label: `Organization default · ${providerLabel(workspace)}`,
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

  const overrides =
    scope === "workspace"
      ? projectSandboxOverrides(status.defaults, repos)
      : [];

  return (
    <SettingRow
      title={scope === "personal" ? "Runs in" : "New sessions run in"}
      desc={
        scope === "personal" ? undefined : (
          <span className="flex flex-col gap-1.5">
            <span>For everyone in the organization.</span>
            {overrides.length > 0 && (
              <span className="flex flex-col gap-1">
                <span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto px-0 py-0 text-meta font-medium text-dim hover:bg-transparent hover:text-fg"
                    onClick={() => setShowOverrides((open) => !open)}
                  >
                    Overridden by {overrides.length}{" "}
                    {overrides.length === 1 ? "project" : "projects"}
                  </Button>
                </span>
                {showOverrides && (
                  <span className="flex flex-wrap gap-1.5 pt-0.5">
                    {overrides.map((item) => (
                      <span
                        key={item.repoId}
                        className="inline-flex items-center gap-1 rounded-md border border-divider-soft bg-panel-surface px-2 py-0.5 text-meta text-fg"
                      >
                        <span className="font-medium">{item.label}</span>
                        <span className="text-faint">·</span>
                        <span className="text-dim">
                          {providerLabel(item.provider)}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            )}
          </span>
        )
      }
      control={
        <div className={saving ? "pointer-events-none opacity-60" : undefined}>
          <Select
            label={`${scope === "personal" ? "Personal" : "Workspace"} default environment`}
            value={value}
            options={options}
            onChange={(next) => void save(next)}
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
/** Where each project's sessions and app run, or one project's on its page. */
export function ProjectSandboxDefaults({ repoId }: { repoId?: string } = {}) {
  const user = getCurrentUser();
  const navigation = use(NavigationContext);
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [configuringRepo, setConfiguringRepo] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<SandboxLifecycleSettings | null>(
    null,
  );
  const [scriptRepo, setScriptRepo] = useState<RepoInfo | null>(null);
  useEffect(() => {
    fetchSandboxStatus(user)
      .then(setStatus)
      .catch(() => {});
    fetchRepos()
      .then(setRepos)
      .catch(() => {});
    fetchSandboxLifecycle()
      .then(setLifecycle)
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

  async function configureWithAgent(repo: RepoInfo) {
    if (configuringRepo) return;
    setConfiguringRepo(repo.id);
    const label = repo.label || repo.id;
    try {
      const { id } = await createSessionApi({
        prompt: buildSandboxCachingPrompt(label),
        repo: repo.id,
        mode: "code",
        user,
        requestId: crypto.randomUUID(),
      });
      if (navigation) {
        navigation.openSession(id);
      } else {
        window.location.assign(
          `${BASE_PATH}/session/${encodeURIComponent(id)}`,
        );
      }
    } catch (error) {
      toast(
        errorMessage(
          error,
          "Could not start the Sandbox caching setup session",
        ),
        { variant: "error" },
      );
      setConfiguringRepo(null);
    }
  }

  return (
    <>
      <SettingsGroupLabel>{repoId ? "Sandbox" : "Projects"}</SettingsGroupLabel>
      <SettingCard>
        {repos
          .filter((repo) => !repoId || repo.id === repoId)
          .map((repo) => {
            const value = defaults.repos?.[repo.id] ?? "workspace";
            // Modal with a GPU is its own choice (`modal:T4`).
            const unavailable =
              value !== "workspace" &&
              value !== "none" &&
              !providers.includes(splitSandboxChoice(value).provider);
            const portals = defaults.portals?.[repo.id] ?? "none";
            const portalsUnavailable =
              portals !== "none" && !providers.includes(portals);
            const label = repo.label || repo.id;
            return (
              <div key={repo.id}>
                <SettingRow
                  title={repoId ? "Sessions run in" : label}
                  desc={
                    value === "workspace"
                      ? `Follows the organization default (${providerLabel(defaults.workspace || "none")}).`
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
                          { value: "workspace", label: "Organization default" },
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
                          ...sandboxMachineChoices(providers).map((id) => ({
                            value: id,
                            label: providerLabel(id),
                          })),
                        ]}
                        onChange={(next) => void save(repo.id, "repo", next)}
                      />
                    </div>
                  }
                />
                <SettingRow
                  title={repoId ? "App runs in" : `${label} app`}
                  desc={
                    portals === "none"
                      ? "Runs beside the session."
                      : "Runs in its own Sandbox, even for local sessions."
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
                      />
                    </div>
                  }
                />
                {lifecycle ? (
                  <SettingRow
                    title={repoId ? "Setup script" : `${label} setup script`}
                    desc={
                      lifecycle.preSetupScripts[repo.id]
                        ? "Runs before .agents/setup in every new Sandbox. Changing it refreshes the project snapshot."
                        : "Optional. Set up Sandboxes for this project without committing anything."
                    }
                    control={
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={configuringRepo !== null}
                          onClick={() => void configureWithAgent(repo)}
                        >
                          {configuringRepo === repo.id
                            ? "Starting…"
                            : "Configure with agent"}
                        </Button>
                        <Button size="sm" onClick={() => setScriptRepo(repo)}>
                          {lifecycle.preSetupScripts[repo.id] ? "Edit" : "Add"}
                        </Button>
                      </div>
                    }
                  />
                ) : null}
              </div>
            );
          })}
      </SettingCard>
      <SandboxScriptDialog
        open={Boolean(scriptRepo)}
        onOpenChange={(open) => {
          if (!open) setScriptRepo(null);
        }}
        title={`${scriptRepo?.label || scriptRepo?.id || ""} setup script`}
        description="Runs once per new Sandbox, before .agents/setup. Keep secrets out of it."
        value={
          scriptRepo
            ? (lifecycle?.preSetupScripts[scriptRepo.id] ?? null)
            : null
        }
        placeholder={"#!/usr/bin/env bash\nset -euo pipefail\nbun install"}
        onSave={async (script) => {
          if (!scriptRepo) return;
          setLifecycle(await saveRepoPreSetupScript(scriptRepo.id, script));
        }}
      />
      <SettingsHint>
        The choice in the new session menu still wins.
      </SettingsHint>
    </>
  );
}

export function WorkspaceSandboxDefaults() {
  return (
    <>
      <SettingsGroupLabel className="mt-0">
        Session environment
      </SettingsGroupLabel>
      <SettingCard>
        <SandboxDefaultRow scope="workspace" />
      </SettingCard>
      <ProjectSandboxDefaults />
    </>
  );
}
