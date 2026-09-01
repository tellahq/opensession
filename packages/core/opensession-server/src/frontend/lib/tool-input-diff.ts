import {
  canonicalToolName,
  toolFilePath,
  toolInputString,
} from "@tellahq/opensession-protocol/tool-presentation";

export interface ToolInputDiff {
  patch: string;
  /** The language-bearing filename used by the diff highlighter. */
  path: string;
}

/**
 * Turn a code-writing tool's input into a real unified patch. The transcript
 * often carries only replacement snippets rather than a git diff, so the
 * hunk positions are synthetic and the inline renderer deliberately hides
 * line numbers. The changed lines and the file extension are still exact,
 * which lets the step use the same syntax + addition/deletion treatment as
 * Files changed instead of falling back to a JSON payload.
 */
export function toolInputDiff(
  toolName: string,
  input: unknown,
): ToolInputDiff | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const canonical = canonicalToolName(toolName);
  if (canonical !== "Edit" && canonical !== "Write") return null;

  const inp = input as Record<string, unknown>;
  const path = safeDiffPath(toolFilePath(inp) || "file.txt");

  if (canonical === "Write") {
    if (typeof inp.content !== "string") return null;
    return {
      path,
      patch: unifiedPatch(path, [{ oldText: "", newText: inp.content }], true),
    };
  }

  // Codex apply_patch input is already a readable diff-like document, but it
  // is not a unified patch @pierre/diffs can parse. Its existing Shiki fallback
  // remains the honest rendering rather than inventing file boundaries here.
  if (toolInputString(inp, "patchText", "patch")) return null;

  const values = Array.isArray(inp.edits) ? inp.edits : [inp];
  const edits: Replacement[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const edit = value as Record<string, unknown>;
    const oldText = toolInputString(edit, "old_string", "oldString", "oldText");
    const newText = toolInputString(edit, "new_string", "newString", "newText");
    if (!oldText && !newText) continue;
    edits.push({ oldText, newText });
  }
  if (edits.length === 0) return null;
  return { path, patch: unifiedPatch(path, edits, false) };
}

interface Replacement {
  oldText: string;
  newText: string;
}

function unifiedPatch(
  path: string,
  edits: Replacement[],
  newFile: boolean,
): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    newFile ? "new file mode 100644" : "",
    newFile ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ].filter(Boolean);

  let oldStart = newFile ? 0 : 1;
  let newStart = 1;
  for (const edit of edits) {
    const oldLines = textLines(edit.oldText);
    const newLines = textLines(edit.newText);
    lines.push(
      `@@ -${oldLines.length === 0 ? 0 : oldStart},${oldLines.length} +${newLines.length === 0 ? 0 : newStart},${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    );
    oldStart += Math.max(oldLines.length, 1);
    newStart += Math.max(newLines.length, 1);
  }
  return lines.join("\n");
}

/** Match the line-count contract used by toolLineStats, including a trailing
 * newline's final empty line. An empty string is zero lines. */
function textLines(text: string): string[] {
  return text ? text.split("\n") : [];
}

/** Patch headers are line-oriented. Keep an untrusted tool path on one line
 * while preserving its extension for syntax detection. */
function safeDiffPath(path: string): string {
  return path.replace(/[\r\n]/g, "").replace(/^\/+/, "") || "file.txt";
}
