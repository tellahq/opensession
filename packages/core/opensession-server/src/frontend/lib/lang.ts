// Lightweight language inference — no shiki import, so callers that only need
// to map a path/grep input to a language don't pull the (heavy) highlighter
// into the initial bundle. The shiki-backed renderer lives in
// components/CodeHighlight.tsx and is lazy-loaded.

import { z } from "zod";

const LANG_BY_EXT_VALUES = {
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
} satisfies Readonly<Record<string, string>>;

export const LANG_BY_EXT = Object.fromEntries(
  Object.entries(LANG_BY_EXT_VALUES),
);
const LANGUAGE_BY_EXTENSION = new Map(Object.entries(LANG_BY_EXT_VALUES));
const FILE_PATH_SCHEMA = z.string();
const EXTERNAL_VALUE_SCHEMA = z.unknown();
const OPTIONAL_STRING_SCHEMA = z.unknown().transform((value) => {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : undefined;
});
const GREP_LANGUAGE_INPUT_SCHEMA = z.object({
  path: OPTIONAL_STRING_SCHEMA,
  glob: OPTIONAL_STRING_SCHEMA,
  include: OPTIONAL_STRING_SCHEMA,
  type: OPTIONAL_STRING_SCHEMA,
});

/** Map a file path to a registered shiki lang, or null if we can't highlight it. */
export function langForFile(
  filePath: z.input<typeof FILE_PATH_SCHEMA>,
): string | null {
  const parsed = FILE_PATH_SCHEMA.safeParse(filePath);
  if (!parsed.success) return null;
  const ext = parsed.data.split(".").pop()?.toLowerCase() || "";
  return LANGUAGE_BY_EXTENSION.get(ext) ?? null;
}

/** Infer a lang from Grep input: a file path, a "*.res"-style glob, or a ripgrep type. */
export function langForGrep(
  input: z.input<typeof EXTERNAL_VALUE_SCHEMA>,
): string | null {
  const parsed = GREP_LANGUAGE_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) return null;
  const fromPath = parsed.data.path ? langForFile(parsed.data.path) : null;
  if (fromPath) return fromPath;
  // `glob` is the Claude-SDK key, `include` pi's — same "*.res" shape.
  const glob = parsed.data.glob ?? parsed.data.include;
  if (glob) {
    const ext = glob.match(/\.(\w+)$/)?.[1]?.toLowerCase();
    const language = ext ? LANGUAGE_BY_EXTENSION.get(ext) : undefined;
    if (language) return language;
  }
  return parsed.data.type
    ? (LANGUAGE_BY_EXTENSION.get(parsed.data.type) ?? null)
    : null;
}
