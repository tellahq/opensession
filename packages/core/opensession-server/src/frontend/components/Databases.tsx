/**
 * The Databases view: every database the instance keeps down the left, the
 * open one on the right as its rows, one table at a time, or as the result
 * of a read-only query. The shape is the Reports page's (see
 * lib/databases-classes.ts for why the list column is literally that one),
 * with a toolbar under the header because a database has more than one way
 * to be looked at.
 *
 * Writes from here are the few a person makes by hand: create an empty
 * database to point a session at, rename, delete, download. Filling one is a
 * session's job through the opensession-databases tools, and the view keeps
 * up through `databases_changed`.
 */
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { docTitle } from "../lib/brand";
import {
  createDatabaseApi,
  databaseExportUrl,
  databaseTableCsvUrl,
  deleteDatabaseApi,
  fetchDatabase,
  fetchDatabaseRows,
  fetchDatabases,
  queryDatabaseApi,
  updateDatabaseApi,
} from "../lib/api";
import type {
  DatabaseMeta,
  DatabaseQueryResult,
  DatabaseRowsPage,
  DatabaseSchema,
  WSServerMessage,
} from "../lib/types";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { OptionSelect } from "../ui/select";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { TopBar, TopBarActions } from "../ui/top-bar";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { Input, Textarea } from "../ui/input";
import { ResponsiveDialog } from "../ui/sheet";
import { useConfirm } from "../ui/confirm";
import { DataGrid, type DataGridSort } from "../ui/data-grid";
import { SIDEBAR_RAIL } from "../lib/sidebar-classes";
import { shortTime } from "../lib/time";
import { errorMessage } from "../lib/error-message";
import { databaseDetail } from "./SessionDatabasesPanel";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDatabase,
  IconPlus,
} from "./icons";
import {
  DATABASES_COLUMN,
  DATABASES_COLUMN_COUNT,
  DATABASES_COLUMN_HEADER,
  DATABASES_COLUMN_TITLE,
  DATABASES_LIST,
  DATABASES_META,
  DATABASES_META_LINE,
  DATABASES_PAGER,
  DATABASES_QUERY_EDITOR,
  DATABASES_ROW,
  DATABASES_ROW_DETAIL,
  DATABASES_ROW_HEAD,
  DATABASES_ROW_NAME,
  DATABASES_ROW_TIME,
  DATABASES_TOOLBAR,
} from "../lib/databases-classes";

interface Props {
  selectedDatabaseId?: string;
  selectedTable?: string;
  onSelect: (databaseId: string, table?: string) => void;
  /** Phone list/detail navigation: clear the selection to return to the list. */
  onBack: () => void;
  onOpenSession: (id: string) => void;
  addHandler: (handler: (message: WSServerMessage) => void) => () => void;
}

const PAGE_SIZE = 100;

type Mode = "rows" | "query";

interface Detail {
  database: DatabaseMeta;
  schema: DatabaseSchema;
}

