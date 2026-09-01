import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Popover } from "../ui/popover";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
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
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hidden: {
    display: "none",
  },
  shrink0: {
    flexShrink: "0",
  },
  phoneInlineFlex: {
    "@media (max-width: 720px)": {
      display: "inline-flex",
    },
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  textDim: {
    color: "var(--text-dim)",
  },
  flex1: {
    flex: "1",
  },
  maxW28: {
    maxWidth: "calc(4px * 28)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  w248px: {
    width: "248px",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  hFull: {
    height: "100%",
  },
  wFull: {
    width: "100%",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  objectCover: {
    objectFit: "cover",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderDashed: {
    borderStyle: "dashed",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  pt1: {
    paddingTop: "4px",
  },
  h5: {
    height: "calc(4px * 5)",
  },
  w5: {
    width: "calc(4px * 5)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  text15px: {
    fontSize: "15px",
  },
  fontBold: {
    fontWeight: "var(--font-weight-bold)",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  px1: {
    paddingInline: "4px",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  minH240px: {
    minHeight: "240px",
  },
  textCenter: {
    textAlign: "center",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  breakAll: {
    wordBreak: "break-all",
  },
  m0: {
    margin: "0",
  },
  maxW38ch: {
    maxWidth: "38ch",
  },
  mt25: {
    marginTop: "calc(4px * 2.5)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  phoneItemsStretch: {
    "@media (max-width: 720px)": {
      alignItems: "stretch",
    },
  },
  maxH320px: {
    maxHeight: "320px",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  borderT: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
  },
  pt3: {
    paddingTop: "calc(4px * 3)",
  },
  mt1: {
    marginTop: "4px",
  },
  maxH240px: {
    maxHeight: "240px",
  },
});

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
        className={cn(
          "first:mt-0",
          compact && utilityClassName("text-body text-fg/65"),
        )}
        actions={
          <Button
            size="sm"
            variant="primary"
            className={mergeStylexOverrideClassName(
              "",
              sx.bgFg,
              sx.textBg,
              sx.hoverBgFg85,
            )}
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
        <InlineAlert className={mergeStylexOverrideClassName("", sx.mb3)}>
          {pickerError}
        </InlineAlert>
      )}
      <Modal.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Modal.Content
          widthClassName={utilityClassName("max-w-[34rem]")}
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
      <SettingsHint
        className={compact ? utilityClassName("text-fg/55") : undefined}
      >
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
    <SettingRow className={mergeStylexOverrideClassName("", sx.itemsStart)}>
      <RepoTileButton
        repo={appearance}
        id={repo.id}
        onChanged={onAppearanceChanged}
      />
      <SettingRowText>
        <div
          {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap2)}
        >
          <SettingRowTitle
            className={mergeStylexOverrideClassName("", sx.minW0, sx.truncate)}
          >
            {repo.label}
          </SettingRowTitle>
          <span {...stylex.props(sx.hidden, sx.shrink0, sx.phoneInlineFlex)}>
            <StateChip tone={lifecycle.tone} label={lifecycle.label} />
          </span>
        </div>
        <SettingRowDescription
          className={mergeStylexOverrideClassName(
            "",
            sx.truncate,
            sx.fontMono,
            typography.meta,
          )}
        >
          {repo.path}
        </SettingRowDescription>
      </SettingRowText>
      <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2)}>
        <span {...stylex.props(sx.phoneHidden)}>
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
            <IconBranches
              size={17}
              className={mergeStylexOverrideClassName("", sx.textDim)}
            />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              Default branch
            </span>
            <Menu.Shortcut
              className={mergeStylexOverrideClassName(
                "",
                sx.maxW28,
                sx.truncate,
                sx.fontMono,
              )}
            >
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
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
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
          <form
            {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}
            onSubmit={saveBranch}
          >
            <Modal.Header
              title={
                <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
                  <RepoTile name={repo.id} size={28} />
                  <span {...stylex.props(sx.minW0, sx.truncate)}>
                    Default branch
                  </span>
                </span>
              }
              description={`Choose the branch new sessions use for ${repo.label}.`}
            />
            <Field label="Branch">
              <Input
                ref={branchInputRef}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.fontMono,
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
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
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                disabled={saving === "branch"}
                onClick={() => setBranchDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
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

  async function run(work: () => Promise<unknown>) {
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
          utilityClassName(
            "shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,#6b8afd)]",
          ),
          repo?.iconSource === "github"
            ? utilityClassName("rounded-full")
            : utilityClassName("rounded-sm"),
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
      <Popover.Popup
        className={mergeStylexOverrideClassName("", sx.w248px, sx.p3)}
        initialFocus
      >
        <div
          {...stylex.props(sx.mb2, sx.fontMedium, sx.textDim, typography.meta)}
        >
          Icon
        </div>
        {/* Faded while automatic is on: these choices aren't in effect.
				    Still live, though — picking one is how you leave automatic,
				    so the fade never becomes a mode you have to escape first. */}
        <div
          className={cn(
            utilityClassName(
              "grid grid-cols-6 gap-2 transition-opacity duration-150",
            ),
            autoActive && utilityClassName("opacity-40"),
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
            {...stylex.props(sx.hidden)}
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
                {...stylex.props(
                  sx.hFull,
                  sx.wFull,
                  sx.roundedControl,
                  sx.objectCover,
                )}
              />
            </TileChoice>
          )}
          <TileChoice
            label="Upload an image"
            active={repo?.iconSource === "upload"}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <span
              {...stylex.props(
                sx.flex,
                sx.hFull,
                sx.wFull,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.roundedControl,
                sx.border,
                sx.borderDashed,
                sx.borderLine,
                sx.textDim,
              )}
            >
              <IconArrowUpToLine size={14} />
            </span>
          </TileChoice>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            {...stylex.props(sx.hidden)}
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
        <label
          {...stylex.props(
            sx.mt3,
            sx.flex,
            sx.cursorPointer,
            sx.itemsCenter,
            sx.gap2,
            sx.pt1,
          )}
        >
          <span {...stylex.props(sx.h5, sx.w5, sx.shrink0)}>
            <LetterTile id={id} color={repo?.autoColor} />
          </span>
          <span
            {...stylex.props(
              sx.minW0,
              sx.flex1,
              sx.textFg,
              typography.controlLabel,
            )}
          >
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
        <div
          {...stylex.props(
            sx.mt15,
            sx.leadingRelaxed,
            sx.textFaint,
            typography.supporting,
          )}
        >
          {busy
            ? "Working…"
            : avatarOk
              ? `Automatic keeps this repo on a color no other repo has. The avatar is ${repo?.ghRepo?.split("/")[0]}’s. Every repo that owner has shows the same picture.`
              : "Automatic keeps this repo on a color no other repo has."}
        </div>
        {error && (
          <InlineAlert className={mergeStylexOverrideClassName("", sx.mt2)}>
            {error}
          </InlineAlert>
        )}
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
        utilityClassName(
          "h-7 w-7 rounded-control outline-none transition-transform",
        ),
        utilityClassName(
          "hover:scale-110 focus-visible:ring-2 focus-visible:ring-[var(--accent,#6b8afd)]",
        ),
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
      {...stylex.props(
        sx.flex,
        sx.hFull,
        sx.wFull,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.roundedControl,
        sx.text15px,
        sx.fontBold,
      )}
      style={{
        background: repoIconFill(color ?? repoColor(id)),
        color: REPO_TILE_INK,
      }}
    >
      {repoLetter(id)}
    </span>
  );
}

interface BrowseResult {
  source: "user" | "app" | null;
  repos: BrowseRepo[];
  appConfigured?: boolean;
  appInstallUrl?: string | null;
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
    <div
      {...mergeStylexProps(
        "last:border-b-0",
        sx.flex,
        sx.itemsCenter,
        sx.gap3,
        sx.borderB,
        sx.borderLine,
        sx.px1,
        sx.py2,
      )}
    >
      <div {...stylex.props(sx.minW0, sx.flex1)}>
        <div {...stylex.props(sx.flex, sx.minW0, sx.itemsBaseline, sx.gap2)}>
          <span
            {...stylex.props(
              sx.truncate,
              sx.fontMedium,
              sx.textFg,
              typography.controlLabel,
            )}
          >
            {repo.fullName}
          </span>
          {repo.private && <Badge>private</Badge>}
        </div>
        {repo.description && (
          <div
            {...stylex.props(
              sx.mt05,
              sx.truncate,
              sx.textFaint,
              typography.supporting,
            )}
          >
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
        <div
          {...stylex.props(
            sx.flex,
            sx.minH240px,
            sx.flexCol,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.textCenter,
          )}
        >
          <LoadingState
            className={mergeStylexOverrideClassName(
              "[&>div]:max-w-full",
              sx.maxWFull,
            )}
          >
            <span {...stylex.props(sx.maxWFull, sx.breakAll)}>
              {pendingRepo.action === "clone" ? "Cloning " : "Registering "}
              {pendingRepo.label}…
            </span>
          </LoadingState>
          <p
            {...stylex.props(
              sx.m0,
              sx.mt2,
              sx.maxW38ch,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            You can close this window. The repository will appear here when it
            is ready.
          </p>
        </div>
      )}
      <div className={pendingRepo ? utilityClassName("hidden") : undefined}>
        <Segmented
          className={mergeStylexOverrideClassName("", sx.mb3, sx.wFull)}
          label="Repository source"
          value={mode}
          onValueChange={(value) => {
            setMode(value as AddRepoMode);
            setError(null);
          }}
        >
          <SegmentedOption
            value="remote"
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.flex1,
              sx.justifyCenter,
            )}
          >
            Remote
          </SegmentedOption>
          <SegmentedOption
            value="local"
            className={mergeStylexOverrideClassName(
              "",
              sx.flex,
              sx.flex1,
              sx.justifyCenter,
            )}
          >
            Local folder
          </SegmentedOption>
        </Segmented>
        {mode === "local" && (
          <>
            <div
              {...stylex.props(
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              Use a Git checkout on the server with a working origin remote.
            </div>
            <div
              {...stylex.props(
                sx.mt25,
                sx.flex,
                sx.itemsCenter,
                sx.gap2,
                sx.phoneFlexCol,
                sx.phoneItemsStretch,
              )}
            >
              <input
                ref={inputRef}
                className={cn(
                  settingsInputClass,
                  utilityClassName("min-w-0 flex-1 font-mono"),
                )}
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
        <div
          className={mode === "remote" ? undefined : utilityClassName("hidden")}
        >
          <RemoteRepoPicker
            active={mode === "remote" && !pendingRepo}
            inputRef={inputRef}
            registerRepo={registerRepo}
          />
        </div>
      </div>
      {error && (
        <InlineAlert className={mergeStylexOverrideClassName("", sx.mt25)}>
          {error}
        </InlineAlert>
      )}
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

  return (
    <>
      {!browse && !browseFailed ? (
        <LoadingState placement="row">
          Looking up your GitHub repositories…
        </LoadingState>
      ) : browse && browse.source !== null ? (
        <>
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
          <div {...stylex.props(sx.mt2, sx.maxH320px, sx.overflowYAuto)}>
            {filtered.length === 0 ? (
              <EmptyState
                placement="row"
                className={mergeStylexOverrideClassName("", sx.px1)}
              >
                No repositories match.
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
          <div {...stylex.props(sx.mt2, sx.textFaint, typography.meta)}>
            Browsing the
            {browse.source === "user"
              ? " connected account"
              : " GitHub App installation"}
            . Only repos that credential can reach are listed.
          </div>
        </>
      ) : (
        <>
          <div
            {...stylex.props(
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            {browseFailed ? (
              <>Couldn&rsquo;t load the GitHub repo list right now.</>
            ) : browse?.appConfigured ? (
              <>
                The GitHub App installation isn&rsquo;t available yet. Check
                that Installation owner matches the account where the App is
                installed, then reopen this window.
              </>
            ) : (
              <>
                No GitHub credential yet, so the repo list can&rsquo;t be
                browsed. Connect your GitHub account under Settings →
                Connections, or configure the GitHub App client id, slug,
                installation owner, and private key in the GitHub sign-in card
                below.
              </>
            )}{" "}
            You can still register a repo by name:
          </div>
          {browse?.appConfigured && browse.appInstallUrl && (
            <Button
              className={mergeStylexOverrideClassName("", sx.mt25)}
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
          <div {...stylex.props(sx.mt25, sx.flex, sx.itemsCenter, sx.gap2)}>
            <input
              ref={inputRef}
              className={cn(
                settingsInputClass,
                utilityClassName("flex-1 font-mono"),
              )}
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
          <div
            {...stylex.props(
              sx.mt3,
              sx.borderT,
              sx.borderLine,
              sx.pt3,
              sx.fontMedium,
              sx.textDim,
              typography.meta,
            )}
          >
            code.storage
          </div>
          {csError ? (
            <InlineAlert className={mergeStylexOverrideClassName("", sx.mt15)}>
              code.storage is configured but its repo list failed: {csError}
            </InlineAlert>
          ) : (
            <div {...stylex.props(sx.mt1, sx.maxH240px, sx.overflowYAuto)}>
              {csFiltered.length === 0 ? (
                <EmptyState
                  placement="row"
                  className={mergeStylexOverrideClassName("", sx.px1)}
                >
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
