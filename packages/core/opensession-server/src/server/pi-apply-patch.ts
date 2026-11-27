import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Per-model edit tool selection and Codex-format `apply_patch` tool.
 *
 * OpenAI GPT-5+/6+/Codex and o-series models are heavily RL-trained on the
 * Codex `*** Begin Patch` / `*** Update File:` patch format and make fewer
 * multi-edit / whitespace mistakes with `apply_patch` than with JSON
 * `edit` + `write`. Anthropic, Gemini, Grok, and open-weight models keep the
 * standard `edit` + `write` tools.
 */

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const PATCH_NATIVE_MODEL_RE = /^(?:gpt-(?:[5-9]|\d{2,})|o[134](?:\b|-)|codex)/i;

export function usesApplyPatchTool(provider: string, modelID: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!OPENAI_PROVIDERS.has(normalizedProvider)) return false;
  return PATCH_NATIVE_MODEL_RE.test(modelID.trim());
}

/**
 * Concise, cache-stable per-model-family instructions appended to the static
 * system prompt. Identical for every session using the same model family so
 * prompt-prefix caching stays hot.
 */
export function modelPromptAdaptation(
  provider: string,
  modelID: string,
): string | undefined {
  if (usesApplyPatchTool(provider, modelID)) {
    return (
      "## Editing and scope\n" +
      "Use `apply_patch` for creating, editing, moving, and deleting files. Read files before " +
      "patching and include enough unchanged context (or `@@` headers) so each hunk matches " +
      "uniquely. Stay scoped to what was asked, avoid speculative abstractions, and verify " +
      "claims before reporting work done."
    );
  }
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === "anthropic" || /^claude-/i.test(modelID.trim())) {
    return (
      "## Editing and parallel calls\n" +
      "Read files before editing and batch independent read-only calls in parallel. Keep " +
      "edits targeted with `edit` rather than rewriting whole files with `write`."
    );
  }
  return undefined;
}

export interface PatchHunk {
  /** Optional narrowing headers from one or more consecutive `@@ ...` lines. */
  readonly headers: readonly string[];
  readonly lines: readonly PatchHunkLine[];
  readonly endOfFile: boolean;
}

export interface PatchHunkLine {
  readonly kind: "context" | "remove" | "add";
  readonly text: string;
}

export type PatchFileOp =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly lines: readonly string[];
    }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly hunks: readonly PatchHunk[];
    };

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const END_OF_FILE_MARKER = "*** End of File";

