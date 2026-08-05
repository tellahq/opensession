import { repoLabel } from "../lib/repo-label";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchActions,
  createActionApi,
  deleteActionApi,
  runActionApi,
  introspectActionApi,
  fetchRepos,
  relativeTime,
  type Action,
  type ActionInput,
  type ActionInputType,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { PageSection } from "../ui/page";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { InlineAlert } from "../ui/state";
import { cn } from "../ui/cn";

interface Props {
  onOpenSession: (sessionId: string) => void;
  /** Selected action id (or name) — from the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

/**
 * Actions: run a registered repo script behind a form. Each run spins up a real
 * (fast-model) session that executes the script — open it to watch the output,
 * fork it into a full session to dig in. Selecting an action opens the detail
 * drawer, where its run form lives (no modal).
 */
export function Actions({ onOpenSession, selectedId, onSelect }: Props) {
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setActions(await fetchActions());
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = docTitle("Actions");
    load();
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // The routed selection — matched by id, or by name for deep-links.
  const sel = useMemo(
    () =>
      selectedId
        ? actions.find((a) => a.id === selectedId || a.name === selectedId) || null
        : null,
    [actions, selectedId],
  );

  // Escape backs out of the detail drawer.
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!sel, onSelect]);

  async function handleDelete(a: Action) {
    if (!confirm(`Delete action "${a.name}"?`)) return;
    try {
      await deleteActionApi(a.id);
      if (sel?.id === a.id) onSelect("");
      load();
    } catch (e: any) {
      setError(e.message || String(e));
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <div className={cn("min-w-0 flex-1 overflow-y-auto px-6 pb-[60px] pt-7 max-[560px]:px-4 max-[560px]:pb-12 max-[560px]:pt-5", sel && "basis-[340px] grow-0 border-r border-line px-3.5 pb-10 pt-4 max-[900px]:hidden")}>
    <PageSection>
      <PageHeader
        className={sel ? "mb-3.5 items-center" : "max-[560px]:mb-5 max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5"}
      >
        <div>
          <PageTitle className={sel ? "text-body" : undefined}>Actions</PageTitle>
          <PageDescription className={sel ? "hidden" : undefined}>
            Run a registered repo script behind a form. Each run opens as a session you can fork.
          </PageDescription>
        </div>
        <Button variant="primary" size="lg" className="mt-[18px] px-[18px] text-control-label font-medium" onClick={() => setShowForm(true)}>
          + New action
        </Button>
      </PageHeader>

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {showForm && (
        <ActionForm
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : actions.length === 0 ? (
        <div className="px-4 py-12 text-center text-dim">
          <p>No actions yet.</p>
          <p className="text-control-label text-faint">
            Register a script from a repo (e.g. scripts/run-maintenance.sh).
          </p>
        </div>
      ) : (
        <div className="flex flex-col border-t border-line">
          {actions.map((a) => (
            <button
              key={a.id}
              className={cn("flex w-full min-w-0 items-center gap-3 border-0 border-b border-line bg-transparent px-2.5 py-2.5 text-left text-fg hover:bg-hover max-[560px]:gap-2.5 max-[560px]:px-1 max-[560px]:py-3", sel?.id === a.id && "bg-active")}
              onClick={() => onSelect(a.id)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-body font-semibold">{a.name}</span>
                <span className="truncate font-mono text-meta text-faint">
                  {a.kind === "mcp"
                    ? `${a.mcpServer} · ${a.toolName}`
                    : `${a.repo ? repoLabel(a.repo) : ""} · ${a.scriptPath}`}
                </span>
              </span>
              {a.confirm && (
                <span className="source-chip" title="Asks for a confirm before running">
                  confirm
                </span>
              )}
              <span className="w-[84px] shrink-0 text-right text-label text-faint max-[560px]:hidden">
                {a.lastRunAt ? relativeTime(a.lastRunAt) : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </PageSection>
    </div>

      {sel && (
        <aside className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line bg-panel max-[900px]:border-l-0">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
            <button
              className="-my-1 -ml-0.5 hidden shrink-0 items-center gap-1.5 border-0 bg-transparent px-1.5 py-1 text-body font-medium text-fg max-[900px]:inline-flex"
              onClick={() => onSelect("")}
              title="Back to actions"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Actions
            </button>
            <span className="min-w-0 truncate text-control-label font-semibold">{sel.name}</span>
            <div className="ml-auto flex shrink-0 gap-1.5">
              <Button size="sm" variant="danger" onClick={() => handleDelete(sel)}>
                Delete
              </Button>
            </div>
            <button
              className="flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:bg-hover hover:text-fg max-[900px]:hidden"
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-10 pt-[18px]">
            {sel.description && (
              <div className="bg-surface border border-line rounded-panel px-3.5 py-3 text-control-label leading-relaxed text-dim">
                {sel.description}
              </div>
            )}

            <div>
              <div className="mb-1.5 text-label font-semibold text-faint">Run</div>
              <RunForm
                key={sel.id}
                action={sel}
                onRan={(sessionId) => {
                  load();
                  onOpenSession(sessionId);
                }}
              />
            </div>

            <div>
              <div className="mb-1.5 text-label font-semibold text-faint">Configuration</div>
              <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-control-label">
                <DetailKey>Type</DetailKey>
                <span className="text-dim">
                  {sel.kind === "mcp"
                    ? "MCP tool — runs on its own server with its own credentials"
                    : "Repo script"}
                </span>

                <DetailKey>{sel.kind === "mcp" ? "Tool" : "Script"}</DetailKey>
                <span className="text-dim min-w-0">
                  <span className="rounded-sm bg-active px-1.5 py-px font-mono text-meta">
                    {sel.kind === "mcp"
                      ? `${sel.mcpServer} · ${sel.toolName}`
                      : `${sel.repo ? repoLabel(sel.repo) : ""}:${sel.scriptPath}`}
                  </span>
                </span>

                {sel.kind !== "mcp" && sel.argMode && (
                  <>
                    <DetailKey>Args</DetailKey>
                    <span className="text-dim">
                      {sel.argMode === "positional"
                        ? "positional ($1 $2 …)"
                        : "env vars (NAME=…)"}
                    </span>
                  </>
                )}

                <DetailKey>Confirm</DetailKey>
                <span className="text-dim">
                  {sel.confirm ? "required before each run" : "not required"}
                </span>

                <DetailKey>Created</DetailKey>
                <span className="text-dim">by {sel.createdBy}</span>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-label font-semibold text-faint">Activity</div>
              {sel.lastRunAt ? (
                <div className="text-dim text-supporting">
                  last run {relativeTime(sel.lastRunAt)}
                  {sel.lastRunSessionId && (
                    <>
                      {" · "}
                      <a
                        className="text-accent hover:underline"
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenSession(sel.lastRunSessionId!);
                        }}
                        href="#"
                      >
                        open session
                      </a>
                    </>
                  )}
                </div>
              ) : (
                <div className="text-faint text-supporting">No runs yet.</div>
              )}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">{children}</span>
  );
}

// ── Run form: render the action's inputs inline in the drawer, then run ──

function RunForm({
  action,
  onRan,
}: {
  action: Action;
  onRan: (sessionId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const i of action.inputs) init[i.name] = i.default ?? "";
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runActionApi(action.id, values, getCurrentUser() || "Anonymous");
      onRan(sessionId);
    } catch (e: any) {
      setError(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-supporting [&_label]:font-medium [&_label]:text-dim [&_input]:rounded-md [&_input]:border [&_input]:border-line-strong [&_input]:bg-raised [&_input]:px-3 [&_input]:py-2 [&_input]:text-control-label [&_input]:text-fg [&_select]:rounded-md [&_select]:border [&_select]:border-line-strong [&_select]:bg-raised [&_select]:px-3 [&_select]:py-2 [&_select]:text-control-label [&_select]:text-fg">
      {action.inputs.length === 0 && (
        <div className="mt-1 text-supporting text-faint">This action takes no inputs.</div>
      )}

      {action.inputs.map((input) => (
        <label key={input.name}>
          {input.label || input.name}
          {input.required ? " *" : ""}
          {input.type === "select" ? (
            <select
              value={values[input.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            >
              <option value="">—</option>
              {(input.options || []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : input.type === "boolean" ? (
            <select
              value={values[input.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            >
              <option value="">false</option>
              <option value="true">true</option>
            </select>
          ) : (
            <input
              className="mono-input"
              type={input.type === "number" ? "number" : "text"}
              value={values[input.name] ?? ""}
              placeholder={input.hint || ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            />
          )}
          {input.hint && <span className="mt-1 text-supporting text-faint">{input.hint}</span>}
        </label>
      ))}

      {action.confirm && (
        <div className="mt-1 text-supporting text-yellow">
          ⚠ This action runs against prod. Double-check the values before running.
        </div>
      )}

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="flex justify-start gap-2.5">
        <Button variant="primary" className="px-[22px]" onClick={run} disabled={busy}>
          {busy ? "Starting…" : action.confirm ? "Confirm & run" : "Run"}
        </Button>
      </div>
    </div>
  );
}

// ── Create form: register a repo script ──

const INPUT_TYPES: ActionInputType[] = ["text", "number", "select", "boolean"];

function ActionForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"repo" | "mcp">("repo");
  const [repo, setRepo] = useState("");
  const [repos, setRepos] = useState<Array<{ id: string; label: string }>>([]);
  const [scriptPath, setScriptPath] = useState("");
  const [argMode, setArgMode] = useState<"positional" | "env">("positional");
  const [mcpServer, setMcpServer] = useState("");
  const [toolName, setToolName] = useState("");
  const [confirmFlag, setConfirmFlag] = useState(true);
  const [inputs, setInputs] = useState<ActionInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRepos()
      .then((items) => {
        const options = items.map((item) => ({
          id: item.id,
          label: item.label || item.id,
        }));
        setRepos(options);
        setRepo((current) =>
          options.some((item) => item.id === current)
            ? current
            : items.find((item) => item.default)?.id || options[0]?.id || "",
        );
      })
      .catch((e) => setError(e.message || String(e)));
  }, []);

  async function detect() {
    if (!scriptPath.trim()) return;
    setDetecting(true);
    setError(null);
    try {
      const res = await introspectActionApi(repo, scriptPath.trim());
      setInputs(res.inputs);
      setArgMode(res.argMode);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setDetecting(false);
    }
  }

  function addInput() {
    setInputs((arr) => [...arr, { name: "", label: "", type: "text", required: true }]);
  }
  function updateInput(idx: number, patch: Partial<ActionInput>) {
    setInputs((arr) => arr.map((i, n) => (n === idx ? { ...i, ...patch } : i)));
  }
  function removeInput(idx: number) {
    setInputs((arr) => arr.filter((_, n) => n !== idx));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await createActionApi({
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        inputs: inputs.filter((i) => i.name.trim()),
        confirm: confirmFlag,
        createdBy: getCurrentUser() || "Anonymous",
        ...(kind === "repo"
          ? { repo, scriptPath: scriptPath.trim(), argMode }
          : { mcpServer: mcpServer.trim(), toolName: toolName.trim() }),
      });
      onCreated();
    } catch (e: any) {
      setError(e.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 rounded-panel border border-line-strong bg-panel p-[18px] [&_label]:flex [&_label]:flex-1 [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-supporting [&_label]:font-medium [&_label]:text-dim [&_input]:rounded-md [&_input]:border [&_input]:border-line-strong [&_input]:bg-raised [&_input]:px-3 [&_input]:py-2 [&_input]:text-control-label [&_input]:text-fg [&_select]:rounded-md [&_select]:border [&_select]:border-line-strong [&_select]:bg-raised [&_select]:px-3 [&_select]:py-2 [&_select]:text-control-label [&_select]:text-fg">
      <div className="text-body font-semibold">New action</div>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Run maintenance task" />
      </label>

      <label>
        Description (optional)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what this action does"
        />
      </label>

      <label>
        Type
        <select value={kind} onChange={(e) => setKind(e.target.value as "repo" | "mcp")}>
          <option value="repo">Repo script — run a script from a repo</option>
          <option value="mcp">MCP tool — call a tool on an MCP server</option>
        </select>
      </label>

      {kind === "repo" ? (
        <div className="flex gap-3.5">
          <label>
            Repo
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((item) => (
                <option key={item.id} value={item.id}>{item.label || repoLabel(item.id)}</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 2 }}>
            Script path (relative to repo root)
            <input
              className="mono-input"
              value={scriptPath}
              onChange={(e) => setScriptPath(e.target.value)}
              placeholder="scripts/maintenance.ts"
              onBlur={detect}
            />
          </label>
          <label>
            Arg mode
            <select value={argMode} onChange={(e) => setArgMode(e.target.value as "positional" | "env")}>
              <option value="positional">Positional ($1 $2 …)</option>
              <option value="env">Env vars (NAME=… )</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="flex gap-3.5">
          <label style={{ flex: 2 }}>
            MCP server
            <input
              className="mono-input"
              value={mcpServer}
              onChange={(e) => setMcpServer(e.target.value)}
              placeholder="support"
            />
          </label>
          <label style={{ flex: 2 }}>
            Tool name
            <input
              className="mono-input"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="tool_name"
            />
          </label>
        </div>
      )}

      {kind === "mcp" && (
        <div className="mt-1 text-supporting text-faint">
          Each input's variable name must match the tool's argument name. The tool runs on its own
          server with its own credentials.
        </div>
      )}

      {kind === "repo" && (
        <div className="flex justify-start gap-2.5">
          <Button
            size="sm"
            className="border-line-strong bg-transparent"
            onClick={detect}
            disabled={detecting || !scriptPath.trim()}
          >
            {detecting ? "Detecting…" : "Detect inputs from script"}
          </Button>
        </div>
      )}

      <div className="mt-2 text-body font-semibold">
        Inputs {kind === "mcp" ? "(arg names)" : argMode === "positional" ? "(in order →)" : ""}
      </div>
      {inputs.length === 0 && <div className="mt-1 text-supporting text-faint">No inputs — the script runs with no args.</div>}
      {inputs.map((input, idx) => (
        <div className="flex items-end gap-3.5" key={idx}>
          <label>
            Variable name
            <input
              className="mono-input"
              value={input.name}
              onChange={(e) => updateInput(idx, { name: e.target.value })}
              placeholder={argMode === "env" ? "STORY_ID" : "ID"}
            />
          </label>
          <label>
            Label
            <input
              value={input.label || ""}
              onChange={(e) => updateInput(idx, { label: e.target.value })}
              placeholder="Story ID"
            />
          </label>
          <label>
            Type
            <select
              value={input.type}
              onChange={(e) => updateInput(idx, { type: e.target.value as ActionInputType })}
            >
              {INPUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 0 auto" }}>
            Required
            <input
              type="checkbox"
              checked={!!input.required}
              onChange={(e) => updateInput(idx, { required: e.target.checked })}
            />
          </label>
          <Button size="sm" variant="danger" onClick={() => removeInput(idx)}>
            ✕
          </Button>
        </div>
      ))}
      <div className="flex justify-start gap-2.5">
        <Button size="sm" className="border-line-strong bg-transparent" onClick={addInput}>
          + Add input
        </Button>
      </div>

      <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={confirmFlag}
          onChange={(e) => setConfirmFlag(e.target.checked)}
        />
        Require a confirm before running (recommended for anything touching prod)
      </label>

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="flex justify-end gap-2.5">
        <Button
          size="sm"
          className="min-h-7 border-line-strong bg-transparent px-3 text-control-label"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="px-[22px]"
          onClick={handleSave}
          disabled={
            saving ||
            !name.trim() ||
            (kind === "repo" ? !repo || !scriptPath.trim() : !mcpServer.trim() || !toolName.trim())
          }
        >
          {saving ? "Saving…" : "Create action"}
        </Button>
      </div>
    </div>
  );
}
