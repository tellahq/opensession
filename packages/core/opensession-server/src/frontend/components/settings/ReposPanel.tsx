import { useEffect, useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { errorMessage } from "../../lib/error-message";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { Select, SettingRow } from "./shared";
import { InlineAlert } from "../../ui/state";
import { ReposSection } from "../SetupRepos";
import {
  configuredNewSessionRepo,
  fetchRepos,
  fetchWorktreeSettings,
  setNewSessionRepoApi,
  setSharedCheckoutMode,
  type RepoInfo,
  type SharedCheckoutMode,
  type WorktreeSettings,
} from "../../lib/api";
import { RepoTile } from "../RepoTile";
import { Radio, RadioGroup } from "../../ui/radio";

function SharedCheckoutSetting() {
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchWorktreeSettings()
      .then((value) => alive && setSettings(value))
      .catch(
        (cause: unknown) =>
          alive &&
          setError(errorMessage(cause, "Failed to load worktree settings")),
      );
    return () => {
      alive = false;
    };
  }, []);

  if (!settings) {
    return error ? (
      <InlineAlert className="mt-9">{error}</InlineAlert>
    ) : (
      <SettingCardSkeleton
        rows={1}
        label="Loading worktree settings"
        className="mt-9"
      />
    );
  }
  if (!settings.repos.length) return null;

  const repoNames = settings.repos.map((repo) => `"${repo.label}"`).join(", ");
  const groupLabel = "How sessions make changes to shared checkouts";
  async function setMode(mode: SharedCheckoutMode) {
    const previous = settings;
    if (!previous || mode === previous.mode) return;
    setSettings({ ...previous, mode });
    setSaving(true);
    setError(null);
    await (async () => {
      setSettings(await setSharedCheckoutMode(mode));
    })()
      .catch(async (cause: unknown) => {
        setSettings(previous);
        setError(
          errorMessage(cause, "Couldn’t save where sessions make changes"),
        );
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  return (
    <>
      <SettingsGroupLabel>{groupLabel}</SettingsGroupLabel>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingCard>
        <RadioGroup
          aria-label={groupLabel}
          value={settings.mode}
          disabled={saving}
          onValueChange={(mode) => {
            if (mode !== "shared" && mode !== "worktree") return;
            void setMode(mode);
          }}
          className="[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']"
        >
          <label className="flex min-h-11 cursor-pointer items-start gap-3 px-5 py-4 transition-[background-color] hover:bg-hover">
            <Radio value="shared" className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-item-title font-medium text-fg">
                Local checkout
              </span>
              <span className="mt-1 block text-supporting text-dim">
                Edit shared checkouts directly. Changes appear there right away,
                and sessions share the same files.
              </span>
            </span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 px-5 py-4 transition-[background-color] hover:bg-hover">
            <Radio value="worktree" className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-item-title font-medium text-fg">
                Separate pull request branch
              </span>
              <span className="mt-1 block text-supporting text-dim">
                Give each session an isolated Git worktree and branch. Changes
                stay separate from the local checkout, ready for a pull request.
              </span>
            </span>
          </label>
        </RadioGroup>
      </SettingCard>
      <SettingsHint>Only affects new sessions in {repoNames}.</SettingsHint>
    </>
  );
}

/**
 * Where a new session starts for everyone who hasn't set their own preference
 * (Settings → Preferences overrides this).
 */
function DefaultRepoRow() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // fetchRepos carries the setting alongside the list, so one load fills
    // both the options and the current choice.
    fetchRepos()
      .then((items) => {
        setRepos(items);
        setValue(configuredNewSessionRepo());
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Failed to load repositories")),
      );
  }, []);
  return (
    <SettingCard>
      <SettingRow
        title="Default repository"
        desc={
          error ||
          "Where a new session starts, for anyone who hasn't set their own."
        }
        control={
          <Select
            label="Default repository"
            value={
              repos.some((repo) => repo.id === value)
                ? value
                : repos[0]?.id || ""
            }
            options={repos.map((r) => ({
              value: r.id,
              label: r.label || r.id,
              icon: <RepoTile name={r.id} size={16} />,
            }))}
            onChange={(next) => {
              setValue(next);
              setError(null);
              void setNewSessionRepoApi(next).catch((cause: unknown) =>
                setError(
                  errorMessage(cause, "Failed to set the default repository"),
                ),
              );
            }}
          />
        }
      />
    </SettingCard>
  );
}

// Workspace → Repositories: the registered repos, and the add flow, on a page
// of their own. Same section the Setup wizard's repos step renders — a repo
// added here and a repo added there are the same act. No restart banner:
// registering a repo takes effect immediately.

export function ReposPanel() {
  const { status, failed, refetch, applyRepo } = useSetupStatus();
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Repositories"
        description="Register repositories and choose where their sessions work."
      />
      {!status ? (
        // A failure is an alert, not a quiet label under a spinner: it used
        // to render in the loading register, so the sentence saying the
        // page had given up sat beside a mark saying it was still trying.
        failed ? (
          <InlineAlert>Couldn&rsquo;t load the repositories.</InlineAlert>
        ) : (
          <>
            <SettingCardSkeleton rows={1} label="Loading repositories" />
            {/* mt-9 stands in for the group label above the list, which
						    counts the repos and so cannot be drawn before they
						    arrive. */}
            <SettingCardSkeleton rows={3} icon={28} className="mt-9" />
          </>
        )
      ) : (
        <>
          <DefaultRepoRow />
          <SharedCheckoutSetting />
          <ReposSection
            repos={status.repos}
            onChanged={refetch}
            onRepoUpdated={applyRepo}
          />
        </>
      )}
    </SettingsPanel>
  );
}