export function parseCodexPatch(patchText: string): PatchFileOp[] {
  const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  while (rawLines.length > 0 && rawLines[0]!.trim() === "") rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === "")
    rawLines.pop();

  if (rawLines.length === 0 || rawLines[0]!.trim() !== BEGIN_PATCH) {
    throw new Error(
      `apply_patch: patch must start with "${BEGIN_PATCH}" and end with "${END_PATCH}".`,
    );
  }
  const endIndex = rawLines.findIndex(
    (line, idx) => idx > 0 && line.trim() === END_PATCH,
  );
  if (endIndex === -1) {
    throw new Error(`apply_patch: missing closing "${END_PATCH}" line.`);
  }

  const ops: PatchFileOp[] = [];
  let i = 1;

  while (i < endIndex) {
    const line = rawLines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const path = line.slice(ADD_FILE_PREFIX.length).trim();
      if (!path)
        throw new Error(
          `apply_patch: empty path in "${ADD_FILE_PREFIX}" at line ${i + 1}.`,
        );
      i++;
      const contentLines: string[] = [];
      while (i < endIndex && !rawLines[i]!.startsWith("*** ")) {
        const l = rawLines[i]!;
        if (!l.startsWith("+")) {
          throw new Error(
            `apply_patch: Add File "${path}" line ${i + 1} must start with "+" (got ${JSON.stringify(l.slice(0, 40))}).`,
          );
        }
        contentLines.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path, lines: contentLines });
      continue;
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      const path = line.slice(DELETE_FILE_PREFIX.length).trim();
      if (!path) {
        throw new Error(
          `apply_patch: empty path in "${DELETE_FILE_PREFIX}" at line ${i + 1}.`,
        );
      }
      ops.push({ kind: "delete", path });
      i++;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const path = line.slice(UPDATE_FILE_PREFIX.length).trim();
      if (!path) {
        throw new Error(
          `apply_patch: empty path in "${UPDATE_FILE_PREFIX}" at line ${i + 1}.`,
        );
      }
      i++;
      let moveTo: string | undefined;
      if (i < endIndex && rawLines[i]!.startsWith(MOVE_TO_PREFIX)) {
        moveTo = rawLines[i]!.slice(MOVE_TO_PREFIX.length).trim();
        if (!moveTo) {
          throw new Error(
            `apply_patch: empty path in "${MOVE_TO_PREFIX}" at line ${i + 1}.`,
          );
        }
        i++;
      }

      const hunks: PatchHunk[] = [];
      while (i < endIndex) {
        const cur = rawLines[i]!;
        if (
          cur.startsWith(ADD_FILE_PREFIX) ||
          cur.startsWith(DELETE_FILE_PREFIX) ||
          cur.startsWith(UPDATE_FILE_PREFIX)
        ) {
          break;
        }
        const headers: string[] = [];
        while (
          i < endIndex &&
          (rawLines[i] === "@@" || rawLines[i]!.startsWith("@@ "))
        ) {
          const header = rawLines[i]!.slice(2).trim();
          if (header) headers.push(header);
          i++;
        }

        const hunkLines: PatchHunkLine[] = [];
        let endOfFile = false;
        while (i < endIndex) {
          const hline = rawLines[i]!;
          if (hline === END_OF_FILE_MARKER) {
            endOfFile = true;
            i++;
            break;
          }
          if (
            hline === "@@" ||
            hline.startsWith("@@ ") ||
            hline.startsWith(ADD_FILE_PREFIX) ||
            hline.startsWith(DELETE_FILE_PREFIX) ||
            hline.startsWith(UPDATE_FILE_PREFIX)
          ) {
            break;
          }
          if (hline.startsWith(" ")) {
            hunkLines.push({ kind: "context", text: hline.slice(1) });
          } else if (hline.startsWith("-")) {
            hunkLines.push({ kind: "remove", text: hline.slice(1) });
          } else if (hline.startsWith("+")) {
            hunkLines.push({ kind: "add", text: hline.slice(1) });
          } else if (hline === "") {
            // Models occasionally omit the leading space on blank context lines.
            hunkLines.push({ kind: "context", text: "" });
          } else {
            throw new Error(
              `apply_patch: invalid hunk line in "${path}" at line ${i + 1}: expected " ", "-", or "+" prefix.`,
            );
          }
          i++;
        }

        if (hunkLines.length > 0) {
          hunks.push({ headers, lines: hunkLines, endOfFile });
        } else if (headers.length > 0) {
          throw new Error(
            `apply_patch: empty hunk after "@@" in "${path}" near line ${i + 1}.`,
          );
        } else {
          break;
        }
      }

      if (hunks.length === 0 && !moveTo) {
        throw new Error(
          `apply_patch: Update File "${path}" has no hunks and no Move to target.`,
        );
      }
      ops.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    throw new Error(
      `apply_patch: unexpected line ${i + 1}: ${JSON.stringify(line.slice(0, 60))}. Expected "*** Add File:", "*** Update File:", or "*** Delete File:".`,
    );
  }

  if (ops.length === 0) {
    throw new Error(
      `apply_patch: no file operations found between "${BEGIN_PATCH}" and "${END_PATCH}".`,
    );
  }

  return ops;
}

function normalizePunctuation(line: string): string {
  return line
    .trimEnd()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00A0/g, " ");
}

