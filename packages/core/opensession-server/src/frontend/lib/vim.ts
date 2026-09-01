// A small modal-editing engine for the composer textarea ("vim mode",
// Settings → Preferences, default off). Pure: it never touches the DOM — the
// useVimMode hook feeds it keydowns plus the current { text, selection } and
// applies the returned document/selection/mode. That keeps the whole thing
// unit-testable and keeps the textarea React-controlled (edits flow through
// onChange, never el.value).
//
// Scope: the useful session-composer subset, not full vim. Modes insert (the
// default — a composer opens ready to type), normal, visual and visual-line.
// Counts; motions h l j k w b e 0 ^ $ gg G f F t T; operators d c y (+ dd/cc/
// yy and linewise j/k/gg/G targets); x X D C s S r p P; u / Ctrl+r on an
// internal snapshot stack (programmatic edits break the native undo history);
// unbound printable keys in normal mode are consumed no-ops so stray typing
// can't leak into the draft. Enter is deliberately left unhandled everywhere
// so the composer's send logic keeps working in any mode.

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

export interface VimKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The textarea document as the engine sees it: text + selection range.
 *  start === end is a caret; in visual modes they span the selection. */
export interface VimDoc {
  text: string;
  start: number;
  end: number;
}

/** A consumed key: the (possibly unchanged) document to apply. */
export interface VimResult {
  text: string;
  start: number;
  end: number;
  mode: VimMode;
}

interface Snapshot {
  text: string;
  caret: number;
}

type Operator = "d" | "c" | "y";

// ── text helpers ────────────────────────────────────────────────────────────

function lineStartAt(t: string, i: number): number {
  return t.lastIndexOf("\n", Math.max(0, i - 1)) + 1;
}

function lineEndAt(t: string, i: number): number {
  const nl = t.indexOf("\n", i);
  return nl === -1 ? t.length : nl;
}

function firstNonBlankAt(t: string, i: number): number {
  const ls = lineStartAt(t, i);
  const le = lineEndAt(t, i);
  let j = ls;
  while (j < le && (t[j] === " " || t[j] === "\t")) j++;
  return j;
}

/** 0 = whitespace, 1 = word chars, 2 = other punctuation (vim's three
 *  character classes — a word motion stops where the class changes). */
function charClass(c: string): 0 | 1 | 2 {
  if (/\s/.test(c)) return 0;
  return /[A-Za-z0-9_]/.test(c) ? 1 : 2;
}

function nextWordStart(t: string, i: number): number {
  const n = t.length;
  let j = i;
  if (j < n && charClass(t[j]!) !== 0) {
    const cls = charClass(t[j]!);
    while (j < n && charClass(t[j]!) === cls) j++;
  }
  while (j < n && charClass(t[j]!) === 0) j++;
  return j;
}

function prevWordStart(t: string, i: number): number {
  let j = i;
  while (j > 0 && charClass(t[j - 1]!) === 0) j--;
  if (j === 0) return 0;
  const cls = charClass(t[j - 1]!);
  while (j > 0 && charClass(t[j - 1]!) === cls) j--;
  return j;
}

/** Boundary just past the end of the next word (so `e` as an operator target
 *  takes the whole word — the engine treats every position as an insertion
 *  point rather than an on-a-character cursor). */
function wordEndBoundary(t: string, i: number): number {
  const n = t.length;
  let j = Math.min(i + 1, n);
  while (j < n && charClass(t[j]!) === 0) j++;
  if (j >= n) return n;
  const cls = charClass(t[j]!);
  while (j < n && charClass(t[j]!) === cls) j++;
  return j;
}

/**
 * Plain up/down caret movement (no sticky column) — used by the phone key bar
 * to emulate arrow keys in insert mode, where the engine doesn't consume them.
 * Returns the clamped target position; at a buffer edge it stays put.
 */
export function verticalCaretTarget(
  t: string,
  pos: number,
  delta: 1 | -1,
): number {
  const ls = lineStartAt(t, pos);
  const col = pos - ls;
  if (delta > 0) {
    const le = lineEndAt(t, pos);
    if (le >= t.length) return pos;
    const nls = le + 1;
    return Math.min(nls + col, lineEndAt(t, nls));
  }
  if (ls === 0) return pos;
  const pls = lineStartAt(t, ls - 1);
  return Math.min(pls + col, ls - 1);
}

// ── engine ──────────────────────────────────────────────────────────────────

