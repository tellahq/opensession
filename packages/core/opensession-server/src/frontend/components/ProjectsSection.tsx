import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { OptionSelect } from "../ui/select";
import { InlineAlert } from "../ui/state";
import { IconTile } from "./BrandTile";
import { IconPlus, IconTrash } from "./icons";
import { SectionHeading } from "./Connections";
import { SettingCard, rowMenuTriggerClasses } from "../ui/settings";
import type { FeedDescriptor, Project } from "../lib/types";
import { fieldClasses } from "../ui/input";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  wFull: {
    width: "100%",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
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
  maxH60vh: {
    maxHeight: "60vh",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  px1: {
    paddingInline: "4px",
  },
  grid: {
    display: "grid",
  },
  gridCols2: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  flexShrink0: {
    flexShrink: "0",
  },
  maxH28: {
    maxHeight: "calc(4px * 28)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  p2: {
    padding: "calc(4px * 2)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  gridCols3: {
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  },
  gridCols1fr2fr: {
    gridTemplateColumns: "1fr 2fr",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

/**
 * Connections → Projects. A *project* is a source of work with its own sidebar
 * band; a registered git repo is one kind, an MCP-backed feed (Plain, videos,
 * …) the other. Either way its branches/items become workspaces — see
 * CONCEPTS.md.
 *
 * Both kinds are listed here (`/api/projects`), but only feeds are authored
 * here: a repo project is instance config, so it is shown read-only and
 * registered under Setup → Repositories. The New-project modal walks: pick a
 * connected MCP server
 * → pick its list-tool (live catalog) → fetch a sample call → the field
 * mapping is auto-suggested from the result and stays editable → optional
 * web-panel template → Save. Zero code per new project.
 */

// ── mapping suggester ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findItemsPath(
  obj: unknown,
): { path: string; sample: Record<string, unknown> } | null {
  const queue: Array<{ node: unknown; path: string }> = [
    { node: obj, path: "" },
  ];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const { node, path } = queue.shift()!;
    if (Array.isArray(node)) {
      if (isRecord(node[0])) return { path, sample: node[0] };
      continue;
    }
    if (isRecord(node))
      for (const [key, value] of Object.entries(node))
        queue.push({
          node: value,
          path: path ? `${path}.${key}` : key,
        });
  }
  return null;
}

/** Keys of `sample` (one nesting level deep, dot-joined) whose value is a string. */
function stringPaths(sample: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sample)) {
    if (typeof v === "string" || typeof v === "number") out.push(k);
    else if (isRecord(v))
      for (const [k2, v2] of Object.entries(v))
        if (typeof v2 === "string") out.push(`${k}.${k2}`);
  }
  return out;
}

function pick(paths: string[], patterns: RegExp[]): string {
  for (const p of patterns) {
    const hit = paths.find((k) => p.test(k.split(".").pop() || k));
    if (hit) return hit;
  }
  return "";
}

