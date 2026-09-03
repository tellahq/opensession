import type { ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { BASE_PATH } from "../../lib/base";
import { brandLogo } from "../../brand-logos";
import { sessionSourceName } from "../../lib/brand";
import type { ModelOption } from "../../lib/api";
import type { NavigationActions } from "../../lib/navigation";
import { sessionWasAgentStarted } from "../../lib/sidebar-placement";
import { SOURCE_CHIP, sourceChipTone } from "../../lib/source-chip-classes";
import type { UnifiedSession } from "../../lib/types";
import {
  VIEWER_BRANCH,
  VIEWER_BRANCH_EDITABLE,
  VIEWER_BRANCH_RENAME,
  VIEWER_CRUMB_UP,
  VIEWER_HEADER,
  VIEWER_HEADER_ACTIONS,
  VIEWER_TITLE,
} from "../../lib/session-viewer-classes";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { OverflowFadeText } from "../../ui/overflow-fade-text";
import { Tooltip } from "../../ui/tooltip";
import { TopBar, TopBarActions, TopBarLeading } from "../../ui/top-bar";
import { BrandMark } from "../BrandMark";
import {
  IconArchive,
  IconChevronDown,
  IconEye,
  IconPlus,
  IconRobot,
} from "../icons";
import { RepoBar } from "../RepoBar";
import { RepoTile } from "../RepoTile";
import { SandboxBadge } from "../SandboxBadge";
import { SessionRelations, type RelatedSession } from "../SessionRelations";

interface SessionHeaderProps {
  session: UnifiedSession;
  hasWorkspace: boolean;
  workspaceName?: string;
  parentSession?: RelatedSession | null;
  workerSessions?: RelatedSession[];
  models: ModelOption[];
  openSession?: (id: string) => void;
  archiving: boolean;
  onArchive: () => void;
  renameDraft: string | null;
  onRenameDraftChange: (draft: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  canRename: boolean;
  menu: ReactNode;
  menuTrailing?: ReactNode;
  isPhone: boolean;
  openNewSession?: NavigationActions["openNewSessionInWorkspace"];
  tabStripVisible?: boolean;
  workspaceSessionCount?: number;
  newSiblingKeys?: string[] | null;
  actions: ReactNode;
  headerRef: Ref<HTMLDivElement>;
  headerActionsRef: Ref<HTMLDivElement>;
  topbarEl?: HTMLElement | null;
  headerActionsEl?: HTMLElement | null;
}

export function SessionHeader({
  session,
  hasWorkspace,
  workspaceName,
  parentSession,
  workerSessions,
  models,
  openSession,
  archiving,
  onArchive,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  canRename,
  menu,
  menuTrailing,
  isPhone,
  openNewSession,
  tabStripVisible,
  workspaceSessionCount,
  newSiblingKeys,
  actions,
  headerRef,
  headerActionsRef,
  topbarEl,
  headerActionsEl,
}: SessionHeaderProps) {
  const header = (
    <TopBar className={VIEWER_HEADER} ref={headerRef}>
      <TopBarLeading className={VIEWER_TITLE}>
        {!session.desk &&
          session.worktreeDir &&
          hasWorkspace &&
          // Repo-less sessions get a static tile instead of the repo
          // switch/attach menu: scratch names the feed it came from,
          // an Ask session with the repo turned off says so.
          (session.repoLess ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="flex min-w-0 items-center gap-1.5 text-label font-medium text-dim"
                title={
                  session.mode === "scratch"
                    ? "Scratch session · no repo"
                    : "Ask session · no repo"
                }
              >
                {session.mode === "scratch" ? (
                  <RepoTile
                    name={session.externalRefs?.[0]?.kind || "scratch"}
                  />
                ) : (
                  <IconEye size={16} className="shrink-0 text-faint" />
                )}
                <span className="truncate">
                  {session.mode === "scratch"
                    ? session.externalRefs?.[0]?.kind || "scratch"
                    : "No repo"}
                </span>
              </span>
              <IconChevronDown
                size={18}
                className="shrink-0 -rotate-90 text-faint"
              />
            </span>
          ) : (
            <RepoBar
              sessionId={session.id}
              primaryRepo={session.repo || "repository"}
              branch={session.branch}
              initialAttached={session.attachedRepos || []}
            />
          ))}
        {/* A worker session sits UNDER the session that spawned it, so the
            bar reads repo > session > worker and the middle crumb is the way
            back up. It replaces the "worker of …" chip that used to trail the
            title while a temporary tab said the same thing again in the strip. */}
        {parentSession && openSession && (
          <>
            <button
              type="button"
              className={cn(VIEWER_BRANCH, VIEWER_CRUMB_UP)}
              onClick={() => openSession(parentSession.id)}
              title={`Back to ${workspaceName || parentSession.title}`}
            >
              {workspaceName || parentSession.title}
            </button>
            <IconChevronDown
              size={18}
              className="-mx-1 shrink-0 -rotate-90 text-faint"
              aria-hidden="true"
            />
          </>
        )}
        {session.archived && (
          <Tooltip label="Unarchive session" side="bottom">
            <Button
              variant="ghost"
              size="md"
              className="shrink-0 text-dim"
              icon={<IconArchive size={20} aria-hidden />}
              disabled={archiving}
              onClick={onArchive}
            >
              {archiving ? "Unarchiving…" : "Unarchive"}
            </Button>
          </Tooltip>
        )}
        {renameDraft !== null ? (
          <input
            className={VIEWER_BRANCH_RENAME}
            value={renameDraft}
            autoFocus
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={onCommitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitRename();
              else if (event.key === "Escape") onCancelRename();
              event.stopPropagation();
            }}
          />
        ) : (
          <OverflowFadeText
            className={`${VIEWER_BRANCH} ${canRename ? VIEWER_BRANCH_EDITABLE : ""}`}
            title={
              parentSession
                ? canRename
                  ? `${session.title} · double-click to rename`
                  : session.title
                : workspaceName
                  ? `${session.title} · double-click to rename the workspace`
                  : canRename
                    ? "Double-click to rename"
                    : session.title
            }
            onDoubleClick={
              canRename
                ? () =>
                    onRenameDraftChange(
                      parentSession
                        ? session.title
                        : workspaceName || session.title,
                    )
                : undefined
            }
          >
            {parentSession ? session.title : workspaceName || session.title}
          </OverflowFadeText>
        )}
        {/* Where the session came FROM, as a quiet mark AFTER the name. It
            used to be a tinted pill at the head of the row, which made the
            loudest thing in the bar a fact you read once — and put it in
            front of the repo, where it read as part of the path. Origins
            with a brand mark draw it in the same faint ink as the
            automation and sandbox glyphs beside it; the rest keep the
            worded chip. Ask mode isn't an origin — it's a mode you can
            change — so it rides the composer toolbar next to the model
            pill instead, where the switch is one click from where you're
            typing. "opensession" is the default origin (web UI): as a chip
            it's noise, and for backstage-repo sessions it read as the repo
            said twice. */}
        {session.source !== "opensession" &&
          (brandLogo(session.source) ? (
            <span
              className="flex shrink-0 items-center text-faint"
              title={`From ${sessionSourceName(session.source)}`}
              aria-label={`From ${sessionSourceName(session.source)}`}
              role="img"
            >
              <BrandMark name={session.source} size={14} />
            </span>
          ) : (
            <span className={cn(SOURCE_CHIP, sourceChipTone(session.source))}>
              {session.source}
            </span>
          ))}
        {/* A quiet robot after the title says the opening turn came from an
            agent action. Named automation runs link to their settings; report
            tasks and delegated sessions keep the same mark without pretending
            they are owned by that automation. */}
        {session.automation ? (
          <Tooltip label={`Automation · ${session.automation}`} side="bottom">
            <a
              href={`${BASE_PATH}/automations/${encodeURIComponent(session.automationId || session.automation)}`}
              className="-ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-control text-faint transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-hover hover:text-fg"
              aria-label={`Open ${session.automation} automation settings`}
            >
              <IconRobot size={18} />
            </a>
          </Tooltip>
        ) : sessionWasAgentStarted(session) ? (
          <span
            className="-ml-1 inline-flex size-6 shrink-0 items-center justify-center text-faint"
            role="img"
            aria-label="Started by an agent"
            title="Started by an agent"
          >
            <IconRobot size={18} />
          </span>
        ) : null}
        {/* Sandbox badge: this session's runs execute inside an isolated
            container (docker/daytona/e2b). Renders nothing for host sessions
            — purely from session fields, no container polling. */}
        <SandboxBadge
          sessionId={session.id}
          sandbox={session.sandbox}
          runner={session.runner}
        />
        {/* The parent edge is the crumb before the title; this is the other
            direction, the workers this session delegated to. */}
        {openSession && !!workerSessions?.length && (
          <SessionRelations
            workers={workerSessions}
            models={models}
            onOpen={openSession}
          />
        )}
        {/* This workspace's own controls, at the end of its own cluster: the
            ⋯ menu, then a contextual action such as the PR-session + or the
            lone-session "+ New tab". The menu used to sit at the far right of
            the bar, a whole header away from the thing it acts on and mixed in
            with the status controls; here it reads as belonging to the name,
            and the right end is left to say what the workspace is doing. The
            two are 32px ghost squares, so they take the icon cluster's own 2px
            gap rather than the row's 10px and read as one pair, and the pair
            is pulled in a little because each button already pads its glyph. */}
        {!isPhone && (
          <div className="-ml-1 flex flex-none items-center gap-0.5">
            {menu}
            {menuTrailing}
            {/* With no tab strip on screen the affordance to spawn a sibling
                session lives here beside the title (⌘⌥N does the same). The
                moment the strip appears, whether from a second session, an
                open view tab like Review, or a split, its own + takes over
                and this disappears, so the two never stack. Phone keeps this
                sibling-session action in More. Rendered AS the Button
                primitive, like the ⋯ beside it and the side-panel control at
                the other end of the bar, so the 32px square, radius, hover
                wash and press scale match by construction rather than by
                hand-matching a chip. */}
            {/* Not on a worker: its header is a level below the workspace, and
                a new tab belongs to the session above it. */}
            {!session.desk &&
              openNewSession &&
              !menuTrailing &&
              !tabStripVisible &&
              !parentSession &&
              workspaceSessionCount === 1 && (
                <Tooltip
                  label="New tab in this workspace"
                  shortcut={newSiblingKeys ?? undefined}
                >
                  <Button
                    variant="ghost"
                    size="md"
                    className="flex-none rounded-control"
                    onClick={(event) => {
                      const animate =
                        event.detail > 0 &&
                        !window.matchMedia("(prefers-reduced-motion: reduce)")
                          .matches;
                      const rect = animate
                        ? event.currentTarget.getBoundingClientRect()
                        : null;
                      void openNewSession(
                        "share",
                        rect
                          ? {
                              left: rect.left,
                              top: rect.top,
                              width: rect.width,
                              height: rect.height,
                            }
                          : undefined,
                      );
                    }}
                    aria-label="New tab"
                    // 22, the standard standalone step the ⋯ and side-panel
                    // glyphs use. IconPlus now draws the set's 14.5 span, so
                    // it lands at their size and weight without a bump.
                    icon={<IconPlus size={22} />}
                  />
                </Tooltip>
              )}
          </div>
        )}
      </TopBarLeading>
      <TopBarActions className={VIEWER_HEADER_ACTIONS} ref={headerActionsRef}>
        {actions}
      </TopBarActions>
    </TopBar>
  );

  // Phones: the whole header rides in the top bar's right slot (the
  // title row is CSS-hidden there — the centered bar title replaces
  // it), giving one iOS-style nav bar instead of a second chrome row.
  const portalTarget = isPhone && headerActionsEl ? headerActionsEl : topbarEl;
  return portalTarget ? createPortal(header, portalTarget) : header;
}