const UNDO_CAP = 100;

export class VimEngine {
  mode: VimMode = "insert";

  private countBuf = "";
  private op: Operator | null = null;
  private pendingFind: "f" | "F" | "t" | "T" | null = null;
  private pendingG = false;
  private pendingR = false;
  /** Visual-mode selection anchor (the end that motions don't move). */
  private anchor = 0;
  /** Sticky column for j/k runs through short lines. */
  private desiredCol: number | null = null;
  private register = "";
  private regLinewise = false;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  /**
   * Feed one keydown. Returns the document/selection/mode to apply when the
   * key was consumed, or null to let the key fall through to the textarea and
   * the composer's own handling (send combos, busy-Esc-stops, arrows, ⌘-shortcuts).
   */
  handleKey(e: VimKeyEvent, doc: VimDoc): VimResult | null {
    // A modifier keydown itself (Shift on the way to "$", say) must not
    // disturb pending state — ignore it entirely.
    if (
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta" ||
      e.key === "CapsLock"
    )
      return null;
    // Never fight OS/browser shortcuts; the only bound modifier combo is ⌃r.
    if (e.metaKey || e.altKey) return null;
    if (e.ctrlKey && !(this.mode !== "insert" && e.key === "r")) return null;

    if (this.mode === "insert") return this.handleInsert(e, doc);
    if (this.mode === "normal") return this.handleNormal(e, doc);
    return this.handleVisual(e, doc);
  }

  // ── insert ────────────────────────────────────────────────────────────

  private handleInsert(e: VimKeyEvent, doc: VimDoc): VimResult | null {
    if (e.key !== "Escape") return null; // everything else types normally
    this.mode = "normal";
    // Like vim, leaving insert steps the caret back one (not past the line start).
    const ls = lineStartAt(doc.text, doc.start);
    const pos = doc.start > ls ? doc.start - 1 : doc.start;
    return this.result(doc.text, pos);
  }

  // ── normal ────────────────────────────────────────────────────────────