function valueAtPath(sample: Record<string, unknown>, path: string): unknown {
  let value: unknown = sample;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function suggestMap(sample: Record<string, unknown>) {
  const paths = stringPaths(sample);
  return {
    id: pick(paths, [/^id$/i, /Id$/, /^key$/i, /^slug$/i]),
    title: pick(paths, [/^(name|title|subject|label)$/i]),
    preview: pick(paths, [/^(description|preview|summary|excerpt|text)$/i]),
    ts: pick(paths, [
      /^(updatedAt|updated_at|modifiedAt)$/i,
      /^(createdAt|created_at|date|ts)$/i,
    ]),
    url:
      paths.find((path) =>
        /^https?:\/\//.test(String(valueAtPath(sample, path))),
      ) || "",
    thumbnail: pick(paths, [/thumb/i, /image/i, /avatar/i]),
  };
}

// ── component ────────────────────────────────────────────────────────────────

const inputCls = fieldClasses("md");
const labelCls = utilityClassName(
  "mb-1 mt-3 block text-meta font-semibold text-faint",
);

function parseArgs(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw new Error("Args must be valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Args must be a JSON object");
  return parsed;
}

export function ProjectsSection() {
  const [feeds, setFeeds] = useState<FeedDescriptor[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/feeds`);
      if (res.ok) setFeeds((await res.json()).feeds || []);
      else setError(`Failed to load feeds: ${res.status}`);
    } catch (error) {
      setError(errorMessage(error, "Failed to load feeds"));
    }
    try {
      // The union view: repo projects come from the registry, feed
      // projects from the same descriptors above. Only feeds are
      // editable here, but both belong in the list.
      const res = await fetch(`${BASE_PATH}/api/projects`);
      if (res.ok) setProjects((await res.json()).projects || []);
      else setError(`Failed to load projects: ${res.status}`);
    } catch (error) {
      setError(errorMessage(error, "Failed to load projects"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    if (
      !confirm(
        `Remove project "${id}"? Its sidebar band disappears; existing workspaces keep working.`,
      )
    )
      return;
    const res = await fetch(
      `${BASE_PATH}/api/feeds/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) setError((await res.json()).error || `Failed: ${res.status}`);
    void load();
  }

  const repoProjects = (projects || []).filter((p) => p.kind === "repo");

  return (
    <>
      <SectionHeading>
        Projects: every source of work, one band each
      </SectionHeading>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {!!repoProjects.length && (
        <SettingCard>
          {repoProjects.map((p) => (
            <div
              key={p.key}
              {...stylex.props(
                sx.flex,
                sx.itemsCenter,
                sx.gap3,
                sx.px5,
                sx.py3,
              )}
            >
              <IconTile name={p.id} size={30} />
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <div
                  {...stylex.props(
                    sx.fontMedium,
                    sx.textFg,
                    typography.itemTitle,
                  )}
                >
                  {p.label}
                </div>
                <div
                  {...stylex.props(sx.truncate, sx.textDim, typography.label)}
                >
                  Repository · {p.repo?.ghRepo}
                  {p.repo?.defaultBranch ? ` · ${p.repo.defaultBranch}` : ""}
                  {p.repo?.sharedCheckout ? " · shared checkout" : ""}
                  {p.repo?.isDefault ? " · default" : ""}
                </div>
              </div>
            </div>
          ))}
        </SettingCard>
      )}
      <SettingCard>
        {(feeds || []).map((f) => (
          <div
            key={f.id}
            {...mergeStylexProps(
              "group",
              sx.flex,
              sx.itemsCenter,
              sx.gap3,
              sx.px5,
              sx.py3,
            )}
          >
            <IconTile name={f.id} size={30} />
            <div {...stylex.props(sx.minW0, sx.flex1)}>
              <div
                {...stylex.props(
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                {f.title}
              </div>
              <div {...stylex.props(sx.truncate, sx.textDim, typography.label)}>
                {f.fromConfig ? "Config project" : "Built-in"} · ref {f.refKind}
                {f.mcpServers?.length
                  ? ` · MCP: ${f.mcpServers.join(", ")}`
                  : ""}
              </div>
            </div>
            {f.fromConfig && (
              <button
                className={cn(
                  rowMenuTriggerClasses,
                  utilityClassName(
                    "opacity-0 transition-[color,opacity,background] hover:text-red group-hover:opacity-100",
                  ),
                )}
                onClick={() => remove(f.id)}
                aria-label={`Remove ${f.title}`}
              >
                <IconTrash size={16} />
              </button>
            )}
          </div>
        ))}
        <button
          {...stylex.props(
            sx.flex,
            sx.wFull,
            sx.itemsCenter,
            sx.gap2,
            sx.px5,
            sx.py3,
            sx.fontMedium,
            sx.textDim,
            sx.transitionColors,
            sx.hoverBgHover,
            sx.hoverTextFg,
            typography.controlLabel,
          )}
          onClick={() => setOpen(true)}
        >
          <IconPlus size={16} /> New project
        </button>
      </SettingCard>
      <NewProjectModal
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          void load();
        }}
      />
    </>
  );
}

function NewProjectModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [servers, setServers] = useState<string[]>([]);
  const [server, setServer] = useState("");
  const [tools, setTools] = useState<{ name: string; description?: string }[]>(
    [],
  );
  const [tool, setTool] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [path, setPath] = useState("");
  const [map, setMap] = useState({
    id: "",
    title: "",
    preview: "",
    ts: "",
    url: "",
    thumbnail: "",
  });
  const [sampleItem, setSampleItem] = useState<string | null>(null);
  const [panelLabel, setPanelLabel] = useState("");
  const [panelEmbed, setPanelEmbed] = useState("");
  const [panelLinkLabel, setPanelLinkLabel] = useState("");
  const [panelLinkHref, setPanelLinkHref] = useState("");
  const [tileBg, setTileBg] = useState("#64748b");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Connected HTTP servers for the picker.
  useEffect(() => {
    if (!open) return;
    const loadServers = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/connections`);
        if (!res.ok) {
          setError(`Failed to load MCP servers: ${res.status}`);
          return;
        }
        const body = await res.json();
        setServers(
          (body.mcpServers || [])
            .filter(
              (server: { transport: string }) => server.transport === "http",
            )
            .map((server: { name: string }) => server.name),
        );
      } catch (error) {
        setError(errorMessage(error, "Failed to load MCP servers"));
      }
    };
    void loadServers();
  }, [open]);

  // Tool catalog on server change.
  useEffect(() => {
    setTools([]);
    setTool("");
    if (!server) return;
    const loadTools = async () => {
      setBusy("Loading tool catalog…");
      try {
        const res = await fetch(
          `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(server)}/tools`,
        );
        const body = await res.json();
        if (!res.ok) {
          setError(body.error || `Failed to load tool catalog: ${res.status}`);
          setBusy(null);
          return;
        }
        const all: { name: string; description?: string }[] = body.tools || [];
        // List-like tools first because feeds are built from collections.
        all.sort((a, b) => {
          const la = /^(list|search|get_all)/.test(a.name) ? 0 : 1;
          const lb = /^(list|search|get_all)/.test(b.name) ? 0 : 1;
          return la - lb || a.name.localeCompare(b.name);
        });
        setTools(all);
      } catch (error) {
        setError(errorMessage(error, "Failed to load tool catalog"));
      }
      setBusy(null);
    };
    void loadTools();
  }, [server]);

  async function fetchSample() {
    setError(null);
    setBusy("Calling the tool…");
    try {
      const args = parseArgs(argsText);
      const res = await fetch(`${BASE_PATH}/api/feeds/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server, tool, args }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || `Failed to fetch sample: ${res.status}`);
        setBusy(null);
        return;
      }
      const raw = body.result ?? JSON.parse(body.sample || "null");
      const found = findItemsPath(raw);
      if (!found) {
        setError(
          "No array of items found in the tool result. Try different args or another tool.",
        );
        setBusy(null);
        return;
      }
      setPath(found.path);
      setMap(suggestMap(found.sample));
      setSampleItem(JSON.stringify(found.sample, null, 1).slice(0, 600));
    } catch (error) {
      setError(errorMessage(error, "Failed to fetch sample"));
    }
    setBusy(null);
  }

  async function save() {
    setError(null);
    setBusy("Saving…");
    try {
      const id = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
      if (!id) {
        setError("Give the project a name");
        setBusy(null);
        return;
      }
      const args = parseArgs(argsText);
      const body = {
        id,
        title: title.trim(),
        refKind: id,
        tileBg,
        mcpServers: [server],
        items: {
          server,
          tool,
          args,
          ...(path ? { path } : {}),
          map: Object.fromEntries(Object.entries(map).filter(([, v]) => v)),
        },
        ...(panelLabel && panelEmbed
          ? {
              panel: {
                label: panelLabel,
                embedUrlTemplate: panelEmbed,
                ...(panelLinkLabel && panelLinkHref
                  ? {
                      links: [
                        { label: panelLinkLabel, hrefTemplate: panelLinkHref },
                      ],
                    }
                  : {}),
              },
            }
          : {}),
      };
      const res = await fetch(`${BASE_PATH}/api/feeds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (res.ok) onSaved();
      else setError(out.error || `Failed to save project: ${res.status}`);
    } catch (error) {
      setError(errorMessage(error, "Failed to save project"));
    }
    setBusy(null);
  }

  const canSave =
    !!title.trim() && !!server && !!tool && !!map.id && !!map.title;

  return (
    <Modal.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Modal.Content widthClassName={utilityClassName("max-w-[34rem]")}>
        <Modal.Header
          title="New project"
          description="A sidebar feed built from one MCP tool call. Pick a server and its list-tool, fetch a sample, then adjust the mapping."
        />
        <div {...stylex.props(sx.maxH60vh, sx.overflowYAuto, sx.px1)}>
          <label className={labelCls}>Name</label>
          <input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Videos, Tickets, Posts…"
          />

          <div {...stylex.props(sx.grid, sx.gridCols2, sx.gap3)}>
            <div>
              <label className={labelCls}>MCP server</label>
              <OptionSelect
                label="MCP server"
                value={server}
                options={[
                  { value: "", label: "Pick…" },
                  ...servers.map((s) => ({ value: s, label: s })),
                ]}
                onChange={setServer}
              />
            </div>
            <div>
              <label className={labelCls}>List tool</label>
              <OptionSelect
                label="List tool"
                value={tool}
                disabled={!tools.length}
                options={[
                  {
                    value: "",
                    label: tools.length ? "Pick…" : "Pick a server first",
                  },
                  ...tools.map((t) => ({ value: t.name, label: t.name })),
                ]}
                onChange={setTool}
              />
            </div>
          </div>

          <label className={labelCls}>Tool args (JSON)</label>
          <div {...stylex.props(sx.flex, sx.gap2)}>
            <input
              className={inputCls}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
            <Button
              variant="primary"
              className={mergeStylexOverrideClassName(
                "",
                sx.flexShrink0,
                typography.controlLabel,
              )}
              onClick={fetchSample}
              disabled={!server || !tool || !!busy}
            >
              Fetch sample
            </Button>
          </div>

          {sampleItem && (
            <>
              <label className={labelCls}>
                Sample item (items path: “{path || "(root)"}”)
              </label>
              <pre
                {...stylex.props(
                  sx.maxH28,
                  sx.overflowAuto,
                  sx.roundedMd,
                  sx.border,
                  sx.borderLine,
                  sx.bgSurface,
                  sx.p2,
                  sx.leadingSnug,
                  sx.textDim,
                  typography.meta,
                )}
              >
                {sampleItem}
              </pre>
            </>
          )}

          <div {...stylex.props(sx.grid, sx.gridCols3, sx.gap3)}>
            {(
              ["id", "title", "preview", "ts", "url", "thumbnail"] as const
            ).map((k) => (
              <div key={k}>
                <label className={labelCls}>
                  {k}
                  {k === "id" || k === "title" ? " *" : ""}
                </label>
                <input
                  className={inputCls}
                  value={map[k]}
                  onChange={(e) =>
                    setMap((m) => ({ ...m, [k]: e.target.value }))
                  }
                  placeholder="field path"
                />
              </div>
            ))}
          </div>

          <label className={labelCls}>
            Panel (optional): tab label and {"{id}"}-templated embed URL
          </label>
          <div {...stylex.props(sx.grid, sx.gridCols1fr2fr, sx.gap3)}>
            <input
              className={inputCls}
              value={panelLabel}
              onChange={(e) => setPanelLabel(e.target.value)}
              placeholder="Video"
            />
            <input
              className={inputCls}
              value={panelEmbed}
              onChange={(e) => setPanelEmbed(e.target.value)}
              placeholder="https://…/{id}/embed"
            />
          </div>
          <div {...stylex.props(sx.mt2, sx.grid, sx.gridCols1fr2fr, sx.gap3)}>
            <input
              className={inputCls}
              value={panelLinkLabel}
              onChange={(e) => setPanelLinkLabel(e.target.value)}
              placeholder="Open"
            />
            <input
              className={inputCls}
              value={panelLinkHref}
              onChange={(e) => setPanelLinkHref(e.target.value)}
              placeholder="https://…/{id}"
            />
          </div>

          <label className={labelCls}>Tile color</label>
          <input
            className={inputCls}
            value={tileBg}
            onChange={(e) => setTileBg(e.target.value)}
          />

          {error && (
            <InlineAlert className={mergeStylexOverrideClassName("", sx.mt3)}>
              {error}
            </InlineAlert>
          )}
          {busy && (
            <div {...stylex.props(sx.mt3, sx.textFaint, typography.label)}>
              {busy}
            </div>
          )}
        </div>
        <Modal.Footer>
          <div {...stylex.props(sx.flex1)} />
          <Modal.Close render={<Button variant="ghost">Cancel</Button>} />
          <Button
            variant="primary"
            className={mergeStylexOverrideClassName("", sx.px5)}
            onClick={save}
            disabled={!canSave || !!busy}
          >
            Create project
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
