import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Popover } from "../ui/popover";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { OptionSelect } from "../ui/select";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { Spinner } from "../ui/spinner";
import {
  SettingCard,
  SettingRow,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
  rowMenuTriggerClasses,
  settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";
import {
  IconArrowUpToLine,
  IconBranches,
  IconDotsHorizontal,
  IconPlus,
} from "./icons";
import { RepoTile } from "./RepoTile";
import {
  REPO_TILE_COLORS,
  REPO_TILE_INK,
  repoColor,
  repoIconFill,
} from "../lib/repo-colors";
import { repoLetter } from "../lib/repo-label";
import { pngFromImageFile } from "../lib/icon-image";
import { setupRepoDefaultBranch } from "../lib/setup-repo";
import {
  fetchRepos,
  notifyReposChanged,
  repoGithubAvatarUrl,
  setRepoAppearanceApi,
  uploadRepoIconApi,
  type RepoInfo,
} from "../lib/api";
import {
  StateChip,
  repoLifecycleState,
  setupRequest,
  type BrowseRepo,
  type SetupRepo,
  type SetupStatus,
} from "./setup-shared";
import { Badge } from "../ui/badge";
import { errorMessage } from "../lib/error-message";

// Settings → Setup → Repositories: the registered repos sessions work in,
// plus an add flow. With a GitHub credential (a connected account or the bot
// token) the add flow browses the reachable repos; without one it falls back
// to a manual owner/name entry. When the code.storage integration is
// configured, its org's repos are offered in their own section alongside
// GitHub. Remote registration clones server-side, so an add can take tens of
// seconds. Pending state stays owned by the settings panel so it remains
// visible if the dialog closes. Existing local checkouts register in place.

export function ReposSection({
  repos,
  onChanged,
  onRepoUpdated,
  compact = false,
  showLifecycleStatus = true,
}: {
  repos: SetupStatus["repos"];
  onChanged: () => void | Promise<void>;
  onRepoUpdated?: (
    updated: Pick<SetupRepo, "id"> &
      Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
  ) => void;
  compact?: boolean;
  showLifecycleStatus?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<PendingRepo | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Focused when the picker opens, so a long list is one keystroke from
  // being filtered. Only one of the picker's two inputs renders at a time.
  const pickerInput = useRef<HTMLInputElement>(null);
  // Tile appearance rides on the repo list rather than the setup status: the
  // same payload every tile in the app reads, so what this page shows and
  // what the sidebar paints can't drift apart.
  const [appearance, setAppearance] = useState<Map<string, RepoInfo>>(
    new Map(),
  );
  const repoIds = repos.map((repo) => repo.id).join("\0");
  // Stable identity: only setters and module functions are captured, so the
  // effect can list it and still refire only when repoIds changes.
  const loadAppearance = useCallback(async () => {
    const list = await fetchRepos().catch(() => []);
    setAppearance(new Map(list.map((r) => [r.id, r])));
  }, []);
  useEffect(() => {
    loadAppearance();
  }, [loadAppearance, repoIds]);
  return (
    <>
      {/* The label is the count: the page and the wizard step are both
			    already titled "Repositories", so repeating the word says
			    nothing, while how many are registered is worth reading. */}
      <SettingsGroupLabel
        // first:mt-0 because this section opens the setup wizard's repos
        // step, where the label needs no space above it. On the settings
        // page it follows the default-repository card and keeps the
        // group's own mt-9, which is what separates the two.
        className={cn("first:mt-0", compact && "text-body text-fg/65")}
        actions={
          <Button
            size="sm"
            variant="primary"
            className="bg-fg text-bg hover:bg-fg/85"
            icon={pendingRepo ? <Spinner /> : <IconPlus size={16} />}
            disabled={pendingRepo !== null}
            onClick={() => setPickerOpen(true)}
          >
            {pendingRepo
              ? pendingRepo.action === "clone"
                ? "Cloning…"
                : "Registering…"
              : "Add repository"}
          </Button>
        }
      >
        {repos.length === 0
          ? "No repositories"
          : repos.length === 1
            ? "1 repository"
            : `${repos.length} repositories`}
      </SettingsGroupLabel>
      {/* On top rather than inline: the picker is a list of its own, and
			    pushing the registered repos down the page to browse a second
			    list made the two read as one. Adding stays a detour. */}
      {pickerError && !pickerOpen && (
        <InlineAlert className="mb-3">{pickerError}</InlineAlert>
      )}
      <Modal.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Modal.Content
          widthClassName="max-w-[34rem]"
          initialFocus={pickerInput}
        >
          <Modal.Header
            title="Add repository"
            description="Clone a remote repository or register a Git checkout already on the server."
          />
          <AddRepoPicker
            inputRef={pickerInput}
            onAdded={onChanged}
            pendingRepo={pendingRepo}
            onPendingChange={setPendingRepo}
            error={pickerError}
            setError={setPickerError}
          />
        </Modal.Content>
      </Modal.Root>
      <SettingCard>
        {repos.length === 0 ? (
          <EmptyState placement="row">
            No repositories registered. Ask and Code sessions need a repo to
            work in, so add one above.
          </EmptyState>
        ) : (
          repos.map((repo) => {
            if (!compact) {
              return (
                <RepositoryRow
                  key={repo.id}
                  repo={repo}
                  appearance={appearance.get(repo.id)}
                  onAppearanceChanged={loadAppearance}
                  onChanged={onChanged}
                  onRepoUpdated={onRepoUpdated}
                />
              );
            }
            const lifecycle = repoLifecycleState(repo);
            return (
              <SettingRow key={repo.id}>
                <RepoTileButton
                  repo={appearance.get(repo.id)}
                  id={repo.id}
                  onChanged={loadAppearance}
                  glow
                />
                <SettingRowText>
                  <SettingRowTitle>{repo.label}</SettingRowTitle>
                </SettingRowText>
                {showLifecycleStatus && (
                  <StateChip tone={lifecycle.tone} label={lifecycle.label} />
                )}
                {/* Same ⋯ menu as the settings page: a compact row is still a
								    repo someone may need to repoint or re-mode. */}
                <RepoActionsMenu
                  repo={repo}
                  appearance={appearance.get(repo.id)}
                  onChanged={onChanged}
                  onRepoUpdated={onRepoUpdated}
                />
              </SettingRow>
            );
          })
        )}
      </SettingCard>
      <SettingsHint className={compact ? "text-fg/55" : undefined}>
        Remote repositories are cloned onto the server. Local folders stay where
        they are. Code sessions use isolated worktrees by default. New repos are
        usable right away with no restart. Commit <code>.agents/</code> scripts
        to provision those worktrees and boot previews. See
        docs/repo-lifecycle.md.
      </SettingsHint>
    </>
  );
}

function RepositoryRow({
  repo,
  appearance,
  onAppearanceChanged,
  onChanged,
  onRepoUpdated,
}: {
  repo: SetupStatus["repos"][number];
  appearance: RepoInfo | undefined;
  onAppearanceChanged: () => Promise<void>;
  onChanged: () => void | Promise<void>;
  onRepoUpdated?: (
    updated: Pick<SetupRepo, "id"> &
      Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
  ) => void;
}) {
  const lifecycle = repoLifecycleState(repo);

  return (
    <SettingRow className="items-start">
      <RepoTileButton
        repo={appearance}
        id={repo.id}
        onChanged={onAppearanceChanged}
      />
      <SettingRowText>
        <div className="flex items-center justify-between gap-2">
          <SettingRowTitle className="min-w-0 truncate">
            {repo.label}
          </SettingRowTitle>
          <span className="hidden shrink-0 phone:inline-flex">
            <StateChip tone={lifecycle.tone} label={lifecycle.label} />
          </span>
        </div>
        <SettingRowDescription className="truncate font-mono text-meta">
          {repo.path}
        </SettingRowDescription>
      </SettingRowText>
      <div className="flex shrink-0 items-center gap-2">
        <span className="phone:hidden">
          <StateChip tone={lifecycle.tone} label={lifecycle.label} />
        </span>
        <RepoActionsMenu
          repo={repo}
          appearance={appearance}
          onChanged={onChanged}
          onRepoUpdated={onRepoUpdated}
        />
      </div>
    </SettingRow>
  );
}

/** A repo row's ⋯ menu and its consequences: the default-branch dialog and
 *  the isolated-worktrees toggle. Shared by the settings page's full row and
 *  the wizard's compact rows, so both surfaces manage a repo identically. */
function RepoActionsMenu({
  repo,
  appearance,
  onChanged,
  onRepoUpdated,
}: {
  repo: SetupStatus["repos"][number];
  appearance: RepoInfo | undefined;
  onChanged: () => void | Promise<void>;
  onRepoUpdated?: (
    updated: Pick<SetupRepo, "id"> &
      Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
  ) => void;
}) {
  // A hot frontend rebuild can briefly run against the prior setup-status
  // payload, which omitted defaultBranch. The repository payload already had
  // it, so use that as the compatibility fallback instead of crashing while
  // the backend waits for its deliberate restart.
  const defaultBranch = setupRepoDefaultBranch(repo, appearance);
  const [branch, setBranch] = useState(defaultBranch);
  const [isolatedWorktrees, setIsolatedWorktrees] = useState(
    repo.isolatedWorktrees,
  );
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [saving, setSaving] = useState<"branch" | "worktrees" | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const branchErrorId = useId();
  const branchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBranch(defaultBranch);
  }, [defaultBranch]);
  useEffect(() => {
    setIsolatedWorktrees(repo.isolatedWorktrees);
  }, [repo.isolatedWorktrees]);

  const normalized = branch.trim();
  const changed = normalized !== defaultBranch;

  async function saveBranch(event: React.FormEvent) {
    event.preventDefault();
    if (!normalized || !changed || saving) return;
    setSaving("branch");
    setBranchError(null);
    try {
      const updated = await setupRequest<{
        id: string;
        defaultBranch: string;
      }>(`/api/setup/repos/${encodeURIComponent(repo.id)}`, {
        method: "PATCH",
        json: { defaultBranch: normalized },
      });
      setBranch(updated.defaultBranch);
      if (onRepoUpdated) onRepoUpdated(updated);
      else await onChanged();
      setBranchDialogOpen(false);
      toast(`${repo.label} default branch updated`);
    } catch (error) {
      setBranchError(errorMessage(error, "Failed to update default branch"));
    }
    setSaving(null);
  }

  async function saveWorktreeMode(next: boolean) {
    if (saving) return;
    const previous = isolatedWorktrees;
    setIsolatedWorktrees(next);
    setSaving("worktrees");
    try {
      const updated = await setupRequest<{
        id: string;
        defaultBranch: string;
        isolatedWorktrees: boolean;
      }>(`/api/setup/repos/${encodeURIComponent(repo.id)}`, {
        method: "PATCH",
        json: { isolatedWorktrees: next },
      });
      setIsolatedWorktrees(updated.isolatedWorktrees);
      if (onRepoUpdated) onRepoUpdated(updated);
      else await onChanged();
      toast(`${repo.label} worktree setting updated`);
    } catch (error) {
      setIsolatedWorktrees(previous);
      // No row of its own to paint an inline alert on anymore: this menu
      // serves both the settings row and the wizard's compact rows, so
      // failures surface app-wide instead.
      toast(errorMessage(error, "Failed to update worktree setting"), {
        variant: "error",
      });
    }
    setSaving(null);
  }

  function openBranchDialog() {
    setBranch(defaultBranch);
    setBranchError(null);
    setBranchDialogOpen(true);
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className={rowMenuTriggerClasses}
          aria-label={`Manage ${repo.label}`}
        >
          <IconDotsHorizontal size={18} />
        </Menu.Trigger>
        <Menu.Popup align="end" sideOffset={4}>
          <Menu.Item onClick={openBranchDialog}>
            <IconBranches size={17} className="text-dim" />
            <span className="min-w-0 flex-1 truncate">Default branch</span>
            <Menu.Shortcut className="max-w-28 truncate font-mono">
              {defaultBranch}
            </Menu.Shortcut>
          </Menu.Item>
          <Menu.Separator />
          <Menu.CheckboxItem
            checked={isolatedWorktrees}
            disabled={!!saving}
            onCheckedChange={(next) => void saveWorktreeMode(next)}
            closeOnClick
          >
            <span className="min-w-0 flex-1 truncate">
              Use isolated worktrees
            </span>
            <Menu.Check on={isolatedWorktrees} />
          </Menu.CheckboxItem>
        </Menu.Popup>
      </Menu.Root>
      <Modal.Root
        open={branchDialogOpen}
        onOpenChange={(open) => {
          if (saving === "branch") return;
          setBranchDialogOpen(open);
          if (!open) {
            setBranch(defaultBranch);
            setBranchError(null);
          }
        }}
        disablePointerDismissal={saving === "branch"}
      >
        <Modal.Content initialFocus={branchInputRef}>
          <form className="flex flex-col gap-4" onSubmit={saveBranch}>
            <Modal.Header
              title={
                <span className="flex items-center gap-2.5">
                  <RepoTile name={repo.id} size={28} />
                  <span className="min-w-0 truncate">Default branch</span>
                </span>
              }
              description={`Choose the branch new sessions use for ${repo.label}.`}
            />
            <Field label="Branch">
              <Input
                ref={branchInputRef}
                className="font-mono phone:min-h-11 phone:text-input-phone"
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                  setBranchError(null);
                }}
                disabled={saving === "branch"}
                aria-invalid={!!branchError}
                aria-describedby={branchError ? branchErrorId : undefined}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            {branchError && (
              <InlineAlert id={branchErrorId}>{branchError}</InlineAlert>
            )}
            <Modal.Footer>
              <Button
                type="button"
                variant="ghost"
                className="phone:min-h-11"
                disabled={saving === "branch"}
                onClick={() => setBranchDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="phone:min-h-11"
                disabled={!normalized || !changed || !!saving}
              >
                {saving === "branch" ? "Saving…" : "Save"}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

/**
 * The repo's tile, and the controls behind it. The tile is the trigger because
 * it's the thing being edited — a separate "edit tile" button would say less
 * than the picture it changes.
 *
 * One grid of tiles, because there is one question: what does this repo look
 * like? A color and an icon used to be separate controls, which made picking a
 * color while art was set do nothing you could see. Here every cell is the
 * tile you'd get — the palette colors carrying the repo's letter, the owner's
 * GitHub avatar (fetched up front, so the picture itself is the choice rather
 * than something a "Fetch from GitHub" press might produce), and art of your
 * own — and picking a color is also how you take art back off.
 *
 * A repo wears a colored letter by default: GitHub has no per-repo art, so
 * taking the owner's avatar for every repo put one identical tile on all of
 * them.
 */
function RepoTileButton({
  id,
  repo,
  onChanged,
  glow = false,
}: {
  id: string;
  repo: RepoInfo | undefined;
  onChanged: () => Promise<void>;
  glow?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The avatar is offered only once we know there is one: the route 404s for
  // a repo with no GitHub remote, and GitHub can be unreachable.
  const [avatarOk, setAvatarOk] = useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  async function run<Result>(work: () => Promise<Result>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (error) {
      setError(errorMessage(error, "Failed to update repository appearance"));
    }
    setBusy(false);
  }

  const apply = (patch: { color?: string | null; icon?: "github" | null }) =>
    run(() => setRepoAppearanceApi(id, patch));

  // On automatic when nothing was chosen for it and it wears no art.
  const autoActive = !repo?.hasIcon && !repo?.colorChosen;

  async function upload(file: File) {
    await run(async () => {
      const png = await pngFromImageFile(file);
      await uploadRepoIconApi(id, png);
    });
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          "shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,#6b8afd)]",
          repo?.iconSource === "github" ? "rounded-full" : "rounded-sm",
        )}
        aria-label={`Change ${id}'s icon`}
      >
        <RepoTile
          name={id}
          size={28}
          glow={glow}
          className="ring-1 ring-inset ring-line"
        />
      </Popover.Trigger>
      <Popover.Popup className="w-[248px] p-3" initialFocus>
        <div className="mb-2 text-meta font-medium text-dim">Icon</div>
        {/* Faded while automatic is on: these choices aren't in effect.
				    Still live, though — picking one is how you leave automatic,
				    so the fade never becomes a mode you have to escape first. */}
        <div
          className={cn(
            "grid grid-cols-6 gap-2 transition-opacity duration-150",
            autoActive && "opacity-40",
          )}
        >
          {REPO_TILE_COLORS.map((color) => (
            <TileChoice
              key={color}
              // Named by what it does, not by its hex: "#b04e90"
              // tells a screen reader nothing.
              label={`Letter icon, color ${REPO_TILE_COLORS.indexOf(color) + 1} of ${REPO_TILE_COLORS.length}`}
              // Picking a color takes art off too — otherwise the
              // choice would be invisible on a repo wearing art.
              active={!autoActive && !repo?.hasIcon && repo?.color === color}
              disabled={busy}
              onClick={() => apply({ color, icon: null })}
            >
              <LetterTile id={id} color={color} />
            </TileChoice>
          ))}
          {/* Fetched as soon as the popover opens, so the avatar is a
					    picture you pick rather than one a button might produce.
					    The route 404s when there's nothing to take, and the
					    choice simply doesn't appear. */}
          <img
            src={repoGithubAvatarUrl(id)}
            alt=""
            className="hidden"
            onLoad={() => setAvatarOk(true)}
            onError={() => setAvatarOk(false)}
          />
          {avatarOk && (
            <TileChoice
              label={`${repo?.ghRepo?.split("/")[0]}’s GitHub avatar`}
              active={repo?.iconSource === "github"}
              disabled={busy}
              onClick={() => apply({ icon: "github" })}
            >
              <img
                src={repoGithubAvatarUrl(id)}
                alt=""
                className="h-full w-full rounded-control object-cover"
              />
            </TileChoice>
          )}
          <TileChoice
            label="Upload an image"
            active={repo?.iconSource === "upload"}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <span className="flex h-full w-full items-center justify-center rounded-control border border-dashed border-line text-dim">
              <IconArrowUpToLine size={14} />
            </span>
          </TileChoice>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so picking the same file twice still fires.
              e.target.value = "";
              if (file) upload(file);
            }}
          />
        </div>
        {/* The default, as a switch: it's a mode, not a thirteenth
				    choice. Off pins whatever it was giving, so leaving
				    automatic never lands the repo somewhere it wasn't. */}
        <label className="mt-3 flex cursor-pointer items-center gap-2 pt-1">
          <span className="h-5 w-5 shrink-0">
            <LetterTile id={id} color={repo?.autoColor} />
          </span>
          <span className="min-w-0 flex-1 text-control-label text-fg">
            Automatic
          </span>
          <Switch
            checked={autoActive}
            disabled={busy}
            onCheckedChange={(on: boolean) =>
              apply(
                on
                  ? { color: null, icon: null }
                  : { color: repo?.autoColor ?? repo?.color ?? null },
              )
            }
          />
        </label>
        <div className="mt-1.5 text-supporting leading-relaxed text-faint">
          {busy
            ? "Working…"
            : avatarOk
              ? `Automatic keeps this repo on a color no other repo has. The avatar is ${repo?.ghRepo?.split("/")[0]}’s. Every repo that owner has shows the same picture.`
              : "Automatic keeps this repo on a color no other repo has."}
        </div>
        {error && <InlineAlert className="mt-2">{error}</InlineAlert>}
      </Popover.Popup>
    </Popover.Root>
  );
}