  private handleNormal(e: VimKeyEvent, doc: VimDoc): VimResult | null {
    const t = doc.text;
    const caret = doc.start;
    const k = e.key;

    // Escape cancels any half-typed command; a bare Escape falls through so
    // the composer's Esc-stops-the-run behavior still works in normal mode.
    if (k === "Escape") {
      const hadPending =
        this.countBuf !== "" ||
        this.op !== null ||
        this.pendingFind !== null ||
        this.pendingG ||
        this.pendingR;
      this.clearPending();
      return hadPending ? this.result(t, caret) : null;
    }

    if (this.pendingR) {
      this.pendingR = false;
      if (k.length !== 1) return this.result(t, caret);
      const le = lineEndAt(t, caret);
      if (caret >= le) return this.result(t, caret);
      this.pushUndo(doc);
      return this.result(t.slice(0, caret) + k + t.slice(caret + 1), caret);
    }

    if (this.pendingFind) {
      const kind = this.pendingFind;
      this.pendingFind = null;
      if (k.length !== 1) return this.result(t, caret);
      const target = this.findInLine(t, caret, kind, k);
      if (target === null) {
        this.clearPending();
        return this.result(t, caret);
      }
      // Forward finds are inclusive targets for operators (df; takes the ";").
      const opEnd = kind === "f" ? target + 1 : target;
      if (this.op) return this.applyOperator(doc, caret, opEnd, false);
      this.clearPending();
      return this.result(t, target);
    }

    if (k.length === 1 && k >= "1" && k <= "9") {
      this.countBuf += k;
      return this.result(t, caret);
    }
    if (k === "0" && this.countBuf !== "") {
      this.countBuf += k;
      return this.result(t, caret);
    }

    if (e.ctrlKey && k === "r") {
      return this.popHistory(doc, this.redoStack, this.undoStack);
    }

    if (k === "g") {
      if (this.pendingG) {
        this.pendingG = false;
        return this.motionTo(doc, 0, true);
      }
      this.pendingG = true;
      return this.result(t, caret);
    }
    if (this.pendingG) {
      // Any non-g key abandons the pending g.
      this.pendingG = false;
      this.clearPending();
      return k.length === 1 ? this.result(t, caret) : null;
    }

    const count = this.count();

    switch (k) {
      // Motions (shared with visual mode via motionTo).
      case "h":
        return this.motionTo(
          doc,
          Math.max(lineStartAt(t, caret), caret - count),
          false,
        );
      case "l":
        return this.motionTo(
          doc,
          Math.min(lineEndAt(t, caret), caret + count),
          false,
        );
      case "j":
      case "k":
        return this.motionVert(doc, k === "j" ? count : -count);
      case "w":
        // Vim special case: cw doesn't take the trailing whitespace — it
        // behaves like ce.
        if (this.op === "c")
          return this.motionTo(
            doc,
            this.repeat(t, caret, count, wordEndBoundary),
            false,
          );
        return this.motionTo(
          doc,
          this.repeat(t, caret, count, nextWordStart),
          false,
        );
      case "b":
        return this.motionTo(
          doc,
          this.repeat(t, caret, count, prevWordStart),
          false,
        );
      case "e":
        return this.motionTo(
          doc,
          this.repeat(t, caret, count, wordEndBoundary),
          false,
        );
      case "0":
        return this.motionTo(doc, lineStartAt(t, caret), false);
      case "^":
        return this.motionTo(doc, firstNonBlankAt(t, caret), false);
      case "$":
        return this.motionTo(doc, lineEndAt(t, caret), false);
      case "G":
        return this.motionTo(doc, t.length, true);
      case "f":
      case "F":
      case "t":
      case "T":
        this.pendingFind = k;
        return this.result(t, caret);
      case "Backspace":
        return this.motionTo(doc, Math.max(0, caret - count), false);

      // Operators.
      case "d":
      case "c":
      case "y": {
        if (this.op === k) return this.lineOperation(doc, k, count);
        if (this.op) {
          this.clearPending();
          return this.result(t, caret);
        }
        this.op = k as Operator;
        return this.result(t, caret);
      }
    }

    // A pending operator followed by a key that isn't a motion: abandon it.
    if (this.op) {
      this.clearPending();
      return k.length === 1 ? this.result(t, caret) : null;
    }

    switch (k) {
      case "i":
        return this.enterInsert(doc, caret);
      case "I":
        return this.enterInsert(doc, firstNonBlankAt(t, caret));
      case "a":
        return this.enterInsert(doc, Math.min(lineEndAt(t, caret), caret + 1));
      case "A":
        return this.enterInsert(doc, lineEndAt(t, caret));
      case "o": {
        this.pushUndo(doc);
        const le = lineEndAt(t, caret);
        this.mode = "insert";
        this.clearPending();
        return {
          text: t.slice(0, le) + "\n" + t.slice(le),
          start: le + 1,
          end: le + 1,
          mode: "insert",
        };
      }
      case "O": {
        this.pushUndo(doc);
        const ls = lineStartAt(t, caret);
        this.mode = "insert";
        this.clearPending();
        return {
          text: t.slice(0, ls) + "\n" + t.slice(ls),
          start: ls,
          end: ls,
          mode: "insert",
        };
      }
      case "x": {
        const le = lineEndAt(t, caret);
        if (caret >= le) return this.result(t, caret);
        const end = Math.min(le, caret + count);
        this.pushUndo(doc);
        this.setRegister(t.slice(caret, end), false);
        return this.result(t.slice(0, caret) + t.slice(end), caret);
      }
      case "X": {
        const ls = lineStartAt(t, caret);
        if (caret <= ls) return this.result(t, caret);
        const from = Math.max(ls, caret - count);
        this.pushUndo(doc);
        this.setRegister(t.slice(from, caret), false);
        return this.result(t.slice(0, from) + t.slice(caret), from);
      }
      case "D":
        return this.applyOperatorAs(doc, "d", caret, lineEndAt(t, caret));
      case "C":
        return this.applyOperatorAs(doc, "c", caret, lineEndAt(t, caret));
      case "s": {
        const le = lineEndAt(t, caret);
        return this.applyOperatorAs(
          doc,
          "c",
          caret,
          Math.min(le, caret + count),
        );
      }
      case "S":
        return this.lineOperation(doc, "c", count);
      case "r":
        this.pendingR = true;
        return this.result(t, caret);
      case "p":
      case "P":
        return this.paste(doc, k === "p", count);
      case "u":
        return this.popHistory(doc, this.undoStack, this.redoStack);
      case "v":
        this.mode = "visual";
        this.anchor = caret;
        this.clearPending();
        return { text: t, start: caret, end: caret, mode: "visual" };
      case "V": {
        this.mode = "visual-line";
        this.anchor = caret;
        this.clearPending();
        return {
          text: t,
          start: lineStartAt(t, caret),
          end: lineEndAt(t, caret),
          mode: "visual-line",
        };
      }
    }

    // Unbound printable key in normal mode: consume it so it can't type into
    // the draft. Anything else (Enter, Tab, arrows, F-keys…) falls through.
    return k.length === 1 ? this.result(t, caret) : null;
  }

