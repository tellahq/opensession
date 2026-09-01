import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useMemo, useState } from "react";
import {
  cachedRepos,
  fetchRepos,
  attachRepoApi,
  detachRepoApi,
  fetchRepoSwitchable,
  switchPrimaryRepoApi,
  type RepoInfo,
  type AttachedRepo,
} from "../lib/api";
import { Menu } from "../ui/menu";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { IconCheck, IconPlus, IconX, IconChevronRight } from "./icons";
import { RepoTile, repoLabel } from "./RepoTile";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap7px: {
    gap: "7px",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py7px: {
    paddingBlock: "7px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  textLeft: {
    textAlign: "left",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  leadingNone: {
    lineHeight: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  leading12: {
    lineHeight: "1.2",
  },
  textFg: {
    color: "var(--text)",
  },
  shrink0: {
    flexShrink: "0",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  transitionColorBackgroundColorScale: {
    transitionProperty: "color,background-color,scale",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  ml1: {
    marginLeft: "4px",
  },
  Mx15: {
    marginInline: "calc(4px * -1.5)",
  },
  My1: {
    marginBlock: "calc(4px * -1)",
  },
  py1: {
    paddingBlock: "4px",
  },
  maxW180px: {
    maxWidth: "180px",
  },
  TranslateYPx: {
    translate: "0 -1px",
  },
  minW230px: {
    minWidth: "230px",
  },
  maxW240px: {
    maxWidth: "240px",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textRed: {
    color: "var(--red)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  rounded: {
    borderRadius: "var(--radius-xs)",
    cornerShape: "var(--cs)",
  },
  p05: {
    padding: "calc(4px * 0.5)",
  },
  pt15: {
    paddingTop: "calc(4px * 1.5)",
  },
  pb05: {
    paddingBottom: "calc(4px * 0.5)",
  },
  maxW220px: {
    maxWidth: "220px",
  },
});

interface Props {
  sessionId: string;
  primaryRepo: string;
  branch: string | null;
  initialAttached: AttachedRepo[];
  /**
   * How the trigger renders:
   *  - "breadcrumb" (default): the desktop session-header pill, followed by a
   *    "›" separator before the title.
   *  - "menu-row": a full-width row styled like the ⋯ overflow menu's other
   *    items.
   *  - "hero": the compact repository link below the phone Workspace title.
   */
  variant?: "breadcrumb" | "menu-row" | "hero";
}

/**
 * Repo segment of the session-header breadcrumb: `[icon] repo › title`.
 * Clicking the repo opens one menu that covers all cross-repo control —
 * switch the primary repo (any session, including a wrong choice made after
 * work started; the old worktree is left on disk so nothing is stranded, and
 * a switch-with-work is confirmed first), detach an attached repo, or attach
 * another (isolated worktree, same as the agent's opensession-repos attach_repo
 * tool — both go through POST /api/sessions/:id/attach-repo).
 */
export function RepoBar({
  sessionId,
  primaryRepo,
  branch,
  initialAttached,
  variant = "breadcrumb",
}: Props) {
  const [attached, setAttached] = useState<AttachedRepo[]>(initialAttached);
  const [primary, setPrimary] = useState(primaryRepo);
  // Opens on the repos this browser saw last (lib/repo-cache) and revalidates
  // behind them: the registered set barely moves, so waiting for /repos before
  // drawing a single row spent a request on a menu that was already right.
  const [repos, setRepos] = useState<RepoInfo[]>(cachedRepos);
  const [open, setOpen] = useState(false);
  const [switchable, setSwitchable] = useState(false); // false only for ask sessions
  const [hasWork, setHasWork] = useState(false); // already has edits/commits → confirm on switch
  const [busy, setBusy] = useState<string | null>(null); // trigger label while an action runs
  const [error, setError] = useState<string | null>(null);
  const [controlsLoadError, setControlsLoadError] = useState<string | null>(
    null,
  );
  const [reposLoadError, setReposLoadError] = useState<string | null>(null);
  // Switch-with-work confirmation. `confirmTarget` is the repo whose label the
  // dialog shows; `confirmOpen` drives visibility separately so the label
  // survives the exit animation (clearing the target would flash it to null).
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Keep in sync if the session prop changes (e.g. the agent attached one, or a
  // switch landed and the parent re-fetched). Compared by content: the parent
  // rebuilds the array each fetch.
  const initialAttachedKey = JSON.stringify(initialAttached);
  const initialAttachedValue = useMemo(
    () => JSON.parse(initialAttachedKey) as AttachedRepo[],
    [initialAttachedKey],
  );
  useEffect(() => setAttached(initialAttachedValue), [initialAttachedValue]);
  useEffect(() => setPrimary(primaryRepo), [primaryRepo]);

  // Can this session's primary repo be switched, and does it already have work?
  useEffect(() => {
    fetchRepoSwitchable(sessionId)
      .then(({ switchable, hasWork }) => {
        setSwitchable(switchable);
        setHasWork(hasWork);
        setControlsLoadError(null);
      })
      .catch((error: unknown) => {
        // Without fresh server state, hide switching rather than offer it from
        // stale flags. Attaching cached repositories remains independent.
        setSwitchable(false);
        setHasWork(false);
        setControlsLoadError(
          errorMessage(error, "Failed to load repository controls"),
        );
      });
  }, [sessionId, primary]);

  useEffect(() => {
    // Every open, not just the first: a repo added since is exactly what the
    // cached list is missing, and a failed refresh keeps the rows on screen.
    if (open)
      fetchRepos()
        .then((nextRepos) => {
          setRepos(nextRepos);
          setReposLoadError(null);
        })
        .catch((error: unknown) => {
          // Keep the cached rows visible while naming the failed revalidation.
          setReposLoadError(
            errorMessage(error, "Failed to refresh repositories"),
          );
        });
  }, [open]);

  const attachedIds = new Set(attached.map((r) => r.repo));
  const attachable = repos.filter(
    (p) => !p.sharedCheckout && p.id !== primary && !attachedIds.has(p.id),
  );
  // Switching can target any other repo (incl. shared-checkout like opensession).
  const switchTargets = repos.filter((p) => p.id !== primary);

  async function attach(repo: string) {
    setBusy("Attaching…");
    setError(null);
    await (async () => {
      setAttached(await attachRepoApi(sessionId, repo, branch || undefined));
    })()
      .catch(async (error: unknown) => {
        setError(errorMessage(error, "Failed to attach repository"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  async function detach(repo: string) {
    setBusy("Detaching…");
    setError(null);
    await (async () => {
      setAttached(await detachRepoApi(sessionId, repo));
    })()
      .catch(async (error: unknown) => {
        setError(errorMessage(error, "Failed to detach repository"));
      })
      .finally(async () => {
        setBusy(null);
      });
  }

  function switchPrimary(repo: string) {
    if (repo === primary) return;
    // Switching just repoints the session at another worktree — the current one
    // (branch, commits, edits) stays on disk. Confirm when there's work so the
    // move to a different codebase is a deliberate choice, not a surprise; a
    // fresh worktree switches straight through.
    if (hasWork) {
      setConfirmTarget(repo);
      setConfirmOpen(true);
      return;
    }
    void doSwitch(repo);
  }

  const doSwitch = async (repo: string) => {
    setConfirmOpen(false);
    setBusy("Switching…");
    setError(null);
    await (async () => {
      const res = await switchPrimaryRepoApi(sessionId, repo, hasWork);
      setPrimary(res.repo);
      setHasWork(false); // the new worktree starts fresh
      setAttached((prev) => prev.filter((r) => r.repo !== res.repo));
    })()
      .catch(async (error: unknown) => {
        setError(errorMessage(error, "Failed to switch repository"));
        // Resync in case a concurrent turn changed the session's state.
        fetchRepoSwitchable(sessionId)
          .then(({ switchable, hasWork }) => {
            setSwitchable(switchable);
            setHasWork(hasWork);
            setControlsLoadError(null);
          })
          .catch((refreshError: unknown) => {
            // The switch failure keeps the action error. This secondary loader
            // fails closed and reports inside the menu with the stale controls.
            setSwitchable(false);
            setHasWork(false);
            setControlsLoadError(
              errorMessage(
                refreshError,
                "Failed to refresh repository controls after switch failure",
              ),
            );
          });
      })
      .finally(async () => {
        setBusy(null);
      });
  };

  // Static (non-menu-item) row — current repo when it can't switch, attached rows.
  const staticRow = utilityClassName(
    "flex items-center gap-2 rounded-md px-2.5 py-2 text-control-label text-fg",
  );

  const trigger =
    variant === "menu-row" ? (
      // ⋯ overflow menu row (phone): matches the other menu items' shape.
      <Menu.Trigger
        className={mergeStylexOverrideClassName(
          "data-[popup-open]:bg-hover data-[popup-open]:text-fg",
          sx.flex,
          sx.wFull,
          sx.cursorPointer,
          sx.itemsCenter,
          sx.gap7px,
          sx.whitespaceNowrap,
          sx.roundedControl,
          sx.border,
          sx.borderLineStrong,
          sx.bgTransparent,
          sx.px3,
          sx.py7px,
          sx.fontMedium,
          sx.textFaint,
          sx.hoverBgHover,
          sx.hoverTextFg,
          typography.controlLabel,
        )}
        title="Switch or attach another repo"
      >
        <RepoTile name={primary} size={18} />
        <span
          {...stylex.props(
            sx.flex,
            sx.minW0,
            sx.flex1,
            sx.flexCol,
            sx.gap05,
            sx.textLeft,
          )}
        >
          <span
            {...stylex.props(
              sx.fontSemibold,
              sx.leadingNone,
              sx.textFaint,
              typography.meta,
            )}
          >
            Repository
          </span>
          <span
            {...stylex.props(
              sx.truncate,
              sx.leading12,
              sx.textFg,
              typography.controlLabel,
            )}
          >
            {busy ?? repoLabel(primary)}
            {attached.length > 0 && (
              <span {...stylex.props(sx.textFaint)}> +{attached.length}</span>
            )}
          </span>
        </span>
        <IconChevronRight
          size={16}
          className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
        />
      </Menu.Trigger>
    ) : variant === "hero" ? (
      <Menu.Trigger
        className={mergeStylexOverrideClassName(
          "data-[popup-open]:bg-hover data-[popup-open]:text-fg",
          sx.inlineFlex,
          sx.minH11,
          sx.maxWFull,
          sx.shrink0,
          sx.cursorPointer,
          sx.itemsCenter,
          sx.roundedMd,
          sx.border0,
          sx.bgTransparent,
          sx.px15,
          sx.fontMedium,
          sx.textDim,
          sx.transitionColorBackgroundColorScale,
          sx.hoverBgHover,
          sx.hoverTextFg,
          sx.activeScale096,
          typography.label,
        )}
        title="Switch or attach another repository"
        aria-label={`Repository: ${repoLabel(primary)}. Change repository`}
      >
        <span {...stylex.props(sx.truncate)}>{busy ?? repoLabel(primary)}</span>
        {attached.length > 0 && (
          <span {...stylex.props(sx.ml1, sx.textFaint)}>
            +{attached.length}
          </span>
        )}
      </Menu.Trigger>
    ) : (
      <Menu.Trigger
        className={mergeStylexOverrideClassName(
          "data-[popup-open]:bg-hover",
          sx.Mx15,
          sx.My1,
          sx.flex,
          sx.minW0,
          sx.shrink0,
          sx.cursorPointer,
          sx.itemsCenter,
          sx.gap7px,
          sx.roundedMd,
          sx.border0,
          sx.bgTransparent,
          sx.px15,
          sx.py1,
          sx.fontMedium,
          sx.textFg,
          sx.hoverBgHover,
          typography.itemTitle,
        )}
        title="Click to switch or attach another repo"
      >
        <RepoTile name={primary} />
        {/* Type sits optically high beside a centered image tile: its descender
            space otherwise makes the word look low even when the line boxes agree. */}
        <span {...stylex.props(sx.maxW180px, sx.TranslateYPx, sx.truncate)}>
          {busy ?? repoLabel(primary)}
        </span>
        {attached.length > 0 && (
          <span
            {...stylex.props(sx.textDim, typography.label)}
            title={attached.map((r) => repoLabel(r.repo)).join(", ")}
          >
            +{attached.length}
          </span>
        )}
      </Menu.Trigger>
    );

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
        {trigger}
        <Menu.Popup
          align="start"
          sideOffset={6}
          className={mergeStylexOverrideClassName("", sx.minW230px)}
        >
          {controlsLoadError && (
            <div
              role="alert"
              {...stylex.props(
                sx.maxW240px,
                sx.px25,
                sx.py15,
                sx.leadingSnug,
                sx.textRed,
                typography.supporting,
              )}
            >
              {controlsLoadError}
            </div>
          )}
          {reposLoadError && (
            <div
              role="alert"
              {...stylex.props(
                sx.maxW240px,
                sx.px25,
                sx.py15,
                sx.leadingSnug,
                sx.textRed,
                typography.supporting,
              )}
            >
              {reposLoadError}
            </div>
          )}
          {!repos.length ? (
            reposLoadError ? null : (
              <div
                {...stylex.props(
                  sx.px25,
                  sx.py2,
                  sx.textFaint,
                  typography.label,
                )}
              >
                Loading…
              </div>
            )
          ) : (
            <>
              {switchable ? (
                // Fresh session: the repo is still a free choice — one select
                // list, current checked, click another to switch the worktree.
                [{ id: primary }, ...switchTargets].map((p) => (
                  <Menu.Item key={p.id} onClick={() => switchPrimary(p.id)}>
                    <RepoTile name={p.id} />
                    <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                      {repoLabel(p.id)}
                    </span>
                    <Menu.Check
                      on={p.id === primary}
                      size={20}
                      className={mergeStylexOverrideClassName("", sx.textDim)}
                    />
                  </Menu.Item>
                ))
              ) : (
                <div className={staticRow}>
                  <RepoTile name={primary} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                    {repoLabel(primary)}
                  </span>
                  <IconCheck
                    size={20}
                    className={mergeStylexOverrideClassName("", sx.textDim)}
                  />
                </div>
              )}
              {attached.length > 0 && (
                <>
                  <Menu.Separator />
                  <Menu.Group>
                    <Menu.GroupLabel>Attached</Menu.GroupLabel>
                    {attached.map((r) => (
                      <div
                        key={r.repo}
                        className={staticRow}
                        title={`${r.dir} · branch ${r.branch}`}
                      >
                        <RepoTile name={r.repo} />
                        <span
                          {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}
                        >
                          {repoLabel(r.repo)}{" "}
                          <span {...stylex.props(sx.textFaint)}>
                            · {r.branch}
                          </span>
                        </span>
                        <button
                          {...stylex.props(
                            sx.cursorPointer,
                            sx.rounded,
                            sx.border0,
                            sx.bgTransparent,
                            sx.p05,
                            sx.textFaint,
                            sx.hoverTextFg,
                          )}
                          onClick={() => detach(r.repo)}
                          title="Detach (leaves the worktree on disk)"
                          aria-label={`Detach ${repoLabel(r.repo)}`}
                        >
                          <IconX size={16} />
                        </button>
                      </div>
                    ))}
                  </Menu.Group>
                </>
              )}
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Attach another repo</Menu.GroupLabel>
                {attachable.length ? (
                  attachable.map((p) => (
                    <Menu.Item
                      key={p.id}
                      onClick={() => attach(p.id)}
                      title="Attach to this session as an isolated worktree"
                    >
                      <RepoTile name={p.id} />
                      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                        {repoLabel(p.id)}
                      </span>
                      <IconPlus
                        size={18}
                        className={mergeStylexOverrideClassName(
                          "",
                          sx.textFaint,
                        )}
                      />
                    </Menu.Item>
                  ))
                ) : (
                  <div
                    {...stylex.props(
                      sx.px25,
                      sx.py15,
                      sx.textFaint,
                      typography.label,
                    )}
                  >
                    No more repos to attach
                  </div>
                )}
              </Menu.Group>
              {!switchable && !controlsLoadError ? (
                <div
                  {...stylex.props(
                    sx.maxW240px,
                    sx.px25,
                    sx.pt15,
                    sx.pb05,
                    sx.leadingSnug,
                    sx.textFaint,
                    typography.supporting,
                  )}
                >
                  Ask sessions read the shared checkout, so there's no primary
                  repo to switch.
                </div>
              ) : (
                switchable &&
                hasWork && (
                  <div
                    {...stylex.props(
                      sx.maxW240px,
                      sx.px25,
                      sx.pt15,
                      sx.pb05,
                      sx.leadingSnug,
                      sx.textFaint,
                      typography.supporting,
                    )}
                  >
                    Switching keeps your current changes in the{" "}
                    {repoLabel(primary)} worktree. They won't move to the new
                    repo.
                  </div>
                )
              )}
            </>
          )}
        </Menu.Popup>
      </Menu.Root>
      {error && (
        <span
          {...stylex.props(
            sx.maxW220px,
            sx.truncate,
            sx.textRed,
            typography.meta,
          )}
          title={error}
        >
          {error}
        </span>
      )}
      {/* Switch-with-work confirmation — a real choice (the move leaves the
          current changes behind), so an explicit, non-dismissible dialog rather
          than a native confirm(). */}
      <Modal.Root
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        disablePointerDismissal
      >
        <Modal.Content>
          <Modal.Header
            title="Switch repository?"
            description={
              <>
                Your changes stay in the {repoLabel(primary)} worktree
                {branch ? ` (branch ${branch})` : ""}. They won't move to{" "}
                {confirmTarget ? repoLabel(confirmTarget) : ""}.
              </>
            }
          />
          <Modal.Footer>
            <div {...stylex.props(sx.flex1)} />
            <Modal.Close render={<Button variant="ghost">Cancel</Button>} />
            <Button
              variant="primary"
              onClick={() => confirmTarget && doSwitch(confirmTarget)}
            >
              Switch
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
      {/* Breadcrumb separator between the repo and the session title — only in
          the desktop header, not the compact/menu-row phone variants. */}
      {variant === "breadcrumb" && (
        <IconChevronRight
          size={18}
          className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
        />
      )}
    </>
  );
}
