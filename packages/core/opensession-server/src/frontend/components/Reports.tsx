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
    try {
      const next = await fetchReportGroups();
      setGroups(next);
      setError("");
      // On phones the bare /reports route IS the list page, so don't
      // auto-select — that would skip straight past it into the detail.
      if (!selectionRef.current && !isPhoneRef.current && next[0])
        onSelect(next[0].automationId);
    } catch (error) {
      setError(errorMessage(error, "Failed to load reports"));
      setGroups([]);
    }
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
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingState>Loading reports…</LoadingState>
      </div>
    );

  if (!groups.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
        <EmptyState icon={<IconFile size={22} />} title="No reports yet">
          Recurring automation reports collect here, with the latest result and
          the full history in one place.
        </EmptyState>
        {error && (
          <InlineAlert className="mt-2 max-w-[420px]">{error}</InlineAlert>
        )}
      </div>
    );

  // Phone: the two panes become separate pages — the list at bare /reports,
  // the detail once an automation is selected, with a back button between.
  const showList = !isPhone || !selectedAutomationId;
  const showDetail = !isPhone || !!selectedAutomationId;

  return (
    <div className="flex min-h-0 flex-1">
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
                      className="size-[7px] rounded-full"
                      style={{
                        backgroundColor: reportUrgencyDot(group.latest.urgency),
                      }}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={REPORTS_ROW_HEAD}>
                      <span className={REPORTS_ROW_NAME}>
                        {group.automationName}
                      </span>
                      {/* The dot is the only urgency signal on the row, and a
											    colour is nothing to a screen reader. Named here
											    rather than in the rail so the row reads "Cassandra,
											    low urgency" instead of leading with it. */}
                      {urgency && <span className="sr-only">{urgency}</span>}
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
                      className="mt-0.5 shrink-0 text-faint"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </aside>
      )}

      {showDetail && (
        <section className="flex min-w-0 flex-1 flex-col bg-bg">
          {isPhone ? (
            <TopBar as="header" className="block shrink-0 px-3 pb-3 pt-2">
              <button
                type="button"
                className="-ml-1 flex items-center gap-0.5 rounded-control border-0 bg-transparent py-1.5 pl-1 pr-2.5 text-sm font-medium text-accent cursor-pointer"
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
                  <h2 className="m-0 mt-1 px-1 text-item-title font-medium leading-snug text-dim">
                    {selected.title}
                  </h2>
                  <div className="mt-2.5 flex items-center gap-2 px-1">
                    <OptionSelect
                      label="Report history"
                      className="min-w-0 flex-1"
                      value={selected.id}
                      options={historyOptions}
                      onChange={(id) => onSelect(selected.automationId, id)}
                    />
                    {!!selected.tasks?.length && (
                      <Button
                        size="md"
                        variant="primary"
                        className="shrink-0"
                        onClick={() => setFanOutId(selected.id)}
                      >
                        Fix each
                      </Button>
                    )}
                    {selected.sessionId && (
                      <Button
                        size="md"
                        className="shrink-0"
                        onClick={() => onOpenSession(selected.sessionId!)}
                      >
                        Open run
                      </Button>
                    )}
                    <Button
                      size="md"
                      className="shrink-0"
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
                className="wco-chrome h-[var(--desktop-header-h)] shrink-0 gap-4 border-b border-divider px-5"
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
                <h2 className="m-0 min-w-0 flex-1 truncate text-item-title font-medium text-dim">
                  {selected.title}
                </h2>
                {/* The report's own proposal, so it sits with the actions
								    rather than inside the document: a report is read in a
								    sandboxed frame that cannot start anything itself. */}
                <TopBarActions className="gap-4">
                  {!!selected.tasks?.length && (
                    <Button
                      size="md"
                      variant="primary"
                      className="shrink-0"
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
                    className="shrink-0"
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
                      className="shrink-0"
                      onClick={() => onOpenSession(selected.sessionId!)}
                    >
                      Open run
                    </Button>
                  )}
                  <OptionSelect
                    label="Report history"
                    className="max-w-[190px] shrink-0"
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