  // ── visual / visual-line ──────────────────────────────────────────────

  private handleVisual(e: VimKeyEvent, doc: VimDoc): VimResult | null {
    const t = doc.text;
    const k = e.key;
    const line = this.mode === "visual-line";
    // The moving end of the selection; the anchor stays put.
    const head = doc.start < this.anchor ? doc.start : doc.end;

    if (k === "Escape") {
      this.toNormal();
      return this.result(t, head);
    }

    if (this.pendingFind) {
      const kind = this.pendingFind;
      this.pendingFind = null;
      if (k.length !== 1) return this.visualSelect(doc, head);
      const target = this.findInLine(t, head, kind, k);
      return this.visualSelect(doc, target ?? head);
    }

    if (k.length === 1 && k >= "1" && k <= "9") {
      this.countBuf += k;
      return this.visualSelect(doc, head);
    }
    if (k === "0" && this.countBuf !== "") {
      this.countBuf += k;
      return this.visualSelect(doc, head);
    }

    if (k === "g") {
      if (this.pendingG) {
        this.pendingG = false;
        return this.visualSelect(doc, 0);
      }
      this.pendingG = true;
      return this.visualSelect(doc, head);
    }
    if (this.pendingG) this.pendingG = false;

    const count = this.count();
    this.countBuf = "";

    switch (k) {
      case "h":
        return this.visualSelect(doc, Math.max(0, head - count));
      case "l":
        return this.visualSelect(doc, Math.min(t.length, head + count));
      case "j":
      case "k": {
        const target = this.vertTarget(t, head, k === "j" ? count : -count);
        return this.visualSelect(doc, target ?? head);
      }
      case "w":
        return this.visualSelect(
          doc,
          this.repeat(t, head, count, nextWordStart),
        );
      case "b":
        return this.visualSelect(
          doc,
          this.repeat(t, head, count, prevWordStart),
        );
      case "e":
        return this.visualSelect(
          doc,
          this.repeat(t, head, count, wordEndBoundary),
        );
      case "0":
        return this.visualSelect(doc, lineStartAt(t, head));
      case "^":
        return this.visualSelect(doc, firstNonBlankAt(t, head));
      case "$":
        return this.visualSelect(doc, lineEndAt(t, head));
      case "G":
        return this.visualSelect(doc, t.length);
      case "f":
      case "F":
      case "t":
      case "T":
        this.pendingFind = k;
        return this.visualSelect(doc, head);
      case "o":
        this.anchor = head;
        return this.visualSelect(
          doc,
          this.anchor === doc.start ? doc.end : doc.start,
        );
      case "v":
        if (line) {
          this.mode = "visual";
          return this.visualSelect(doc, head);
        }
        this.toNormal();
        return this.result(t, head);
      case "V":
        if (!line) {
          this.mode = "visual-line";
          return this.visualSelect(doc, head);
        }
        this.toNormal();
        return this.result(t, head);
      case "d":
      case "x":
      case "c":
      case "s": {
        const [from, to] = this.visualRange(doc);
        this.toNormal();
        return this.applyOperatorAs(
          { ...doc, start: from, end: from },
          k === "d" || k === "x" ? "d" : "c",
          from,
          to,
          line,
        );
      }
      case "y": {
        const [from, to] = this.visualRange(doc);
        this.toNormal();
        return this.applyOperatorAs(
          { ...doc, start: from, end: from },
          "y",
          from,
          to,
          line,
        );
      }
      case "p": {
        const [from, to] = this.visualRange(doc);
        this.pushUndo({ ...doc, start: from, end: from });
        const reg = this.regLinewise
          ? this.register.replace(/\n$/, "")
          : this.register;
        const next = t.slice(0, from) + reg + t.slice(to);
        this.toNormal();
        return this.result(next, from + reg.length);
      }
    }

    // Swallow stray printable keys so they can't type over the selection.
    return k.length === 1 ? this.visualSelect(doc, head) : null;
  }

  // ── shared helpers ────────────────────────────────────────────────────

