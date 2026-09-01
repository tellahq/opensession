import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { docTitle } from "../lib/brand";
import { fetchReportGroups, fetchReports } from "../lib/api";
import type { ReportGroup, ReportMeta, WSServerMessage } from "../lib/types";
import { useIsPhone } from "../hooks/useIsPhone";
import { BASE_PATH } from "../lib/base";
import { absoluteLink } from "../lib/share-link";
import { type NewSessionPrefill } from "../lib/new-session-link";
import { ReportFrame } from "./ReportFrame";
import { ReportTasksDialog } from "./ReportTasksDialog";
import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconChevronLeft, IconChevronRight, IconFile, IconLink } from "./icons";
import { OptionSelect } from "../ui/select";
import { TopBar, TopBarActions } from "../ui/top-bar";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { SIDEBAR_RAIL } from "../lib/sidebar-classes";
import { reportUrgencyDot, reportUrgencyLabel } from "../lib/report-urgency";
import { shortTime } from "../lib/time";
import { errorMessage } from "../lib/error-message";
import {
  REPORTS_COLUMN,
  REPORTS_COLUMN_COUNT,
  REPORTS_COLUMN_HEADER,
  REPORTS_COLUMN_TITLE,
  REPORTS_LIST,
  REPORTS_ROW,
  REPORTS_ROW_HEAD,
  REPORTS_ROW_LATEST,
  REPORTS_ROW_NAME,
  REPORTS_ROW_TIME,
} from "../lib/reports-classes";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minH0: {
    minHeight: "0",
  },
  flex1: {
    flex: "1",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  flexCol: {
    flexDirection: "column",
  },
  p8: {
    padding: "calc(4px * 8)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  maxW420px: {
    maxWidth: "420px",
  },
  size7px: {
    width: "7px",
    height: "7px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  minW0: {
    minWidth: "0",
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  bgBg: {
    backgroundColor: "var(--bg)",
  },
  block: {
    display: "block",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  pb3: {
    paddingBottom: "calc(4px * 3)",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
  Ml1: {
    marginLeft: "calc(4px * -1)",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  pl1: {
    paddingLeft: "4px",
  },
  pr25: {
    paddingRight: "calc(4px * 2.5)",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  m0: {
    margin: "0",
  },
  mt1: {
    marginTop: "4px",
  },
  px1: {
    paddingInline: "4px",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt25: {
    marginTop: "calc(4px * 2.5)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  hVarDesktopHeaderH: {
    height: "var(--desktop-header-h)",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  maxW190px: {
    maxWidth: "190px",
  },
});

interface Props {
  selectedAutomationId?: string;
  selectedReportId?: string;
  onSelect: (automationId: string, reportId?: string) => void;
  /** Phone list/detail navigation: clear the selection to return to the list. */
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onOpenSupport: (threadId: string) => void;
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
  addHandler: (handler: (message: WSServerMessage) => void) => () => void;
}

/** When a report landed, spelled out. Only the history picker says this now. */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function Reports({
  selectedAutomationId,
  selectedReportId,
  onSelect,
  onBack,
  onOpenSession,
  onOpenSupport,
  onOpenNewSession,
  addHandler,
}: Props) {
  const [groups, setGroups] = useState<ReportGroup[] | null>(null);
  const [history, setHistory] = useState<ReportMeta[]>([]);
  const [error, setError] = useState("");
  const isPhone = useIsPhone();

  // loadGroups is also invoked from the mount-scoped ws handler, where props
  // from that first render would be stale — read the live values via refs.
  const selectionRef = useRef(selectedAutomationId);
  const isPhoneRef = useRef(isPhone);
  useLayoutEffect(() => {
    selectionRef.current = selectedAutomationId;
    isPhoneRef.current = isPhone;
  });

  async function loadGroups() {
    await (async () => {
      const next = await fetchReportGroups();
      setGroups(next);
      setError("");
      // On phones the bare /reports route IS the list page, so don't
      // auto-select — that would skip straight past it into the detail.
      if (!selectionRef.current && !isPhoneRef.current && next[0])
        onSelect(next[0].automationId);
    })().catch(async (error: unknown) => {
      setError(errorMessage(error, "Failed to load reports"));
      setGroups([]);
    });
  }

  // Effect-event wrapper: effects can call it with a stable trigger set
  // while always reaching the latest props.
  const loadGroupsEvent = useEffectEvent(() => loadGroups());

  useEffect(() => {
    document.title = docTitle("Reports");
    loadGroupsEvent();
    return addHandler((message) => {
      if (message.type !== "reports_changed") return;
      loadGroupsEvent();
      const selectedId = selectionRef.current;
      if (selectedId && message.automationId === selectedId)
        fetchReports(selectedId)
          .then(setHistory)
          .catch(() => {});
    });
  }, [addHandler]);

  const syncHistory = useEffectEvent(() => {
    if (!selectedAutomationId) {
      setHistory([]);
      return;
    }
    let alive = true;
    fetchReports(selectedAutomationId)
      .then((reports) => {
        if (!alive) return;
        setHistory(reports);
        if (!selectedReportId && reports[0])
          onSelect(selectedAutomationId, reports[0].id);
      })
      .catch((e) => alive && setError(e?.message || "Failed to load history"));
    return () => {
      alive = false;
    };
  });
  useEffect(() => {
    syncHistory();
  }, [selectedAutomationId]);

  const selected =
    history.find((report) => report.id === selectedReportId) || history[0];
  // Both headers offer the same list, so it is built once. The labels also
  // size the trigger, so a closed picker does not resize when an older
  // report is chosen.
  const historyOptions = history.map((report) => ({
    value: report.id,
    label: formatDate(report.createdAt),
  }));
  // The report a fan-out is being picked from. Held by id rather than by
  // value so a `reports_changed` refresh mid-pick cannot swap the list under
  // the checkboxes.
  const [fanOutId, setFanOutId] = useState("");
  const fanOut = history.find((report) => report.id === fanOutId);
  const { copied, share } = useCopy();
  const shareSelected = () => {
    if (!selected) return;
    const link = absoluteLink(
      `${BASE_PATH}/reports/${encodeURIComponent(selected.automationId)}/${encodeURIComponent(selected.id)}`,
    );
    share(link, { toast: true, title: selected.title });
  };

  if (groups === null)
    return (
      <div
        {...stylex.props(
          sx.flex,
          sx.minH0,
          sx.flex1,
          sx.itemsCenter,
          sx.justifyCenter,
        )}
      >
        <LoadingState>Loading reports…</LoadingState>
      </div>
    );

  if (!groups.length)
    return (
      <div
        {...stylex.props(
          sx.flex,
          sx.minH0,
          sx.flex1,
          sx.flexCol,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.p8,
        )}
      >
        <EmptyState icon={<IconFile size={22} />} title="No reports yet">
          Recurring automation reports collect here, with the latest result and
          the full history in one place.
        </EmptyState>
        {error && (
          <InlineAlert
            className={mergeStylexOverrideClassName("", sx.mt2, sx.maxW420px)}
          >
            {error}
          </InlineAlert>
        )}
      </div>
    );

  // Phone: the two panes become separate pages — the list at bare /reports,
  // the detail once an automation is selected, with a back button between.
  const showList = !isPhone || !selectedAutomationId;
  const showDetail = !isPhone || !!selectedAutomationId;

  return (
    <div {...stylex.props(sx.flex, sx.minH0, sx.flex1)}>
      {showList && (
        <aside className={REPORTS_COLUMN}>
          {/* The bar sits above the scroller, not in it, so it holds its
					    place edge to edge while the rows travel out of sight
					    beneath it. */}
          <TopBar as="header" className={REPORTS_COLUMN_HEADER}>
            <h1 className={REPORTS_COLUMN_TITLE}>Reports</h1>
            {/* The right of the bar is the column's action slot. Today it
						    holds the one thing the column can say about itself: how
						    many automations are reporting. A control that acts on the
						    whole list belongs beside it. */}
            <TopBarActions>
              <span className={REPORTS_COLUMN_COUNT}>{groups.length}</span>
            </TopBarActions>
          </TopBar>
          <div className={REPORTS_LIST}>
            {groups.map((group) => {
              const urgency = reportUrgencyLabel(group.latest.urgency);
              return (
                <button
                  key={group.automationId}
                  type="button"
                  className={REPORTS_ROW}
                  data-active={
                    (!isPhone && selectedAutomationId === group.automationId) ||
                    undefined
                  }
                  onClick={() => onSelect(group.automationId)}
                >
                  <span className={SIDEBAR_RAIL}>
                    <span
                      {...stylex.props(sx.size7px, sx.roundedFull)}
                      style={{
                        backgroundColor: reportUrgencyDot(group.latest.urgency),
                      }}
                    />
                  </span>
                  <span {...stylex.props(sx.minW0, sx.flex1)}>
                    <span className={REPORTS_ROW_HEAD}>
                      <span className={REPORTS_ROW_NAME}>
                        {group.automationName}
                      </span>
                      {/* The dot is the only urgency signal on the row, and a
											    colour is nothing to a screen reader. Named here
											    rather than in the rail so the row reads "Cassandra,
											    low urgency" instead of leading with it. */}
                      {urgency && (
                        <span {...stylex.props(sx.srOnly)}>{urgency}</span>
                      )}
                      <span
                        className={REPORTS_ROW_TIME}
                        title={new Date(
                          group.latest.createdAt,
                        ).toLocaleString()}
                      >
                        {shortTime(group.latest.createdAt)}
                      </span>
                    </span>
                    <span className={REPORTS_ROW_LATEST}>
                      {group.latest.title}
                    </span>
                  </span>
                  {isPhone && (
                    <IconChevronRight
                      size={16}
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.mt05,
                        sx.shrink0,
                        sx.textFaint,
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </aside>
      )}

      {showDetail && (
        <section
          {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol, sx.bgBg)}
        >
          {isPhone ? (
            <TopBar
              as="header"
              className={mergeStylexOverrideClassName(
                "",
                sx.block,
                sx.shrink0,
                sx.px3,
                sx.pb3,
                sx.pt2,
              )}
            >
              <button
                type="button"
                {...mergeStylexProps(
                  "text-accent",
                  sx.Ml1,
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap05,
                  sx.roundedControl,
                  sx.border0,
                  sx.bgTransparent,
                  sx.py15,
                  sx.pl1,
                  sx.pr25,
                  sx.textSm,
                  sx.fontMedium,
                  sx.cursorPointer,
                )}
                onClick={onBack}
              >
                <IconChevronLeft size={18} />
                Reports
              </button>
              {selected && (
                <>
                  {/* Same argument as the desktop header below: the name,
									    and nothing the row in the list or the picker under
									    it already says. */}
                  <h2
                    {...stylex.props(
                      sx.m0,
                      sx.mt1,
                      sx.px1,
                      sx.fontMedium,
                      sx.leadingSnug,
                      sx.textDim,
                      typography.itemTitle,
                    )}
                  >
                    {selected.title}
                  </h2>
                  <div
                    {...stylex.props(
                      sx.mt25,
                      sx.flex,
                      sx.itemsCenter,
                      sx.gap2,
                      sx.px1,
                    )}
                  >
                    <OptionSelect
                      label="Report history"
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.minW0,
                        sx.flex1,
                      )}
                      value={selected.id}
                      options={historyOptions}
                      onChange={(id) => onSelect(selected.automationId, id)}
                    />
                    {!!selected.tasks?.length && (
                      <Button
                        size="md"
                        variant="primary"
                        className={mergeStylexOverrideClassName("", sx.shrink0)}
                        onClick={() => setFanOutId(selected.id)}
                      >
                        Fix each
                      </Button>
                    )}
                    {selected.sessionId && (
                      <Button
                        size="md"
                        className={mergeStylexOverrideClassName("", sx.shrink0)}
                        onClick={() => onOpenSession(selected.sessionId!)}
                      >
                        Open run
                      </Button>
                    )}
                    <Button
                      size="md"
                      className={mergeStylexOverrideClassName("", sx.shrink0)}
                      icon={
                        <CopyCheck
                          copied={copied}
                          size={20}
                          idle={<IconLink size={20} />}
                        />
                      }
                      aria-label="Share report"
                      onClick={shareSelected}
                    />
                  </div>
                </>
              )}
            </TopBar>
          ) : (
            selected && (
              <TopBar
                as="header"
                className={mergeStylexOverrideClassName(
                  "wco-chrome",
                  sx.hVarDesktopHeaderH,
                  sx.shrink0,
                  sx.gap4,
                  sx.borderB,
                  sx.borderDivider,
                  sx.px5,
                )}
              >
                {/* The name, and nothing else. Quiet on purpose: the report
								    below opens with these same words as its own first
								    heading, so a bold black copy of them an inch above was
								    the page saying its name twice. This one is here to say
								    WHICH report is open once the document has scrolled,
								    which is a label's job.
								    It carried a second line too: the date, the summary and
								    an urgency pill. That is three more answers than the
								    question "which report is this" has. The date is on the
								    picker at the other end of this bar and on the row in
								    the list, the urgency is that row's dot (the single
								    mark language report-urgency.ts exists to hold), and
								    the summary was a truncated copy of a document that is
								    open directly underneath it.
								    The height is `--desktop-header-h`, what the list
								    column's header takes and the chat header beside it, so
								    the two seams meet across the window instead of stepping
								    down by the height of a line this no longer draws. */}
                <h2
                  {...stylex.props(
                    sx.m0,
                    sx.minW0,
                    sx.flex1,
                    sx.truncate,
                    sx.fontMedium,
                    sx.textDim,
                    typography.itemTitle,
                  )}
                >
                  {selected.title}
                </h2>
                {/* The report's own proposal, so it sits with the actions
								    rather than inside the document: a report is read in a
								    sandboxed frame that cannot start anything itself. */}
                <TopBarActions
                  className={mergeStylexOverrideClassName("", sx.gap4)}
                >
                  {!!selected.tasks?.length && (
                    <Button
                      size="md"
                      variant="primary"
                      className={mergeStylexOverrideClassName("", sx.shrink0)}
                      onClick={() => setFanOutId(selected.id)}
                    >
                      Fix each
                    </Button>
                  )}
                  {/* No hand-set box on any of the three. They were pinned to
								    30px, which is off the control scale in both directions:
								    the buttons kept `size="sm"`'s 26px padding inside a 30px
								    square, and the icon-only one fought the primitive's own
								    square. One size for the row, from the scale. */}
                  <Button
                    size="md"
                    className={mergeStylexOverrideClassName("", sx.shrink0)}
                    icon={
                      <CopyCheck
                        copied={copied}
                        size={20}
                        idle={<IconLink size={20} />}
                      />
                    }
                    aria-label="Share report"
                    title="Share report"
                    onClick={shareSelected}
                  />
                  {selected.sessionId && (
                    <Button
                      size="md"
                      className={mergeStylexOverrideClassName("", sx.shrink0)}
                      onClick={() => onOpenSession(selected.sessionId!)}
                    >
                      Open run
                    </Button>
                  )}
                  <OptionSelect
                    label="Report history"
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.maxW190px,
                      sx.shrink0,
                    )}
                    value={selected.id}
                    options={historyOptions}
                    onChange={(id) => onSelect(selected.automationId, id)}
                  />
                </TopBarActions>
              </TopBar>
            )
          )}
          {selected && (
            <ReportFrame
              automationId={selected.automationId}
              reportId={selected.id}
              title={selected.title}
              onOpenNewSession={onOpenNewSession}
              onOpenSupport={onOpenSupport}
            />
          )}
          {fanOut && (
            <ReportTasksDialog
              report={fanOut}
              onClose={() => setFanOutId("")}
            />
          )}
        </section>
      )}
    </div>
  );
}