/** One cell of the tile grid: a preview of what picking it would give. */
function TileChoice({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-control outline-none transition-transform",
        "hover:scale-110 focus-visible:ring-2 focus-visible:ring-[var(--accent,#6b8afd)]",
        active && "ring-2 ring-fg ring-offset-2 ring-offset-panel",
      )}
    >
      {children}
    </button>
  );
}

/** The letter tile as this color would look. Not RepoTile: that paints the
 *  art when a repo has any, and these cells are previews of not having it. */
function LetterTile({ id, color }: { id: string; color?: string }) {
  return (
    <span
      className="flex h-full w-full items-center justify-center rounded-control text-[15px] font-bold"
      style={{
        background: repoIconFill(color ?? repoColor(id)),
        color: REPO_TILE_INK,
      }}
    >
      {repoLetter(id)}
    </span>
  );
}

/** One account the workspace GitHub App is installed on. `selected` marks the
 * optional default for calls that do not name a repository. */
interface BrowseInstallation {
  login: string;
  type?: string;
  selected?: boolean;
}

interface BrowseResult {
  source: "user" | "app" | null;
  repos: BrowseRepo[];
  appConfigured?: boolean;
  appInstallUrl?: string | null;
  /** The configured installation owner, when the App identity can answer. */
  installationOwner?: string | null;
  /** Every account the App is installed on. Absent when the App identity
   * cannot list them. */
  installations?: BrowseInstallation[];
  /** Installations whose token or repository list could not be loaded. */
  unavailableInstallations?: string[];
}