function findSequenceMatches(
  haystack: readonly string[],
  needle: readonly string[],
  startAt: number,
  endOfFile: boolean,
  compare: (a: string, b: string) => boolean,
): number[] {
  if (needle.length === 0) return [endOfFile ? haystack.length : startAt];
  if (needle.length > haystack.length) return [];

  if (endOfFile) {
    const eofPos = haystack.length - needle.length;
    if (eofPos >= startAt) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (!compare(haystack[eofPos + j]!, needle[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return [eofPos];
    }
  }

  const matches: number[] = [];
  const last = haystack.length - needle.length;
  for (let i = startAt; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!compare(haystack[i + j]!, needle[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

function findHeaderAnchor(
  lines: readonly string[],
  headers: readonly string[],
  startAt: number,
): number {
  let cursor = startAt;
  for (const header of headers) {
    const trimmedHeader = header.trim();
    if (!trimmedHeader) continue;
    let found = -1;
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i]!.trim() === trimmedHeader) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      for (let i = cursor; i < lines.length; i++) {
        if (lines[i]!.includes(trimmedHeader)) {
          found = i;
          break;
        }
      }
    }
    if (found === -1) return -1;
    cursor = found + 1;
  }
  return cursor;
}

export function applyHunksToContent(
  original: string,
  hunks: readonly PatchHunk[],
  filePath: string,
): {
  readonly content: string;
  readonly additions: number;
  readonly deletions: number;
} {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = original.endsWith("\n");
  const normalized = original.replace(/\r\n/g, "\n");
  let lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (
    hadTrailingNewline &&
    lines.length > 0 &&
    lines[lines.length - 1] === ""
  ) {
    lines.pop();
  }

  let cursor = 0;
  let additions = 0;
  let deletions = 0;

  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx]!;
    const oldLines = hunk.lines
      .filter((l) => l.kind === "context" || l.kind === "remove")
      .map((l) => l.text);
    const newLines = hunk.lines
      .filter((l) => l.kind === "context" || l.kind === "add")
      .map((l) => l.text);

    for (const l of hunk.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "remove") deletions++;
    }

    let searchStart = cursor;
    if (hunk.headers.length > 0) {
      const anchored = findHeaderAnchor(lines, hunk.headers, cursor);
      if (anchored === -1) {
        const retryFromTop = findHeaderAnchor(lines, hunk.headers, 0);
        if (retryFromTop === -1) {
          throw new Error(
            `apply_patch: hunk ${hunkIdx + 1} in "${filePath}" could not find "@@ ${hunk.headers.join(" / ")}" header.`,
          );
        }
        searchStart = retryFromTop;
      } else {
        searchStart = anchored;
      }
    }

    const matchers: Array<(a: string, b: string) => boolean> = [
      (a, b) => a === b,
      (a, b) => a.trimEnd() === b.trimEnd(),
      (a, b) => normalizePunctuation(a) === normalizePunctuation(b),
    ];

    let matches: number[] = [];
    for (const compare of matchers) {
      matches = findSequenceMatches(
        lines,
        oldLines,
        searchStart,
        hunk.endOfFile,
        compare,
      );
      if (
        matches.length === 0 &&
        searchStart > 0 &&
        hunk.headers.length === 0
      ) {
        matches = findSequenceMatches(
          lines,
          oldLines,
          0,
          hunk.endOfFile,
          compare,
        );
      }
      if (matches.length > 0) break;
    }

    if (matches.length === 0) {
      const preview = oldLines.slice(0, 3).join("\n");
      throw new Error(
        `apply_patch: hunk ${hunkIdx + 1} in "${filePath}" failed to match file contents. Re-read "${filePath}" and provide exact context lines.\nExpected near:\n${preview}`,
      );
    }

    if (matches.length > 1) {
      const lineNumbers = matches
        .slice(0, 5)
        .map((m) => m + 1)
        .join(", ");
      throw new Error(
        `apply_patch: hunk ${hunkIdx + 1} in "${filePath}" matched ${matches.length} locations (lines ${lineNumbers}). Add more surrounding context lines or a unique "@@" header.`,
      );
    }

    const pos = matches[0]!;
    lines = [
      ...lines.slice(0, pos),
      ...newLines,
      ...lines.slice(pos + oldLines.length),
    ];
    cursor = pos + newLines.length;
  }

  const joined = lines.join(eol);
  const content =
    lines.length === 0
      ? ""
      : hadTrailingNewline || original.length === 0
        ? joined + eol
        : joined;

  return { content, additions, deletions };
}

