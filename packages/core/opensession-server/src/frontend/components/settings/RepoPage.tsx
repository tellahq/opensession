import { useEffect, useState, type FormEvent } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import { fetchRepos, notifyReposChanged, type RepoInfo } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { setupRepoDefaultBranch } from "../../lib/setup-repo";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import { Input } from "../../ui/input";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import { RepoTileButton } from "../SetupRepos";
import { StateChip, repoLifecycleState, setupRequest } from "../setup-shared";
import { DependencyCacheSection } from "./DependencyCacheSection";
import { ProjectSandboxDefaults } from "./SandboxDefaults";
import { SettingRow } from "./shared";

/**
 * One repository's page, as Conductor gives each repository its own entry:
 * how sessions check it out, how its dependencies stay ready, where its
 * sessions and app run, and the way to remove it.
 */
export function RepoPage({
  repoId,
  onRemoved,
}: {
  repoId: string;
  onRemoved: () => void;
}) {
  const { status, failed, applyRepo, refetch } = useSetupStatus();
  const [appearance, setAppearance] = useState<RepoInfo | undefined>();
  const loadAppearance = async () => {
    const list = await fetchRepos().catch(() => []);
    setAppearance(list.find((entry) => entry.id === repoId));
  };
  useEffect(() => {
    let alive = true;
    fetchRepos()
      .then((list) => {
        if (alive) setAppearance(list.find((entry) => entry.id === repoId));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoId]);

  const repo = status?.repos.find((entry) => entry.id === repoId);
  const defaultBranch = repo ? setupRepoDefaultBranch(repo, appearance) : "";
  const [branch, setBranch] = useState(defaultBranch);
  useEffect(() => setBranch(defaultBranch), [defaultBranch]);
  const [saving, setSaving] = useState<
    "branch" | "worktrees" | "remove" | null
  >(null);
  const [confirm, confirmDialog] = useConfirm();

  if (!status)
    return (
      <SettingsPanel>
        {failed ? (
          <InlineAlert>Couldn&rsquo;t load this repository.</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={3} label="Loading repository" />
        )}
      </SettingsPanel>
    );
  if (!repo)
    return (
      <SettingsPanel>
        <EmptyState placement="card">
          This repository is no longer registered.
        </EmptyState>
      </SettingsPanel>
    );

  const label = repo.label;
  const lifecycle = repoLifecycleState(repo);
  const nextBranch = branch.trim();

  async function patch(
    field: "branch" | "worktrees",
    json: { defaultBranch?: string; isolatedWorktrees?: boolean },
  ) {
    setSaving(field);
    try {
      const updated = await setupRequest<{
        id: string;
        defaultBranch: string;
        isolatedWorktrees: boolean;
      }>(`/api/setup/repos/${encodeURIComponent(repoId)}`, {
        method: "PATCH",
        json,
      });
      applyRepo(updated);
    } catch (error) {
      toast(errorMessage(error, `Couldn’t update ${label}`), {
        variant: "error",
      });
    }
    setSaving(null);
  }

  function saveBranch(event: FormEvent) {
    event.preventDefault();
    if (!nextBranch || nextBranch === defaultBranch || saving) return;
    void patch("branch", { defaultBranch: nextBranch });
  }

  function remove() {
    confirm({
      title: `Remove ${label}?`,
      description:
        "Sessions can no longer use it. Its checkout stays on the server.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: async () => {
        setSaving("remove");
        try {
          await setupRequest(`/api/setup/repos/${encodeURIComponent(repoId)}`, {
            method: "DELETE",
          });
          notifyReposChanged();
          await refetch();
          toast(`${label} removed`);
          onRemoved();
        } catch (error) {
          toast(errorMessage(error, "Couldn’t remove the repository"), {
            variant: "error",
          });
        }
        setSaving(null);
      },
    });
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title={
          <span className="flex min-w-0 items-center gap-3">
            <RepoTileButton
              id={repo.id}
              repo={appearance}
              onChanged={loadAppearance}
            />
            <span className="min-w-0 truncate">{label}</span>
          </span>
        }
        description={
          <span className="block truncate font-mono text-meta">
            {repo.path}
          </span>
        }
        actions={<StateChip tone={lifecycle.tone} label={lifecycle.label} />}
      />

      <SettingsGroupLabel>Checkout</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Default branch"
          desc="New sessions start from it."
          control={
            <form className="flex items-center gap-2" onSubmit={saveBranch}>
              <Input
                aria-label="Default branch"
                className="w-40 font-mono phone:min-h-11 phone:text-input-phone"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {nextBranch !== defaultBranch && (
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={!nextBranch || saving === "branch"}
                >
                  Save
                </Button>
              )}
            </form>
          }
        />
        <SettingRow
          title="Isolated worktrees"
          desc="Each session gets its own worktree and branch."
          control={
            <Switch
              aria-label="Isolated worktrees"
              checked={repo.isolatedWorktrees}
              disabled={saving === "worktrees"}
              onCheckedChange={(next) =>
                void patch("worktrees", { isolatedWorktrees: next })
              }
            />
          }
        />
      </SettingCard>

      <DependencyCacheSection repoId={repo.id} />
      <ProjectSandboxDefaults repoId={repo.id} />

      <SettingsGroupLabel>Remove</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="Remove repository"
          desc={
            repo.isDefault
              ? "The default repository can’t be removed."
              : "Its checkout stays on the server."
          }
          control={
            <Button
              size="sm"
              variant="danger"
              disabled={repo.isDefault || saving === "remove"}
              onClick={remove}
            >
              Remove
            </Button>
          }
        />
      </SettingCard>
      {confirmDialog}
    </SettingsPanel>
  );
}
