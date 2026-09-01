// Lightweight language inference — no shiki import, so callers that only need
// to map a path/grep input to a language don't pull the (heavy) highlighter
// into the initial bundle. The shiki-backed renderer lives in
// components/CodeHighlight.tsx and is lazy-loaded.

const LANG_BY_EXT: Record<string, string> = {
  res: "rescript",
  resi: "rescript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  rust: "rust", // ripgrep --type name
  swift: "swift",
};

export { LANG_BY_EXT };

/** Map a file path to a registered shiki lang, or null if we can't highlight it. */
export function langForFile(filePath: unknown): string | null {
  if (typeof filePath !== "string") return null;
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANG_BY_EXT[ext] || null;
}

/** Infer a lang from Grep input: a file path, a "*.res"-style glob, or a ripgrep type. */
export function langForGrep(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  const fromPath = langForFile(inp.path);
  if (fromPath) return fromPath;
  // `glob` is the Claude-SDK key, `include` pi's — same "*.res" shape.
  const glob = typeof inp.glob === "string" ? inp.glob : inp.include;
  if (typeof glob === "string") {
    const ext = glob.match(/\.(\w+)$/)?.[1]?.toLowerCase();
    if (ext && LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  if (typeof inp.type === "string" && LANG_BY_EXT[inp.type])
    return LANG_BY_EXT[inp.type];
  return null;
}