  private count(): number {
    const n = parseInt(this.countBuf || "1", 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  private clearPending() {
    this.countBuf = "";
    this.op = null;
    this.pendingFind = null;
    this.pendingG = false;
    this.pendingR = false;
  }

  private toNormal() {
    this.mode = "normal";
    this.clearPending();
  }

  /** Normal-mode consumed-key result at a caret (no selection). */
  private result(text: string, caret: number): VimResult {
    const pos = Math.max(0, Math.min(text.length, caret));
    return { text, start: pos, end: pos, mode: this.mode };
  }

  private repeat(
    t: string,
    pos: number,
    count: number,
    fn: (t: string, i: number) => number,
  ): number {
    let p = pos;
    for (let i = 0; i < count; i++) p = fn(t, p);
    return p;
  }

  /** Complete a motion in normal mode: either move the caret or, with a
   *  pending operator, apply it over the range. */
  private motionTo(doc: VimDoc, target: number, linewise: boolean): VimResult {
    this.desiredCol = null;
    if (this.op) return this.applyOperator(doc, doc.start, target, linewise);
    this.countBuf = "";
    return this.result(doc.text, target);
  }

  /** j/k target with a sticky column, or null at the buffer edge. */
  private vertTarget(t: string, pos: number, delta: number): number | null {
    const ls = lineStartAt(t, pos);
    const col = this.desiredCol ?? pos - ls;
    this.desiredCol = col;
    let targetLs = ls;
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        const le = lineEndAt(t, targetLs);
        if (le >= t.length)
          return i === 0 ? null : Math.min(targetLs + col, le);
        targetLs = le + 1;
      }
    } else {
      for (let i = 0; i < -delta; i++) {
        if (targetLs === 0)
          return i === 0
            ? null
            : Math.min(targetLs + col, lineEndAt(t, targetLs));
        targetLs = lineStartAt(t, targetLs - 1);
      }
    }
    return Math.min(targetLs + col, lineEndAt(t, targetLs));
  }

  private motionVert(doc: VimDoc, delta: number): VimResult {
    if (this.op) {
      // Linewise operation over the current line through the target line.
      const target = this.vertTarget(doc.text, doc.start, delta);
      if (target === null) {
        this.clearPending();
        return this.result(doc.text, doc.start);
      }
      return this.applyOperator(doc, doc.start, target, true);
    }
    const target = this.vertTarget(doc.text, doc.start, delta);
    this.countBuf = "";
    return this.result(doc.text, target ?? doc.start);
  }

  private findInLine(
    t: string,
    pos: number,
    kind: "f" | "F" | "t" | "T",
    ch: string,
  ): number | null {
    const ls = lineStartAt(t, pos);
    const le = lineEndAt(t, pos);
    if (kind === "f" || kind === "t") {
      const idx = t.indexOf(ch, pos + 1);
      if (idx === -1 || idx >= le) return null;
      return kind === "f" ? idx : idx - 1;
    }
    const idx = t.lastIndexOf(ch, pos - 1);
    if (idx < ls) return null;
    return kind === "F" ? idx : idx + 1;
  }

  /** Apply the pending operator over [from,target] (order-agnostic). */
  private applyOperator(
    doc: VimDoc,
    from: number,
    target: number,
    linewise: boolean,
  ): VimResult {
    const op = this.op!;
    this.clearPending();
    let lo = Math.min(from, target);
    let hi = Math.max(from, target);
    if (!linewise) return this.applyOperatorAs(doc, op, lo, hi, false);
    lo = lineStartAt(doc.text, lo);
    hi = lineEndAt(doc.text, hi);
    // c/y keep the line structure (cc-style); only d removes the line slot,
    // absorbing one bounding newline so no blank line is left behind.
    if (op !== "d") return this.applyOperatorAs(doc, op, lo, hi, true);
    this.setRegister(doc.text.slice(lo, hi), true);
    let dLo = lo;
    let dHi = hi;
    if (dHi < doc.text.length) dHi++;
    else if (dLo > 0) dLo--;
    this.pushUndo(doc);
    const next = doc.text.slice(0, dLo) + doc.text.slice(dHi);
    return this.result(next, Math.min(lo, next.length));
  }

  private applyOperatorAs(
    doc: VimDoc,
    op: Operator,
    lo: number,
    hi: number,
    linewise = false,
  ): VimResult {
    const t = doc.text;
    this.clearPending();
    this.setRegister(t.slice(lo, hi), linewise);
    if (op === "y") return this.result(t, lo);
    this.pushUndo(doc);
    const next = t.slice(0, lo) + t.slice(hi);
    if (op === "c") {
      this.mode = "insert";
      return { text: next, start: lo, end: lo, mode: "insert" };
    }
    return this.result(next, lo);
  }