/** Start a download of a URL the server answers with an attachment. */
function download(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function Databases({
  selectedDatabaseId,
  selectedTable,
  onSelect,
  onBack,
  onOpenSession,
  addHandler,
}: Props) {
  const [databases, setDatabases] = useState<DatabaseMeta[] | null>(null);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mode, setMode] = useState<Mode>("rows");
  const isPhone = useIsPhone();

  // loadList is also invoked from the mount-scoped ws handler, where props
  // from that first render would be stale; the live values come via refs.
  const selectionRef = useRef(selectedDatabaseId);
  const isPhoneRef = useRef(isPhone);
  useLayoutEffect(() => {
    selectionRef.current = selectedDatabaseId;
    isPhoneRef.current = isPhone;
  });

  async function loadList() {
    try {
      const next = await fetchDatabases();
      setDatabases(next);
      setError("");
      // On phones the bare /databases route IS the list page, so don't
      // auto-select: that would skip straight past it into the detail.
      if (!selectionRef.current && !isPhoneRef.current && next[0])
        onSelect(next[0].id);
    } catch (e) {
      setError(errorMessage(e, "Failed to load databases"));
      setDatabases([]);
    }
  }
  const loadListEvent = useEffectEvent(() => loadList());

  // Rows: one page of the selected table, ordered on the server. Declared
  // ahead of the socket handler below, which bumps rowsVersion on a write.
  const [page, setPage] = useState<DatabaseRowsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<DataGridSort | undefined>();
  const [rowsVersion, setRowsVersion] = useState(0);
  const [rowsError, setRowsError] = useState("");

  // The open database's meta and schema. Rows are loaded separately below,
  // since they change with the table, the page and the order.
  const [detailError, setDetailError] = useState("");
  const loadDetail = useEffectEvent(async (id: string) => {
    try {
      const next = await fetchDatabase(id);
      setDetail(next);
      setDetailError("");
      if (!selectedTable && next.schema.tables[0])
        onSelect(id, next.schema.tables[0].name);
    } catch (e) {
      setDetail(null);
      setDetailError(errorMessage(e, "Failed to load database"));
    }
  });

  useEffect(() => {
    document.title = docTitle("Databases");
    loadListEvent();
    return addHandler((message) => {
      if (message.type !== "databases_changed") return;
      loadListEvent();
      if (message.databaseId === selectionRef.current) {
        loadDetail(message.databaseId);
        setRowsVersion((version) => version + 1);
      }
    });
  }, [addHandler]);

  useEffect(() => {
    if (!selectedDatabaseId) {
      setDetail(null);
      return;
    }
    setMode("rows");
    loadDetail(selectedDatabaseId);
  }, [selectedDatabaseId]);

  useEffect(() => {
    setOffset(0);
    setSort(undefined);
  }, [selectedDatabaseId, selectedTable]);
  useEffect(() => {
    if (!selectedDatabaseId || !selectedTable) {
      setPage(null);
      return;
    }
    let alive = true;
    fetchDatabaseRows(selectedDatabaseId, selectedTable, {
      offset,
      limit: PAGE_SIZE,
      sort: sort?.column,
      dir: sort?.dir,
    })
      .then((next) => {
        if (!alive) return;
        setPage(next);
        setRowsError("");
      })
      .catch((e) => {
        if (!alive) return;
        setPage(null);
        setRowsError(errorMessage(e, "Failed to load rows"));
      });
    return () => {
      alive = false;
    };
  }, [selectedDatabaseId, selectedTable, offset, sort, rowsVersion]);

  // Query: a statement the person types, run read-only.
  const [sql, setSql] = useState("");
  const [queryResult, setQueryResult] = useState<DatabaseQueryResult | null>(
    null,
  );
  const [queryError, setQueryError] = useState("");
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setSql("");
    setQueryResult(null);
    setQueryError("");
  }, [selectedDatabaseId]);
  const runQuery = async () => {
    if (!selectedDatabaseId || !sql.trim() || running) return;
    setRunning(true);
    try {
      setQueryResult(await queryDatabaseApi(selectedDatabaseId, sql));
      setQueryError("");
    } catch (e) {
      setQueryResult(null);
      setQueryError(errorMessage(e, "Query failed"));
    }
    setRunning(false);
  };

  // New / rename share one small form.
  const [form, setForm] = useState<{
    kind: "new" | "rename";
    name: string;
    description: string;
  } | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitForm = async () => {
    if (!form || saving) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("A name is required");
      return;
    }
    setSaving(true);
    try {
      if (form.kind === "new") {
        const created = await createDatabaseApi({
          name,
          description: form.description.trim() || undefined,
        });
        onSelect(created.id);
      } else if (selectedDatabaseId) {
        const updated = await updateDatabaseApi(selectedDatabaseId, {
          name,
          description: form.description.trim(),
        });
        setDetail((current) =>
          current ? { ...current, database: updated } : current,
        );
      }
      setForm(null);
      setFormError("");
    } catch (e) {
      setFormError(errorMessage(e, "Failed to save"));
    }
    setSaving(false);
  };

  const [confirm, confirmElement] = useConfirm();
  const removeSelected = () => {
    const database = detail?.database;
    if (!database) return;
    confirm({
      title: `Delete "${database.name}"?`,
      description:
        "Every table in it goes with it. Download it first if anything in it matters.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => {
        deleteDatabaseApi(database.id)
          .then(() => onBack())
          .catch((e) => setDetailError(errorMessage(e, "Failed to delete")));
      },
    });
  };

  if (databases === null)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingState>Loading databases…</LoadingState>
      </div>
    );

  const formDialog = (
    <ResponsiveDialog
      open={!!form}
      onClose={() => setForm(null)}
      phone={isPhone}
      label={form?.kind === "rename" ? "Rename database" : "New database"}
    >
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitForm();
        }}
      >
        <h2 className="m-0 text-item-title font-semibold text-fg">
          {form?.kind === "rename" ? "Rename database" : "New database"}
        </h2>
        <label className="flex flex-col gap-1 text-label text-dim">
          Name
          <Input
            autoFocus
            value={form?.name ?? ""}
            onChange={(event) =>
              setForm((current) =>
                current ? { ...current, name: event.target.value } : current,
              )
            }
            placeholder="Support tickets"
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-dim">
          Description
          <Textarea
            value={form?.description ?? ""}
            onChange={(event) =>
              setForm((current) =>
                current
                  ? { ...current, description: event.target.value }
                  : current,
              )
            }
            placeholder="What the data is and where it comes from"
            rows={2}
          />
        </label>
        {formError && <InlineAlert>{formError}</InlineAlert>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="md" onClick={() => setForm(null)}>
            Cancel
          </Button>
          <Button type="submit" size="md" variant="primary" disabled={saving}>
            {form?.kind === "rename" ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  );

  const openNewForm = () => setForm({ kind: "new", name: "", description: "" });

  if (!databases.length)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
        <EmptyState
          icon={<IconDatabase size={22} />}
          title="No databases yet"
          action={
            <Button size="md" variant="primary" onClick={openNewForm}>
              New database
            </Button>
          }
        >
          Ask a session to keep data in a database, or create an empty one here
          and point a session at it.
        </EmptyState>
        {error && (
          <InlineAlert className="mt-2 max-w-[420px]">{error}</InlineAlert>
        )}
        {formDialog}
      </div>
    );

  // Phone: the two panes become separate pages, the list at bare
  // /databases, the detail once one is selected, with a back button between.
  const showList = !isPhone || !selectedDatabaseId;
  const showDetail = !isPhone || !!selectedDatabaseId;
  const database = detail?.database;
  const tables = detail?.schema.tables ?? [];
  const tableOptions = tables.map((table) => ({
    value: table.name,
    label: table.kind === "view" ? `${table.name} (view)` : `${table.name}`,
  }));
  const currentTable = tables.find((table) => table.name === selectedTable);
  const shown = page?.rows.length ?? 0;

  const actions = database && (
    <>
      <Button
        size="md"
        className="shrink-0"
        onClick={() =>
          setForm({
            kind: "rename",
            name: database.name,
            description: database.description ?? "",
          })
        }
      >
        Rename
      </Button>
      <Button
        size="md"
        className="shrink-0"
        onClick={() => download(databaseExportUrl(database.id))}
        title="Download the .sqlite file"
      >
        Download
      </Button>
      <Button
        size="md"
        variant="danger"
        className="shrink-0"
        onClick={removeSelected}
      >
        Delete
      </Button>
      {database.lastSessionId && (
        <Button
          size="md"
          className="shrink-0"
          onClick={() => onOpenSession(database.lastSessionId!)}
        >
          Open session
        </Button>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {showList && (
        <aside className={DATABASES_COLUMN}>
          <TopBar as="header" className={DATABASES_COLUMN_HEADER}>
            <h1 className={DATABASES_COLUMN_TITLE}>Databases</h1>
            <TopBarActions>
              <span className={DATABASES_COLUMN_COUNT}>{databases.length}</span>
              <Button
                size="sm"
                icon={<IconPlus size={16} />}
                aria-label="New database"
                title="New database"
                onClick={openNewForm}
              />
            </TopBarActions>
          </TopBar>
          <div className={DATABASES_LIST}>
            {databases.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className={DATABASES_ROW}
                data-active={
                  (!isPhone && selectedDatabaseId === meta.id) || undefined
                }
                onClick={() => onSelect(meta.id)}
              >
                <span className={SIDEBAR_RAIL}>
                  <IconDatabase size={16} dense className="text-faint" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={DATABASES_ROW_HEAD}>
                    <span className={DATABASES_ROW_NAME}>{meta.name}</span>
                    <span
                      className={DATABASES_ROW_TIME}
                      title={new Date(meta.updatedAt).toLocaleString()}
                    >
                      {shortTime(meta.updatedAt)}
                    </span>
                  </span>
                  <span className={DATABASES_ROW_DETAIL}>
                    {databaseDetail(meta)}
                    {meta.automationName ? ` · ${meta.automationName}` : ""}
                  </span>
                </span>
                {isPhone && (
                  <IconChevronRight
                    size={16}
                    className="mt-0.5 shrink-0 text-faint"
                  />
                )}
              </button>
            ))}
          </div>
          {error && <InlineAlert className="m-3">{error}</InlineAlert>}
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
                Databases
              </button>
              {database && (
                <>
                  <h2 className="m-0 mt-1 px-1 text-item-title font-medium leading-snug text-dim">
                    {database.name}
                  </h2>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 px-1">
                    {actions}
                  </div>
                </>
              )}
            </TopBar>
          ) : (
            database && (
              <TopBar
                as="header"
                className="wco-chrome h-[var(--desktop-header-h)] shrink-0 gap-4 border-b border-divider px-5"
              >
                <h2 className="m-0 min-w-0 flex-1 truncate text-item-title font-medium text-dim">
                  {database.name}
                </h2>
                <TopBarActions className="gap-2">{actions}</TopBarActions>
              </TopBar>
            )
          )}

          {detailError && (
            <InlineAlert className="m-4">{detailError}</InlineAlert>
          )}

          {database && (
            <>
              <div className={DATABASES_META}>
                {database.description && (
                  <p className="m-0 mb-1 text-fg">{database.description}</p>
                )}
                <p className={DATABASES_META_LINE}>
                  {databaseDetail(database)}
                  {database.createdBy
                    ? ` · created by ${database.createdBy}`
                    : ""}
                  {` · updated ${formatDate(database.updatedAt)}`}
                </p>
              </div>

              <div className={DATABASES_TOOLBAR}>
                <Segmented
                  label="Show"
                  size="sm"
                  value={mode}
                  onValueChange={(value) =>
                    setMode(value === "query" ? "query" : "rows")
                  }
                >
                  <SegmentedOption value="rows">Rows</SegmentedOption>
                  <SegmentedOption value="query">Query</SegmentedOption>
                </Segmented>
                {mode === "rows" && tables.length > 0 && (
                  <OptionSelect
                    label="Table"
                    size="sm"
                    // On a phone the picker takes its own line rather than
                    // truncating the table name beside the download button.
                    className="min-w-0 max-w-[260px] flex-1 phone:order-last phone:basis-full phone:max-w-none"
                    value={selectedTable ?? tables[0].name}
                    options={tableOptions}
                    onChange={(table) => onSelect(database.id, table)}
                  />
                )}
                {mode === "rows" && currentTable && (
                  <Button
                    size="sm"
                    className="ml-auto shrink-0"
                    onClick={() =>
                      download(
                        databaseTableCsvUrl(database.id, currentTable.name),
                      )
                    }
                  >
                    Download CSV
                  </Button>
                )}
              </div>

              {mode === "rows" &&
                (tables.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center p-8">
                    <EmptyState title="No tables yet">
                      A session can add some with execute_sql, or a schema at
                      create time.
                    </EmptyState>
                  </div>
                ) : rowsError ? (
                  <InlineAlert className="m-4">{rowsError}</InlineAlert>
                ) : page === null ? (
                  <div className="flex flex-1 items-center justify-center">
                    <LoadingState>Loading rows…</LoadingState>
                  </div>
                ) : page.rows.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center p-8">
                    <EmptyState title="No rows">
                      This table is empty.
                    </EmptyState>
                  </div>
                ) : (
                  <>
                    <DataGrid
                      columns={page.columns}
                      rows={page.rows}
                      sort={sort}
                      onSort={(next) => {
                        setSort(next);
                        setOffset(0);
                      }}
                    />
                    <div className={DATABASES_PAGER}>
                      <span>
                        {page.offset + 1}–{page.offset + shown} of{" "}
                        {page.total.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          disabled={page.offset === 0}
                          onClick={() =>
                            setOffset(Math.max(0, page.offset - PAGE_SIZE))
                          }
                        >
                          Previous
                        </Button>
                        <Button
                          size="sm"
                          disabled={page.offset + shown >= page.total}
                          onClick={() => setOffset(page.offset + PAGE_SIZE)}
                        >
                          Next
                        </Button>
                      </span>
                    </div>
                  </>
                ))}

              {mode === "query" && (
                <>
                  <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2 phone:px-3">
                    <Textarea
                      className={DATABASES_QUERY_EDITOR}
                      aria-label="SQL query"
                      value={sql}
                      spellCheck={false}
                      placeholder={
                        currentTable
                          ? `SELECT * FROM "${currentTable.name}" LIMIT 50`
                          : "SELECT …"
                      }
                      onChange={(event) => setSql(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          void runQuery();
                        }
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="md"
                        variant="primary"
                        disabled={!sql.trim() || running}
                        onClick={() => void runQuery()}
                      >
                        {running ? "Running…" : "Run"}
                      </Button>
                      <span className="text-meta text-faint">
                        Read-only. {isPhone ? "" : "⌘⏎ runs it."}
                      </span>
                      {queryResult && (
                        <span className="ml-auto text-meta tabular-nums text-faint">
                          {queryResult.rows.length.toLocaleString()} row
                          {queryResult.rows.length === 1 ? "" : "s"}
                          {queryResult.truncated ? " (truncated)" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  {queryError && (
                    <InlineAlert className="mx-4 mb-2 phone:mx-3">
                      {queryError}
                    </InlineAlert>
                  )}
                  {queryResult &&
                    (queryResult.rows.length ? (
                      <DataGrid
                        columns={queryResult.columns}
                        rows={queryResult.rows}
                      />
                    ) : (
                      <div className="px-4 py-3 text-label text-dim phone:px-3">
                        No rows.
                      </div>
                    ))}
                </>
              )}
            </>
          )}
          {formDialog}
          {confirmElement}
        </section>
      )}
      {!showDetail && formDialog}
    </div>
  );
}
