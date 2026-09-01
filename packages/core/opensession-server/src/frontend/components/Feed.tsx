import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession } from "../lib/types";
import {
  fetchRecentCommits,
  fetchRecentPrs,
  type RecentCommit,
  type RecentPr,
} from "../lib/api";
import {
  buildWorktreeRows,
  compactAge,
  compactDiff,
  dateGroup,
  personLabel,
} from "../lib/pr-rows";
import { buildFeedRows, type FeedOwner, type FeedRow } from "../lib/feed-rows";
import {
  PR_FEED_GROUP_LABEL,
  PR_FEED_ROW,
  PR_LIST,
} from "../lib/pr-list-classes";
import { RepoTile, repoLabel } from "./RepoTile";
import { useCurrentUser } from "./UserPicker";
import { usePeople } from "../lib/people";
import { UserAvatar } from "./UserAvatar";
import { presenceState, StatusDot, useTeamPresence } from "./TeamPresence";
import { EmptyState, InlineAlert, ListSkeleton } from "../ui/state";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconFeed, IconRepo, IconRobot } from "./icons";
import { PEOPLE_SECTION_LABEL } from "../lib/people-classes";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  size24px: {
    width: "24px",
    height: "24px",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedAvatar: {
    borderRadius: "calc(32% * var(--rp))",
    cornerShape: "var(--cs)",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  gapPx: {
    gap: "1px",
  },
  relative: {
    position: "relative",
  },
  minW0: {
    minWidth: "0",
  },
  maxW24: {
    maxWidth: "calc(4px * 24)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  minH8: {
    minHeight: "calc(4px * 8)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  p1: {
    padding: "4px",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  maxW150px: {
    maxWidth: "150px",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  minW200px: {
    minWidth: "200px",
  },
  size18px: {
    width: "18px",
    height: "18px",
  },
  flex1: {
    flex: "1",
  },
  minH0: {
    minHeight: "0",
  },
  wFull: {
    width: "100%",
  },
  flexCol: {
    flexDirection: "column",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  gap1: {
    gap: "4px",
  },
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  mxAuto: {
    marginInline: "auto",
  },
  maxW920px: {
    maxWidth: "920px",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  pb15: {
    paddingBottom: "calc(4px * 15)",
  },
  pt6: {
    paddingTop: "calc(4px * 6)",
  },
  phonePx4: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 4)",
    },
  },
  phonePb12: {
    "@media (max-width: 720px)": {
      paddingBottom: "calc(4px * 12)",
    },
  },
  phonePtCalcVarHeaderH18px: {
    "@media (max-width: 720px)": {
      paddingTop: "calc(var(--header-h) + 18px)",
    },
  },
  mb5: {
    marginBottom: "calc(4px * 5)",
  },
  hidden: {
    display: "none",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  phoneFlex: {
    "@media (max-width: 720px)": {
      display: "flex",
    },
  },
  ScrollbarWidthNone: {
    scrollbarWidth: "none",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  minH30px: {
    minHeight: "30px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  selfCenter: {
    alignSelf: "center",
  },
  leading13: {
    lineHeight: "1.3",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  justifySelfEnd: {
    justifySelf: "flex-end",
  },
  textGreen: {
    color: "var(--green)",
  },
  ml2: {
    marginLeft: "calc(4px * 2)",
  },
  textRed: {
    color: "var(--red)",
  },
  mt1: {
    marginTop: "4px",
  },
});

/**
 * What the team has been shipping.
 *
 * The page is the feed. Its two filters stay together at the top: repo first,
 * then the team. Who shipped something is how you narrow the feed, not a
 * destination of its own. There is no per-person page to open, since
 * everything you would put on one already exists as their sidebar.
 *
 * Picking a teammate narrows this feed without reconfiguring the global
 * sidebar. A top-bar filter should update the page beneath it, not make the
 * rest of the app jump at the same time.
 *
 * The row is people, and only people. GitHub review teams used to sit at the
 * end of it, but a team is a routing rule for reviews rather than a group
 * whose work you would go and read. The sidebar's lens holds one person
 * anyway, so picking a team could not leave the sidebar anywhere sensible.
 */

interface Props {
  sessions: UnifiedSession[];
  /** Who's viewing what right now (global presence), for the face dots. */
  teamViewing?: Array<{ user: string; sessionId: string }>;
  /** The app-level title bar's actions slot. */
  headerActionsEl?: HTMLElement | null;
  /** By id, not by row: most of what the feed can open is archived, and an
   *  archived session is not in `sessions`. */
  onSelect: (sessionId: string) => void;
}

/** How far back the feed reaches, in days, and the steps "Show more" walks.
 *
 *  This used to be a flat row count, which read as "the feed only shows
 *  today" on a repo that ships a hundred times a day: the cap was spent
 *  before the first date group ended, so no amount of scrolling reached
 *  yesterday. A window is the honest unit — the list ends where the days do,
 *  and the button says how much further it can go. */
const DAY_STEPS = [3, 7, 14, 45];

/** A ceiling on rendered rows, so a very wide window can't stall the page.
 *  It sits far above a busy fortnight; the window is what normally binds. */
const RENDER_CEILING = 1500;

/** Everyone, or one person. */
type Scope = { kind: "everyone" } | { kind: "person"; key: string };

/**
 * The owner of a row, in the same 24px slot whoever they are. A teammate wears
 * their face; an automation wears a glyph in the avatar's own shape, so the
 * column reads as one column of owners rather than faces and something else.
 *
 * The repo is not here. It rode this corner for a while, which put a second
 * picture on the one mark the column exists to carry, and the repo already has
 * a place of its own beside its name on the line below.
 */
function FeedOwnerMark({ owner }: { owner: FeedOwner }) {
  if (owner.person) {
    return <UserAvatar name={owner.label} size={24} title={owner.label} />;
  }
  return (
    <span
      {...mergeStylexProps(
        "shadow-[var(--avatar-edge)]",
        sx.flex,
        sx.size24px,
        sx.shrink0,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.roundedAvatar,
        sx.bgActive,
        sx.textDim,
      )}
      title={owner.label}
    >
      <IconRobot size={14} />
    </span>
  );
}

export function Feed({
  sessions,
  teamViewing,
  headerActionsEl,
  onSelect,
}: Props) {
  const currentUser = useCurrentUser();
  const team = useTeamPresence({ sessions, teamViewing, currentUser });
  const people = usePeople();
  const [scope, setScope] = useState<Scope>({ kind: "everyone" });
  const [showAllMembers, setShowAllMembers] = useState(false);
  // The other axis: which repo shipped it. Unlike the person scope this is
  // the page's own filter and touches nothing else, because a repo is not
  // something the sidebar can be turned to.
  const [repo, setRepo] = useState("all");

  // You first, then the team in the order `useTeamPresence` already sorted
  // them: working, then online, then whoever moved most recently.
  const chips = [...team].sort((a, b) => Number(b.isYou) - Number(a.isYou));

  const [recentPrs, setRecentPrs] = useState<RecentPr[]>([]);
  const [recentPrsLoading, setRecentPrsLoading] = useState(true);
  const [recentPrsError, setRecentPrsError] = useState<string | null>(null);
  const [personPrs, setPersonPrs] = useState<RecentPr[]>([]);
  const [personPrsLoading, setPersonPrsLoading] = useState(false);
  const [personPrsError, setPersonPrsError] = useState<string | null>(null);

  // Mark the request in flight before changing scope, rather than waiting for
  // the next effect, so the first filtered paint cannot make the same false
  // empty-state claim.
  const pick = (next: Scope) => {
    setPersonPrs([]);
    setPersonPrsLoading(next.kind === "person");
    setPersonPrsError(null);
    setScope(next);
  };
  // Repos that ship without pull requests — Open Session's own — say what
  // they shipped in commits instead, and land in the same list.
  const [commits, setCommits] = useState<RecentCommit[]>([]);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  // How far back the list currently reaches. "Show more" walks it out, and
  // the server answers with the window it could actually serve, so a step
  // that hits the end of the readable history stops offering another one.
  const [days, setDays] = useState(DAY_STEPS[0]);
  const [hasOlder, setHasOlder] = useState(true);
  // Start in flight. Effects run after the first paint, so initializing this
  // false briefly made a full feed claim it was empty before either request
  // had even started.
  const [widening, setWidening] = useState(true);
  useEffect(() => {
    let active = true;
    setRecentPrsError(null);
    fetchRecentPrs(undefined, { days })
      .then((prs) => active && setRecentPrs(prs))
      .catch((cause: unknown) => {
        if (active)
          setRecentPrsError(
            errorMessage(cause, "Could not load pull requests"),
          );
      })
      .finally(() => active && setRecentPrsLoading(false));
    return () => {
      active = false;
    };
  }, [days]);
  useEffect(() => {
    let active = true;
    setWidening(true);
    setCommitsError(null);
    fetchRecentCommits(days)
      .then((page) => {
        if (!active) return;
        setCommits(page.commits);
        setHasOlder(page.hasMore);
      })
      .catch((cause: unknown) => {
        if (active)
          setCommitsError(errorMessage(cause, "Could not load commits"));
      })
      .finally(() => active && setWidening(false));
    return () => {
      active = false;
    };
  }, [days]);
  // One person's own merges, on top of the global list: that list is capped
  // across the whole team, so a quiet fortnight would drop someone out of
  // their own feed.
  const scopedPerson = scope.kind === "person" ? scope.key : null;
  useEffect(() => {
    if (!scopedPerson) {
      setPersonPrs([]);
      setPersonPrsLoading(false);
      return;
    }
    let active = true;
    setPersonPrs([]);
    setPersonPrsLoading(true);
    setPersonPrsError(null);
    fetchRecentPrs(scopedPerson)
      .then((prs) => active && setPersonPrs(prs))
      .catch((cause: unknown) => {
        if (active)
          setPersonPrsError(
            errorMessage(cause, "Could not load this person's pull requests"),
          );
      })
      .finally(() => active && setPersonPrsLoading(false));
    return () => {
      active = false;
    };
  }, [scopedPerson]);

  const inScope = (person: string | null) =>
    scope.kind === "everyone" || person === scope.key;
  const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
  for (const pr of personPrs) prs.set(pr.url, pr);
  const merged = buildWorktreeRows([...prs.values()], sessions).filter(
    (row) => row.state === "MERGED",
  );
  // The repo list comes from everything shipped, not from what the current
  // scopes leave: a repo has to stay pickable while you are looking at a
  // person who has not touched it, or the control drops the option you were
  // about to use.
  // A row's person is whoever owns the session behind it, which is an
  // automation as often as a teammate. The roster decides which, so an
  // automation is named rather than given a face.
  const teammates = new Set(people.map((p) => p.name.toLowerCase()));
  const allShipped = buildFeedRows(merged, commits, (key) =>
    teammates.has(key),
  );
  const repoOptions = [
    ...new Set(allShipped.map((row) => row.repo).filter(Boolean)),
  ].sort();
  const scoped = allShipped.filter(
    (row) => inScope(row.person) && (repo === "all" || row.repo === repo),
  );
  // One horizon for the whole list. Commits arrive already windowed, but
  // merged PRs come from a cache that reaches much further back, so without
  // this the page runs a few days of commits and then a month of pull
  // requests under date headings that read as the team having stopped
  // committing. "Show more" moves the horizon, and both sides move with it.
  const cutoff = Date.now() - days * 86_400_000;
  const shipped = scoped.filter(
    (row) => new Date(row.shippedAt).getTime() >= cutoff,
  );
  const groups = new Map<string, FeedRow[]>();
  for (const row of shipped.slice(0, RENDER_CEILING)) {
    const label = dateGroup(row.shippedAt);
    groups.set(label, [...(groups.get(label) || []), row]);
  }
  const dayGroups = [...groups.entries()];

  // The next step out, offered while either side of the list still has
  // something older to show: commits the server is holding back, or merged
  // PRs the horizon is currently cutting off.
  const nextStep = DAY_STEPS.find((step) => step > days);
  const canWiden = !!nextStep && (hasOlder || scoped.length > shipped.length);

  const scopeName = scope.kind === "person" ? personLabel(scope.key) : null;
  const visibleMembers = showAllMembers ? chips : chips.slice(0, 5);
  const hiddenMemberCount = chips.length - visibleMembers.length;
  const renderMemberPicker = () => (
    <div
      {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gapPx)}
      aria-label="Filter feed by person"
    >
      {visibleMembers.map((member) => {
        const selected = scope.kind === "person" && scope.key === member.key;
        return (
          <button
            key={member.key}
            type="button"
            className={cn(
              utilityClassName(
                "focus-ring flex min-h-8 shrink-0 items-center gap-1 rounded-md p-1 text-supporting font-medium text-fg transition-[background-color,color,scale] duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-hover active:scale-[0.96] phone:min-h-11 motion-reduce:transform-none",
              ),
              selected &&
                utilityClassName(
                  "bg-selected pr-1.5 font-semibold hover:bg-pressed",
                ),
            )}
            onClick={() =>
              pick(
                selected
                  ? { kind: "everyone" }
                  : { kind: "person", key: member.key },
              )
            }
            aria-pressed={selected}
            aria-label={
              selected ? "Show everyone" : `Show ${member.person.name}`
            }
          >
            <span {...stylex.props(sx.relative, sx.flex)}>
              <UserAvatar name={member.person.name} size={24} edge={false} />
              <StatusDot
                state={presenceState(member)}
                ring="var(--bg-surface)"
                size={7}
              />
            </span>
            <span
              aria-hidden={!selected}
              className={cn(
                utilityClassName(
                  "grid min-w-0 transition-[grid-template-columns,opacity] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
                ),
                selected
                  ? utilityClassName("grid-cols-[1fr] opacity-100")
                  : utilityClassName("grid-cols-[0fr] opacity-0"),
              )}
            >
              <span
                {...stylex.props(
                  sx.minW0,
                  sx.maxW24,
                  sx.overflowHidden,
                  sx.whitespaceNowrap,
                )}
              >
                {member.isYou ? "You" : personLabel(member.key)}
              </span>
            </span>
          </button>
        );
      })}
      {hiddenMemberCount > 0 && (
        <button
          type="button"
          {...mergeStylexProps(
            "focus-ring",
            sx.flex,
            sx.minH8,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.roundedMd,
            sx.p1,
            sx.hoverBgHover,
            sx.phoneMinH11,
          )}
          onClick={() => setShowAllMembers(true)}
          aria-label={`Show ${hiddenMemberCount} more people`}
        >
          <span
            {...stylex.props(
              sx.flex,
              sx.size6,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedMd,
              sx.bgActive,
              sx.fontSemibold,
              sx.textDim,
              typography.supporting,
            )}
          >
            +{hiddenMemberCount}
          </span>
        </button>
      )}
    </div>
  );
  const renderRepoPicker = (align: "start" | "end") => (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRepo size={18} />}
            caret
            className={mergeStylexOverrideClassName(
              "",
              sx.shrink0,
              sx.phoneMinH11,
            )}
          >
            <span {...stylex.props(sx.maxW150px, sx.truncate)}>
              {repo === "all" ? "In all repos" : `In ${repoLabel(repo)}`}
            </span>
          </Button>
        }
      />
      <Menu.Popup
        align={align}
        className={mergeStylexOverrideClassName("", sx.minW200px)}
      >
        <Menu.RadioGroup
          value={repo}
          onValueChange={(value) => setRepo(String(value))}
        >
          <Menu.RadioItem value="all" closeOnClick>
            {/* Sized to the tiles below so every label shares one edge. */}
            <span {...stylex.props(sx.size18px, sx.shrink0)} />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              All repos
            </span>
            <Menu.Check on={repo === "all"} />
          </Menu.RadioItem>
          {repoOptions.map((name) => (
            <Menu.RadioItem key={name} value={name} closeOnClick>
              <RepoTile name={name} size={18} />
              <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                {repoLabel(name)}
              </span>
              <Menu.Check on={repo === name} />
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Popup>
    </Menu.Root>
  );
  const feedLoading =
    recentPrs.length === 0 &&
    commits.length === 0 &&
    (recentPrsLoading || widening);
  const filteredFeedLoading =
    dayGroups.length === 0 && (widening || personPrsLoading);

  return (
    <div
      {...stylex.props(
        sx.flex,
        sx.minH0,
        sx.wFull,
        sx.flex1,
        sx.flexCol,
        sx.bgSurface,
      )}
    >
      {headerActionsEl &&
        (repoOptions.length > 1 || team.length > 0) &&
        createPortal(
          <div
            {...stylex.props(
              sx.flex,
              sx.minW0,
              sx.itemsCenter,
              sx.gap1,
              sx.phoneHidden,
            )}
          >
            {repoOptions.length > 1 && renderRepoPicker("end")}
            {team.length > 0 && renderMemberPicker()}
          </div>,
          headerActionsEl,
        )}
      <div
        data-page-scroll
        {...stylex.props(sx.minH0, sx.flex1, sx.overflowYAuto)}
      >
        <div
          {...stylex.props(
            sx.mxAuto,
            sx.wFull,
            sx.maxW920px,
            sx.px6,
            sx.pb15,
            sx.pt6,
            sx.phonePx4,
            sx.phonePb12,
            sx.phonePtCalcVarHeaderH18px,
          )}
        >
          {(repoOptions.length > 1 || team.length > 0) && (
            <div
              {...mergeStylexProps(
                "[&::-webkit-scrollbar]:hidden",
                sx.mb5,
                sx.hidden,
                sx.minW0,
                sx.itemsCenter,
                sx.gap1,
                sx.overflowXAuto,
                sx.phoneFlex,
                sx.ScrollbarWidthNone,
              )}
            >
              {repoOptions.length > 1 && renderRepoPicker("start")}
              {team.length > 0 && renderMemberPicker()}
            </div>
          )}
          {recentPrsError && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setRecentPrsError(null)}
            >
              {recentPrsError}
            </InlineAlert>
          )}
          {commitsError && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setCommitsError(null)}
            >
              {commitsError}
            </InlineAlert>
          )}
          {personPrsError && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setPersonPrsError(null)}
            >
              {personPrsError}
            </InlineAlert>
          )}
          {feedLoading ? (
            <>
              <div
                {...stylex.props(sx.mb2, sx.flex, sx.minH30px, sx.itemsCenter)}
              >
                <h3
                  className={cn(PEOPLE_SECTION_LABEL, utilityClassName("mb-0"))}
                >
                  Shipped
                </h3>
              </div>
              <ListSkeleton
                variant="bare"
                rows={6}
                label="Loading feed"
                className={PR_LIST}
                rowClassName={utilityClassName("py-[18px]")}
              />
            </>
          ) : recentPrs.length === 0 && commits.length === 0 ? (
            <EmptyState icon={<IconFeed size={22} />} title="Nothing yet">
              Work shows up here as the team ships it.
            </EmptyState>
          ) : (
            <>
              <div
                {...stylex.props(sx.mb2, sx.flex, sx.minH30px, sx.itemsCenter)}
              >
                <h3
                  className={cn(PEOPLE_SECTION_LABEL, utilityClassName("mb-0"))}
                >
                  {scopeName ? `${scopeName} shipped` : "Shipped"}
                </h3>
              </div>
              {filteredFeedLoading ? (
                <ListSkeleton
                  variant="bare"
                  rows={6}
                  label="Loading feed"
                  className={PR_LIST}
                  rowClassName={utilityClassName("py-[18px]")}
                />
              ) : dayGroups.length === 0 ? (
                // A picked teammate or repo with nothing shipped is an answer,
                // so the header stays and the sentence names the filter that
                // emptied it. Both are on screen, so a sentence that names
                // neither reads as "there is nothing", which is the one thing
                // it does not mean.
                <EmptyState title="Nothing shipped yet">
                  {scopeName && repo !== "all"
                    ? `${scopeName} hasn't shipped anything in ${repoLabel(repo)} recently.`
                    : scopeName
                      ? `${scopeName} hasn't shipped anything recently.`
                      : repo !== "all"
                        ? `Nothing has shipped in ${repoLabel(repo)} recently.`
                        : "Merged pull requests and commits show up here."}
                </EmptyState>
              ) : null}
              <div className={PR_LIST}>
                {dayGroups.map(([label, rows]) => (
                  <div key={label} {...stylex.props(sx.mb5)}>
                    <h4 className={PR_FEED_GROUP_LABEL}>
                      {label}
                      <span {...stylex.props(sx.fontMedium)}>
                        {rows.length}
                      </span>
                    </h4>
                    <div>
                      {rows.map((row) => (
                        <button
                          key={row.key}
                          className={PR_FEED_ROW}
                          onClick={() =>
                            row.sessionId
                              ? onSelect(row.sessionId)
                              : row.url &&
                                window.open(row.url, "_blank", "noopener")
                          }
                          title={[
                            repoLabel(row.repo),
                            row.ref,
                            row.owner && !row.owner.person
                              ? row.owner.label
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {/* Who shipped it. An automation is an owner too, so
												    it gets the column rather than the repo standing in
												    for a name. The bare tile is left for the older work
												    that recorded no author at all. */}
                          {row.owner ? (
                            <FeedOwnerMark owner={row.owner} />
                          ) : (
                            <RepoTile name={row.repo} size={24} />
                          )}
                          {/* One line. The repo rides in front of the title as
												    its mark alone: it used to be a tile and its own name
												    on a second line, which spent a whole row restating
												    what the picture already said and made the feed twice
												    as tall as it needed to be. The name is in the row's
												    tooltip and in the repo filter above. */}
                          <span
                            {...stylex.props(
                              sx.flex,
                              sx.minW0,
                              sx.itemsBaseline,
                              sx.gap2,
                            )}
                          >
                            <RepoTile
                              name={row.repo}
                              size={16}
                              className={mergeStylexOverrideClassName(
                                "",
                                sx.selfCenter,
                              )}
                            />
                            <span
                              {...stylex.props(
                                sx.truncate,
                                sx.fontMedium,
                                sx.leading13,
                                sx.textFg,
                                typography.itemTitle,
                              )}
                            >
                              {row.title}
                            </span>
                            {row.ref && (
                              <span
                                {...mergeStylexProps(
                                  "tabular-nums",
                                  sx.shrink0,
                                  sx.textFaint,
                                  typography.meta,
                                )}
                              >
                                {row.ref}
                              </span>
                            )}
                            {/* Which automation shipped it is on the mark's own
													    tooltip and on the row's. It used to sit here, but
													    an owner name is as long as someone made it, and a
													    third run of text truncating mid-word between the
													    title and the diff read as damage rather than as a
													    field. The glyph still says "not a person". */}
                          </span>
                          {/* A side that moved no lines is left off rather than
												    written as a zero: every commit carries both counts. */}
                          <span
                            {...mergeStylexProps(
                              "tabular-nums",
                              sx.justifySelfEnd,
                              sx.phoneHidden,
                              typography.meta,
                            )}
                          >
                            {!!row.additions && (
                              <span {...stylex.props(sx.textGreen)}>
                                +{compactDiff(row.additions)}
                              </span>
                            )}
                            {!!row.deletions && (
                              <span {...stylex.props(sx.ml2, sx.textRed)}>
                                −{compactDiff(row.deletions)}
                              </span>
                            )}
                          </span>
                          <span
                            {...mergeStylexProps(
                              "tabular-nums",
                              sx.justifySelfEnd,
                              sx.textFaint,
                              typography.meta,
                            )}
                          >
                            {compactAge(row.shippedAt)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* The end of the window, not the end of the work: the feed
						    reaches back a few days by default so the first page stays
						    cheap, and this walks it out. It goes when the server says
						    it holds nothing older, so the last page ends in the list
						    rather than in a button that would do nothing. */}
              {canWiden && (
                <div {...stylex.props(sx.mt1, sx.flex, sx.justifyCenter)}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => nextStep && setDays(nextStep)}
                    disabled={widening}
                  >
                    {widening ? "Loading…" : "Show more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