  /** dd / cc / yy (and S): operate on `count` whole lines. */
  private lineOperation(doc: VimDoc, op: Operator, count: number): VimResult {
    const t = doc.text;
    const lo = lineStartAt(t, doc.start);
    let hi = lo;
    for (let i = 0; i < count; i++) {
      hi = lineEndAt(t, hi);
      if (i < count - 1 && hi < t.length) hi++;
    }
    this.clearPending();
    this.setRegister(t.slice(lo, hi), true);
    this.pushUndo(doc);
    if (op === "y") return this.result(t, lo);
    if (op === "c") {
      // cc keeps the line, cleared, and inserts on it.
      const next = t.slice(0, lo) + t.slice(hi);
      this.mode = "insert";
      return { text: next, start: lo, end: lo, mode: "insert" };
    }
    // dd removes the line(s) including one bounding newline.
    let dHi = hi;
    let dLo = lo;
    if (dHi < t.length) dHi++;
    else if (dLo > 0) dLo--;
    const next = t.slice(0, dLo) + t.slice(dHi);
    return this.result(next, Math.min(dLo === lo ? lo : dLo + 1, next.length));
  }

  private setRegister(content: string, linewise: boolean) {
    this.register =
      linewise && !content.endsWith("\n") ? content + "\n" : content;
    this.regLinewise = linewise;
  }

  private paste(doc: VimDoc, after: boolean, count: number): VimResult {
    if (!this.register) {
      this.clearPending();
      return this.result(doc.text, doc.start);
    }
    const t = doc.text;
    const reg = this.register.repeat(count);
    this.pushUndo(doc);
    this.clearPending();
    if (this.regLinewise) {
      if (after) {
        const le = lineEndAt(t, doc.start);
        if (le >= t.length) {
          // Pasting below the last line: newline first, no trailing one.
          const body = reg.replace(/\n$/, "");
          const next = t + "\n" + body;
          return this.result(next, t.length + 1);
        }
        const at = le + 1;
        return this.result(t.slice(0, at) + reg + t.slice(at), at);
      }
      const ls = lineStartAt(t, doc.start);
      return this.result(t.slice(0, ls) + reg + t.slice(ls), ls);
    }
    const at = doc.start;
    return this.result(t.slice(0, at) + reg + t.slice(at), at + reg.length);
  }

  private enterInsert(doc: VimDoc, caret: number): VimResult {
    // One undo unit per insert burst: snapshot the pre-insert state so `u`
    // after Escape unwinds everything typed in that session.
    this.pushUndo(doc);
    this.mode = "insert";
    this.clearPending();
    return { text: doc.text, start: caret, end: caret, mode: "insert" };
  }

  private pushUndo(doc: VimDoc) {
    this.undoStack.push({ text: doc.text, caret: doc.start });
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
  }

  private popHistory(doc: VimDoc, from: Snapshot[], to: Snapshot[]): VimResult {
    this.clearPending();
    const snap = from.pop();
    if (!snap) return this.result(doc.text, doc.start);
    to.push({ text: doc.text, caret: doc.start });
    return this.result(snap.text, snap.caret);
  }

  /** Visual-mode result: selection from the anchor to the new head. */
  private visualSelect(doc: VimDoc, head: number): VimResult {
    const t = doc.text;
    const h = Math.max(0, Math.min(t.length, head));
    let lo = Math.min(this.anchor, h);
    let hi = Math.max(this.anchor, h);
    if (this.mode === "visual-line") {
      lo = lineStartAt(t, lo);
      hi = lineEndAt(t, hi);
    }
    return { text: t, start: lo, end: hi, mode: this.mode };
  }

  /** The selection the operators act on ([from,to), linewise takes the newline). */
  private visualRange(doc: VimDoc): [number, number] {
    if (this.mode === "visual-line") {
      const lo = lineStartAt(doc.text, doc.start);
      let hi = lineEndAt(doc.text, doc.end);
      if (hi < doc.text.length) hi++;
      return [lo, hi];
    }
    // An empty visual selection still covers the character under the head.
    if (doc.start === doc.end)
      return [doc.start, Math.min(doc.text.length, doc.end + 1)];
    return [doc.start, doc.end];
  }
}