export interface ApplyPatchOperations {
  readonly readFile: (absPath: string) => Promise<Buffer>;
  readonly writeFile: (absPath: string, content: string) => Promise<void>;
  readonly mkdir: (absDir: string) => Promise<void>;
  readonly deleteFile: (absPath: string) => Promise<void>;
}

const APPLY_PATCH_DESCRIPTION = `Apply a patch to one or more files using the Codex patch format.

Read files before patching. Wrap the patch in a single \`*** Begin Patch\` / \`*** End Patch\` pair.

Supported file operations:
- \`*** Add File: <path>\` — create a new file; every content line must start with \`+\`.
- \`*** Delete File: <path>\` — remove an existing file.
- \`*** Update File: <path>\` — patch an existing file (optionally followed by \`*** Move to: <newPath>\`) using one or more \`@@ [header]\` hunks whose lines start with \` \` (context), \`-\` (remove), or \`+\` (add), and optional \`*** End of File\`.

Include at least 3 lines of unchanged context above and below each change (more, or a unique \`@@\` header, if a block repeats).`;

export function makePiApplyPatchTool(input: {
  readonly cwd: string;
  readonly operations: ApplyPatchOperations;
}): ToolDefinition<any, any, any> {
  const resolvePath = (p: string) =>
    isAbsolute(p) ? p : resolve(input.cwd, p);

  return {
    name: "apply_patch",
    label: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        patchText: {
          type: "string",
          description:
            "Codex-format patch starting with '*** Begin Patch' and ending with '*** End Patch'.",
        },
      },
      required: ["patchText"],
    } as any,
    async execute(_toolCallId, params) {
      const patchText = String(
        (params as { patchText?: unknown })?.patchText ?? "",
      );
      if (!patchText.trim()) {
        throw new Error("apply_patch: patchText must be non-empty.");
      }

      const ops = parseCodexPatch(patchText);
      const applied: string[] = [];
      let totalAdd = 0;
      let totalDel = 0;

      for (const op of ops) {
        try {
          if (op.kind === "add") {
            const abs = resolvePath(op.path);
            await input.operations.mkdir(dirname(abs));
            const content =
              op.lines.length > 0 ? `${op.lines.join("\n")}\n` : "";
            await input.operations.writeFile(abs, content);
            totalAdd += op.lines.length;
            applied.push(`A ${op.path} (+${op.lines.length})`);
            continue;
          }

          if (op.kind === "delete") {
            const abs = resolvePath(op.path);
            await input.operations.deleteFile(abs);
            applied.push(`D ${op.path}`);
            continue;
          }

          const absSrc = resolvePath(op.path);
          const buf = await input.operations.readFile(absSrc);
          const original = buf.toString("utf-8");
          const result =
            op.hunks.length > 0
              ? applyHunksToContent(original, op.hunks, op.path)
              : { content: original, additions: 0, deletions: 0 };

          if (op.moveTo && op.moveTo !== op.path) {
            const absDst = resolvePath(op.moveTo);
            await input.operations.mkdir(dirname(absDst));
            await input.operations.writeFile(absDst, result.content);
            await input.operations.deleteFile(absSrc);
            applied.push(
              `R ${op.path} -> ${op.moveTo} (+${result.additions}/-${result.deletions})`,
            );
          } else {
            await input.operations.writeFile(absSrc, result.content);
            applied.push(
              `M ${op.path} (+${result.additions}/-${result.deletions})`,
            );
          }
          totalAdd += result.additions;
          totalDel += result.deletions;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (applied.length > 0) {
            throw new Error(
              `apply_patch partially applied ${applied.length} operation(s) (${applied.join(", ")}), then failed:\n${msg}`,
            );
          }
          throw err;
        }
      }

      const summary = [
        `Applied patch (${applied.length} file${applied.length === 1 ? "" : "s"}, +${totalAdd}/-${totalDel}):`,
        ...applied.map((line) => `  ${line}`),
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { applied, additions: totalAdd, deletions: totalDel },
      };
    },
  };
}