/** Explains an empty App installation set instead of a bare "No repositories
 * match.", which reads as a filter miss. */
export function emptyAppInstallationMessage(browse: {
  installations?: BrowseInstallation[];
}): string {
  if ((browse.installations?.length ?? 0) > 1) {
    return "These App installations can’t see any repositories yet. Grant the App repository access on GitHub, then reopen this window.";
  }
  const owner = browse.installations?.[0]?.login;
  return `The App installation${owner ? ` for ${owner}` : ""} can’t see any repositories yet. Grant it repository access on GitHub, then reopen this window.`;
}

/** GET /api/setup/codestorage/repos — `source: null` when the code.storage
 * integration isn't configured (the wizard probes it unconditionally). */
interface CsBrowseResult {
  source: "org" | null;
  repos: BrowseRepo[];
}

type RepoSource = "github" | "codestorage";
type AddRepoMode = "remote" | "local";

interface PendingRepo {
  label: string;
  action: "clone" | "register";
}

interface RepoRegistration {
  pending: PendingRepo;
  json: Record<string, string>;
  successMessage: string;
  onRegistered?: () => void;
}

function filterRepos(repos: BrowseRepo[], filter: string): BrowseRepo[] {
  const q = filter.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter(
    (r) =>
      r.fullName.toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q),
  );
}

