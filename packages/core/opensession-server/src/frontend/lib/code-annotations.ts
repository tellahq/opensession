/**
 * Code block margin annotations (`.annotate`).
 *
 * Supports inline margin notes on fenced code lines via trailing comment
 * directives:
 *   - `// @note: <note text>`
 *   - `# @note: <note text>`
 *   - `/* @note: <note text> *\/`
 *
 * Works cleanly on both plain `<pre><code>` blocks and Shiki-highlighted
 * `<span class="line">` blocks without duplicating annotations across passes.
 */

const ANNOTATED_ATTR = "data-annotated";

const LINE_NOTE_RE =
  /(?:\s*(?:\/\/|#|--)\s*@note:\s*(.+?)\s*$|\s*\/\*\s*@note:\s*(.+?)\s*\*\/\s*$)/;

export interface ParsedAnnotatedLine {
  readonly code: string;
  readonly note: string | null;
}

export function extractLineAnnotation(line: string): ParsedAnnotatedLine {
  const m = LINE_NOTE_RE.exec(line);
  if (!m) return { code: line, note: null };
  const note = (m[1] ?? m[2] ?? "").trim();
  if (!note) return { code: line, note: null };
  return {
    code: line.slice(0, m.index).replace(/[ \t]+$/, ""),
    note,
  };
}

function stripAnnotationFromLineElement(lineEl: HTMLElement): string | null {
  const raw = lineEl.textContent ?? "";
  const parsed = extractLineAnnotation(raw);
  if (!parsed.note) return null;

  // Walk text nodes from the end and trim off the trailing `@note:` comment
  // tokens while keeping preceding syntax-highlighted spans intact.
  const toRemove = raw.length - parsed.code.length;
  if (toRemove <= 0) return parsed.note;

  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) textNodes.push(node);
    node = walker.nextNode();
  }

  let remaining = toRemove;
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i--) {
    const t = textNodes[i]!;
    const len = t.data.length;
    if (len <= remaining) {
      t.data = "";
      remaining -= len;
    } else {
      t.data = t.data.slice(0, len - remaining);
      remaining = 0;
    }
  }
  return parsed.note;
}

export function decorateCodeAnnotations(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.hasAttribute(ANNOTATED_ATTR)) continue;
    const text = pre.textContent ?? "";
    if (!text.includes("@note:")) continue;

    const shikiLines = Array.from(
      pre.querySelectorAll<HTMLElement>("code > span.line"),
    );
    let foundAny = false;

    if (shikiLines.length > 0) {
      for (const lineEl of shikiLines) {
        const note = stripAnnotationFromLineElement(lineEl);
        if (!note) continue;
        foundAny = true;
        lineEl.classList.add("md-code-annotated-line");
        const aside = document.createElement("span");
        aside.className = "md-code-margin-note";
        aside.textContent = note;
        lineEl.append(aside);
      }
    } else {
      const codeEl = pre.querySelector("code");
      if (!codeEl) continue;
      const lines = (codeEl.textContent ?? "").split("\n");
      const parsed = lines.map(extractLineAnnotation);
      if (!parsed.some((p) => p.note !== null)) continue;
      foundAny = true;
      codeEl.textContent = "";
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]!;
        const span = document.createElement("span");
        span.className = p.note ? "line md-code-annotated-line" : "line";
        span.append(document.createTextNode(p.code));
        if (p.note) {
          const aside = document.createElement("span");
          aside.className = "md-code-margin-note";
          aside.textContent = p.note;
          span.append(aside);
        }
        codeEl.append(span);
        if (i < parsed.length - 1) codeEl.append(document.createTextNode("\n"));
      }
    }

    if (foundAny) {
      pre.setAttribute(ANNOTATED_ATTR, "true");
      pre.classList.add("md-code-annotated");
    }
  }
}