function RepoPickRow({
  repo,
  registered,
  onAdd,
}: {
  repo: BrowseRepo;
  registered: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-1 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-control-label font-medium text-fg">
            {repo.fullName}
          </span>
          {repo.private && <Badge>private</Badge>}
        </div>
        {repo.description && (
          <div className="mt-0.5 truncate text-supporting text-faint">
            {repo.description}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant={registered ? "ghost" : "default"}
        disabled={registered}
        onClick={onAdd}
      >
        {registered ? "Added" : "Add"}
      </Button>
    </div>
  );
}

function AddRepoPicker({
  inputRef,
  onAdded,
  pendingRepo,
  onPendingChange,
  error,
  setError,
}: {
  /** Focused once the list resolves. Which input exists depends on whether
   *  there's a credential to browse with, so both branches take it. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onAdded: () => void | Promise<void>;
  pendingRepo: PendingRepo | null;
  onPendingChange: (pending: PendingRepo | null) => void;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const [mode, setMode] = useState<AddRepoMode>("remote");
  const [localPath, setLocalPath] = useState("");

  useEffect(() => {
    if (!pendingRepo && mode === "local") inputRef?.current?.focus();
  }, [mode, pendingRepo, inputRef]);

  async function registerRepo(input: RepoRegistration): Promise<void> {
    if (pendingRepo) return;
    onPendingChange(input.pending);
    setError(null);
    try {
      // Remote clones can take tens of seconds. Keep the request unbounded and
      // the panel-level pending state visible until registration and refresh end.
      await setupRequest("/api/setup/repos", {
        method: "POST",
        json: input.json,
      });
      input.onRegistered?.();
      toast(input.successMessage);
      notifyReposChanged();
      await onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    onPendingChange(null);
  }

  async function addLocalRepo() {
    const path = localPath.trim();
    if (!path) return;
    await registerRepo({
      pending: { label: path, action: "register" },
      json: { source: "local", path },
      successMessage: "Repository registered",
      onRegistered: () => setLocalPath(""),
    });
  }

  return (
    // No surface of its own: the dialog is already the card this sits on.
    <div>
      {pendingRepo && (
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <LoadingState className="max-w-full [&>div]:max-w-full">
            <span className="max-w-full break-all">
              {pendingRepo.action === "clone" ? "Cloning " : "Registering "}
              {pendingRepo.label}…
            </span>
          </LoadingState>
          <p className="m-0 mt-2 max-w-[38ch] text-supporting leading-relaxed text-dim">
            You can close this window. The repository will appear here when it
            is ready.
          </p>
        </div>
      )}
      <div className={pendingRepo ? "hidden" : undefined}>
        <Segmented
          className="mb-3 w-full"
          label="Repository source"
          value={mode}
          onValueChange={(value) => {
            if (value === "remote" || value === "local") setMode(value);
            setError(null);
          }}
        >
          <SegmentedOption
            value="remote"
            className="flex flex-1 justify-center"
          >
            Remote
          </SegmentedOption>
          <SegmentedOption value="local" className="flex flex-1 justify-center">
            Local folder
          </SegmentedOption>
        </Segmented>
        {mode === "local" && (
          <>
            <div className="text-supporting leading-relaxed text-dim">
              Use a Git checkout on the server with a working origin remote.
            </div>
            <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
              <input
                ref={inputRef}
                className={cn(settingsInputClass, "min-w-0 flex-1 font-mono")}
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/srv/repos/repository"
                aria-label="Absolute repository path"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && localPath.trim()) addLocalRepo();
                }}
              />
              <Button
                variant="primary"
                disabled={!localPath.trim()}
                onClick={addLocalRepo}
              >
                Add
              </Button>
            </div>
          </>
        )}
        <div className={mode === "remote" ? undefined : "hidden"}>
          <RemoteRepoPicker
            active={mode === "remote" && !pendingRepo}
            inputRef={inputRef}
            registerRepo={registerRepo}
          />
        </div>
      </div>
      {error && <InlineAlert className="mt-2.5">{error}</InlineAlert>}
    </div>
  );
}

function RemoteRepoPicker({
  active,
  inputRef,
  registerRepo,
}: {
  active: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  registerRepo: (input: RepoRegistration) => Promise<void>;
}) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [browseFailed, setBrowseFailed] = useState(false);
  // code.storage list, probed alongside GitHub. Stays null until the probe
  // answers; an unconfigured integration answers `source: null` (no section).
  const [csBrowse, setCsBrowse] = useState<CsBrowseResult | null>(null);
  // Configured-but-failing (bad key path, API outage): the route answers 502
  // with the server's error, unlike the unconfigured 200 response.
  const [csError, setCsError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [manual, setManual] = useState("");
  // Repinning the App installation (below) is a config write plus a refetch;
  // both gate the switcher so a slow answer can't interleave two switches.
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadGithubRepos = async () => {
      try {
        const body = await setupRequest<BrowseResult>(
          "/api/setup/github/repos",
        );
        if (!cancelled) setBrowse(body);
      } catch {
        if (!cancelled) setBrowseFailed(true);
      }
    };
    const loadCodeStorageRepos = async () => {
      try {
        const body = await setupRequest<CsBrowseResult>(
          "/api/setup/codestorage/repos",
        );
        if (!cancelled) setCsBrowse(body);
      } catch (error) {
        // Configured-but-failing errors stay visible while GitHub remains
        // usable. An unconfigured integration returns source: null instead.
        if (!cancelled)
          setCsError(
            errorMessage(error, "Couldn’t reach code.storage right now."),
          );
      }
    };
    void loadGithubRepos();
    void loadCodeStorageRepos();
    return () => {
      cancelled = true;
    };
  }, []);

  // The list arrives after the dialog opens, so initialFocus has no field yet.
  useEffect(() => {
    if (active && (browse || browseFailed)) inputRef?.current?.focus();
  }, [active, browse, browseFailed, inputRef]);

  /** Choose the default for GitHub calls that do not name a repository.
   * Repository browsing and repository work still use every installation. */
  async function selectInstallation(login: string) {
    if (switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await setupRequest("/api/setup/github", {
        method: "PUT",
        json: { installationOwner: login },
      });
      const body = await setupRequest<BrowseResult>("/api/setup/github/repos");
      setBrowse(body);
      setBrowseFailed(false);
    } catch (e) {
      setSwitchError(errorMessage(e, "Couldn’t switch the installation."));
    }
    setSwitching(false);
  }

  async function addRepo(fullName: string, source: RepoSource = "github") {
    const key = `${source}:${fullName}`;
    await registerRepo({
      pending: { label: fullName, action: "clone" },
      json: source === "codestorage" ? { source, fullName } : { fullName },
      successMessage: `${fullName} registered`,
      onRegistered: () => {
        setAdded((previous) => new Set(previous).add(key));
        setManual("");
      },
    });
  }

  const filtered = filterRepos(browse?.repos ?? [], filter);
  const csFiltered = filterRepos(csBrowse?.repos ?? [], filter);
  const csConfigured = csBrowse?.source === "org";

  const manualValid = /^[^/\s]+\/[^/\s]+$/.test(manual.trim());
  const totalListed =
    (browse?.source ? browse.repos.length : 0) +
    (csConfigured ? (csBrowse?.repos.length ?? 0) : 0);
  const installations = browse?.installations ?? [];
  const selectedInstallation =
    installations.find((installation) => installation.selected)?.login ??
    browse?.installationOwner ??
    "";

  return (
    <>
      {!browse && !browseFailed ? (
        <LoadingState placement="row">
          Looking up your GitHub repositories…
        </LoadingState>
      ) : browse && browse.source !== null ? (
        <>
          {browse.source === "app" && installations.length > 1 && (
            <div className="mb-2 flex items-center gap-2 phone:flex-col phone:items-stretch">
              <span className="shrink-0 text-supporting text-dim">
                Default installation
              </span>
              <OptionSelect
                className="min-w-0 flex-1"
                size="sm"
                label="Default GitHub App installation"
                value={selectedInstallation}
                options={[
                  { value: "", label: "No default" },
                  ...installations.map((installation) => ({
                    value: installation.login,
                    label: installation.login,
                  })),
                ]}
                onChange={(login) => void selectInstallation(login)}
                disabled={switching}
              />
            </div>
          )}
          {switchError && (
            <InlineAlert className="mb-2">{switchError}</InlineAlert>
          )}
          {(browse.unavailableInstallations?.length ?? 0) > 0 && (
            <InlineAlert className="mb-2">
              Couldn&rsquo;t load repositories from{" "}
              {browse.unavailableInstallations?.join(", ")}.
            </InlineAlert>
          )}
          <input
            ref={inputRef}
            className={settingsInputClass}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${totalListed || browse.repos.length} ${
              (totalListed || browse.repos.length) === 1
                ? "repository"
                : "repositories"
            }…`}
            aria-label="Filter repositories"
            autoCapitalize="none"
            spellCheck={false}
          />
          <div className="mt-2 max-h-[320px] overflow-y-auto">
            {filtered.length === 0 ? (
              <EmptyState placement="row" className="px-1">
                {browse.repos.length > 0 || browse.source !== "app"
                  ? "No repositories match."
                  : emptyAppInstallationMessage(browse)}
              </EmptyState>
            ) : (
              filtered.map((r) => (
                <RepoPickRow
                  key={r.fullName}
                  repo={r}
                  registered={r.registered || added.has(`github:${r.fullName}`)}
                  onAdd={() => addRepo(r.fullName)}
                />
              ))
            )}
          </div>
          <div className="mt-2 text-meta text-faint">
            {browse.source === "user"
              ? "Browsing the connected account."
              : `Browsing ${installations.length} GitHub App ${installations.length === 1 ? "installation" : "installations"}. Tokens are scoped by repository owner.`}{" "}
            Only repositories that credential can reach are listed.
          </div>
        </>
      ) : (
        <>
          <div className="text-supporting leading-relaxed text-dim">
            {browseFailed ? (
              <>Couldn&rsquo;t load the GitHub repo list right now.</>
            ) : browse?.appConfigured ? (
              installations.length > 0 ? (
                <>
                  The App is installed on{" "}
                  {installations
                    .map((installation) => installation.login)
                    .join(", ")}
                  , but none of those installations could load repositories.
                </>
              ) : (
                <>
                  The GitHub App installation isn&rsquo;t available yet. Check
                  that the App is installed on at least one account, then reopen
                  this window.
                </>
              )
            ) : (
              <>
                No GitHub credential yet, so the repo list can&rsquo;t be
                browsed. Connect your GitHub account under Settings →
                Connections, or configure the GitHub App client id, slug, and
                private key in the GitHub sign-in card below.
              </>
            )}{" "}
            You can still register a repo by name:
          </div>
          {browse?.appConfigured && installations.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {installations.map((installation) => (
                <Button
                  key={installation.login}
                  disabled={switching}
                  onClick={() => void selectInstallation(installation.login)}
                >
                  Use {installation.login} as default
                </Button>
              ))}
            </div>
          )}
          {switchError && (
            <InlineAlert className="mt-2">{switchError}</InlineAlert>
          )}
          {browse?.appConfigured && browse.appInstallUrl && (
            <Button
              className="mt-2.5"
              variant="primary"
              render={
                <a
                  href={browse.appInstallUrl}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              Install GitHub App
            </Button>
          )}
          <div className="mt-2.5 flex items-center gap-2">
            <input
              ref={inputRef}
              className={cn(settingsInputClass, "flex-1 font-mono")}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="owner/name"
              aria-label="Repository full name"
              autoCapitalize="none"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualValid) addRepo(manual.trim());
              }}
            />
            <Button
              variant="primary"
              disabled={!manualValid}
              onClick={() => addRepo(manual.trim())}
            >
              Add
            </Button>
          </div>
        </>
      )}
      {(csConfigured || csError) && (
        <>
          <div className="mt-3 border-t border-line pt-3 text-meta font-medium text-dim">
            code.storage
          </div>
          {csError ? (
            <InlineAlert className="mt-1.5">
              code.storage is configured but its repo list failed: {csError}
            </InlineAlert>
          ) : (
            <div className="mt-1 max-h-[240px] overflow-y-auto">
              {csFiltered.length === 0 ? (
                <EmptyState placement="row" className="px-1">
                  {filter.trim()
                    ? "No code.storage repositories match."
                    : "No repositories visible to the org's signing key."}
                </EmptyState>
              ) : (
                csFiltered.map((r) => (
                  <RepoPickRow
                    key={r.fullName}
                    repo={r}
                    registered={
                      r.registered || added.has(`codestorage:${r.fullName}`)
                    }
                    onAdd={() => addRepo(r.fullName, "codestorage")}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
