import { describe, expect, test } from "bun:test";
import {
  VimEngine,
  verticalCaretTarget,
  type VimDoc,
  type VimResult,
} from "./vim";

// Drive an engine with a key string ("dw", "2dd", "ciw"-style sequences of
// single chars) plus named keys in <angle brackets> ("<Escape>", "<C-r>").
function press(engine: VimEngine, keys: string, doc: VimDoc): VimDoc {
  let cur = { ...doc };
  const parts = keys.match(/<[^>]+>|./gs) ?? [];
  for (const part of parts) {
    let key = part;
    let ctrlKey = false;
    if (part.startsWith("<")) {
      key = part.slice(1, -1);
      if (key.startsWith("C-")) {
        ctrlKey = true;
        key = key.slice(2);
      }
    }
    const res: VimResult | null = engine.handleKey(
      { key, ctrlKey, metaKey: false, altKey: false, shiftKey: false },
      cur,
    );
    if (res) cur = { text: res.text, start: res.start, end: res.end };
    else if (key.length === 1 && engine.mode === "insert") {
      // Unconsumed printable key in insert mode: the textarea types it.
      cur = {
        text: cur.text.slice(0, cur.start) + key + cur.text.slice(cur.end),
        start: cur.start + 1,
        end: cur.start + 1,
      };
    }
  }
  return cur;
}

function fresh(text: string, caret = 0): { engine: VimEngine; doc: VimDoc } {
  const engine = new VimEngine();
  // Engines start in insert; Escape into normal for command tests.
  engine.handleKey(
    {
      key: "Escape",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    },
    { text, start: caret, end: caret },
  );
  engine.mode = "normal";
  return { engine, doc: { text, start: caret, end: caret } };
}

describe("modes", () => {
  test("starts in insert; Escape enters normal and steps back", () => {
    const engine = new VimEngine();
    expect(engine.mode).toBe("insert");
    const res = engine.handleKey(
      {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      { text: "hello", start: 3, end: 3 },
    );
    expect(engine.mode).toBe("normal");
    expect(res?.start).toBe(2);
  });

  test("Escape at line start doesn't cross into the previous line", () => {
    const engine = new VimEngine();
    const res = engine.handleKey(
      {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      { text: "ab\ncd", start: 3, end: 3 },
    );
    expect(res?.start).toBe(3);
  });

  test("insert-mode typing is not consumed", () => {
    const engine = new VimEngine();
    const res = engine.handleKey(
      {
        key: "x",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      { text: "", start: 0, end: 0 },
    );
    expect(res).toBeNull();
  });

  test("i / a / A re-enter insert at the right spot", () => {
    const { engine, doc } = fresh("hello", 2);
    let d = press(engine, "a", doc);
    expect(engine.mode).toBe("insert");
    expect(d.start).toBe(3);
    d = press(engine, "<Escape>A", d);
    expect(d.start).toBe(5);
  });

  test("bare Escape in normal mode is not consumed (falls through to stop)", () => {
    const { engine, doc } = fresh("hello", 2);
    const res = engine.handleKey(
      {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(res).toBeNull();
  });

  test("Enter is never consumed (send keeps working)", () => {
    const { engine, doc } = fresh("hello", 0);
    const res = engine.handleKey(
      {
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(res).toBeNull();
  });

  test("unbound printable keys are consumed no-ops in normal mode", () => {
    const { engine, doc } = fresh("hello", 0);
    const res = engine.handleKey(
      {
        key: "q",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(res).not.toBeNull();
    expect(res?.text).toBe("hello");
  });
});

describe("motions", () => {
  test("h l 0 $ ^", () => {
    const { engine, doc } = fresh("  hello world", 5);
    expect(press(engine, "l", doc).start).toBe(6);
    expect(press(engine, "hh", doc).start).toBe(3);
    expect(press(engine, "0", doc).start).toBe(0);
    expect(press(engine, "$", doc).start).toBe(13);
    expect(press(engine, "^", doc).start).toBe(2);
  });

  test("h/l stop at line bounds", () => {
    const { engine, doc } = fresh("ab\ncd", 3);
    expect(press(engine, "h", doc).start).toBe(3);
    expect(press(engine, "$l", doc).start).toBe(5);
  });

  test("w b e word motions", () => {
    const { engine, doc } = fresh("foo bar-baz qux", 0);
    expect(press(engine, "w", doc).start).toBe(4); // bar
    expect(press(engine, "ww", doc).start).toBe(7); // -
    expect(press(engine, "3w", doc).start).toBe(8); // baz
    expect(press(engine, "wwwwb", doc).start).toBe(8);
    expect(press(engine, "e", doc).start).toBe(3); // end of foo
  });

  test("j k with sticky column", () => {
    const { engine, doc } = fresh("longline\nab\nlongerline", 6);
    let d = press(engine, "j", doc);
    expect(d.start).toBe(11); // clamped to "ab" end
    d = press(engine, "j", d);
    expect(d.start).toBe(18); // column restored on the long line
    d = press(engine, "kk", d);
    expect(d.start).toBe(6);
  });

  test("gg and G", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 5);
    expect(press(engine, "gg", doc).start).toBe(0);
    expect(press(engine, "G", doc).start).toBe(13);
  });

  test("f t F T find in line", () => {
    const { engine, doc } = fresh("abcabc\nxyz", 0);
    expect(press(engine, "fb", doc).start).toBe(1);
    expect(press(engine, "2fc", doc).start).toBe(2); // count unsupported on find → first hit
    expect(press(engine, "tc", doc).start).toBe(1);
    expect(press(engine, "$Fa", doc).start).toBe(3);
    expect(press(engine, "fz", doc).start).toBe(0); // not on this line → no move
  });
});

describe("edits", () => {
  test("x and X", () => {
    const { engine, doc } = fresh("hello", 1);
    expect(press(engine, "x", doc).text).toBe("hllo");
    const { engine: e2, doc: d2 } = fresh("hello", 2);
    expect(press(e2, "2x", d2).text).toBe("heo");
    const { engine: e3, doc: d3 } = fresh("hello", 2);
    expect(press(e3, "X", d3).text).toBe("hllo");
  });

  test("dw / de / db", () => {
    const { engine, doc } = fresh("foo bar baz", 0);
    expect(press(engine, "dw", doc).text).toBe("bar baz");
    const { engine: e2, doc: d2 } = fresh("foo bar baz", 4);
    expect(press(e2, "de", d2).text).toBe("foo  baz");
    const { engine: e3, doc: d3 } = fresh("foo bar baz", 4);
    expect(press(e3, "db", d3).text).toBe("bar baz");
  });

  test("d$ and D", () => {
    const { engine, doc } = fresh("hello world", 5);
    expect(press(engine, "d$", doc).text).toBe("hello");
    const { engine: e2, doc: d2 } = fresh("hello world\nnext", 5);
    const d = press(e2, "D", d2);
    expect(d.text).toBe("hello\nnext");
  });

  test("dd removes the line and its newline", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 5);
    const d = press(engine, "dd", doc);
    expect(d.text).toBe("one\nthree");
    expect(d.start).toBe(4);
  });

  test("dd on the last line absorbs the preceding newline", () => {
    const { engine, doc } = fresh("one\ntwo", 5);
    expect(press(engine, "dd", doc).text).toBe("one");
  });

  test("2dd deletes two lines", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 0);
    expect(press(engine, "2dd", doc).text).toBe("three");
  });

  test("dj is linewise", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 1);
    expect(press(engine, "dj", doc).text).toBe("three");
  });

  test("cw enters insert; typed text lands", () => {
    const { engine, doc } = fresh("foo bar", 0);
    const d = press(engine, "cwhi", doc);
    expect(engine.mode).toBe("insert");
    expect(d.text).toBe("hi bar");
  });

  test("cc clears the line but keeps the slot", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 5);
    const d = press(engine, "cc", doc);
    expect(d.text).toBe("one\n\nthree");
    expect(d.start).toBe(4);
    expect(engine.mode).toBe("insert");
  });

  test("C and s", () => {
    const { engine, doc } = fresh("hello world", 5);
    expect(press(engine, "C", doc).text).toBe("hello");
    const { engine: e2, doc: d2 } = fresh("hello", 1);
    const d = press(e2, "sX", d2);
    expect(d.text).toBe("hXllo");
  });

  test("r replaces a single char", () => {
    const { engine, doc } = fresh("hello", 1);
    const d = press(engine, "rX", doc);
    expect(d.text).toBe("hXllo");
    expect(engine.mode).toBe("normal");
  });

  test("o and O open lines", () => {
    const { engine, doc } = fresh("one\ntwo", 1);
    const d = press(engine, "ohi", doc);
    expect(d.text).toBe("one\nhi\ntwo");
    const { engine: e2, doc: d2 } = fresh("one\ntwo", 5);
    const d3 = press(e2, "Ohi", d2);
    expect(d3.text).toBe("one\nhi\ntwo");
  });
});

describe("yank / paste", () => {
  test("yy then p pastes the line below", () => {
    const { engine, doc } = fresh("one\ntwo", 0);
    const d = press(engine, "yyp", doc);
    expect(d.text).toBe("one\none\ntwo");
    expect(d.start).toBe(4);
  });

  test("yy then P pastes the line above", () => {
    const { engine, doc } = fresh("one\ntwo", 5);
    expect(press(engine, "yyP", doc).text).toBe("one\ntwo\ntwo");
  });

  test("linewise p on the last line", () => {
    const { engine, doc } = fresh("one\ntwo", 0);
    const d = press(engine, "yyGp", doc);
    expect(d.text).toBe("one\ntwo\none");
  });

  test("charwise yank via yw then p", () => {
    const { engine, doc } = fresh("foo bar", 0);
    const d = press(engine, "yw$p", doc);
    expect(d.text).toBe("foo barfoo ");
  });

  test("dd carries into the register (delete = cut)", () => {
    const { engine, doc } = fresh("one\ntwo", 0);
    const d = press(engine, "ddp", doc);
    expect(d.text).toBe("two\none");
  });
});

describe("undo / redo", () => {
  test("u undoes an edit, Ctrl+r redoes", () => {
    const { engine, doc } = fresh("one\ntwo", 0);
    let d = press(engine, "dd", doc);
    expect(d.text).toBe("two");
    d = press(engine, "u", d);
    expect(d.text).toBe("one\ntwo");
    d = press(engine, "<C-r>", d);
    expect(d.text).toBe("two");
  });

  test("an insert burst is one undo unit", () => {
    const { engine, doc } = fresh("start", 5);
    let d = press(engine, "aXYZ<Escape>", doc);
    expect(d.text).toBe("startXYZ");
    d = press(engine, "u", d);
    expect(d.text).toBe("start");
  });

  test("u with nothing to undo is a consumed no-op", () => {
    const { engine, doc } = fresh("abc", 1);
    const d = press(engine, "u", doc);
    expect(d.text).toBe("abc");
  });
});

describe("visual mode", () => {
  test("v + motions select, d deletes", () => {
    const { engine, doc } = fresh("foo bar baz", 0);
    let d = press(engine, "vw", doc);
    expect(engine.mode).toBe("visual");
    expect([d.start, d.end]).toEqual([0, 4]);
    d = press(engine, "d", d);
    expect(d.text).toBe("bar baz");
    expect(engine.mode).toBe("normal");
  });

  test("v e y then p", () => {
    const { engine, doc } = fresh("foo bar", 0);
    let d = press(engine, "vey", doc);
    expect(engine.mode).toBe("normal");
    d = press(engine, "$p", d);
    expect(d.text).toBe("foo barfoo");
  });

  test("V selects whole lines; d removes them", () => {
    const { engine, doc } = fresh("one\ntwo\nthree", 5);
    let d = press(engine, "V", doc);
    expect([d.start, d.end]).toEqual([4, 7]);
    d = press(engine, "jd", d);
    expect(d.text).toBe("one\n");
  });

  test("Escape leaves visual mode without editing", () => {
    const { engine, doc } = fresh("foo bar", 0);
    const d = press(engine, "vw<Escape>", doc);
    expect(engine.mode).toBe("normal");
    expect(d.text).toBe("foo bar");
  });

  test("c on a selection enters insert", () => {
    const { engine, doc } = fresh("foo bar", 0);
    const d = press(engine, "vwchi", doc);
    expect(d.text).toBe("hibar");
    expect(engine.mode).toBe("insert");
  });

  test("o swaps anchor and head", () => {
    const { engine, doc } = fresh("foo bar baz", 4);
    let d = press(engine, "vw", doc);
    expect([d.start, d.end]).toEqual([4, 8]);
    d = press(engine, "ob", d);
    expect([d.start, d.end]).toEqual([0, 8]);
  });
});

describe("verticalCaretTarget (key-bar arrow emulation)", () => {
  test("moves down/up keeping the column, clamped to short lines", () => {
    const t = "longline\nab\nlonger";
    expect(verticalCaretTarget(t, 6, 1)).toBe(11); // clamped to "ab" end
    expect(verticalCaretTarget(t, 10, 1)).toBe(13); // col 1 into "longer"
    expect(verticalCaretTarget(t, 13, -1)).toBe(10);
  });

  test("stays put at buffer edges", () => {
    const t = "one\ntwo";
    expect(verticalCaretTarget(t, 5, 1)).toBe(5);
    expect(verticalCaretTarget(t, 1, -1)).toBe(1);
  });
});

describe("pending-state robustness", () => {
  test("Shift keydown doesn't cancel a pending operator (d$)", () => {
    const { engine, doc } = fresh("hello world", 5);
    const d = press(engine, "d<Shift>$", doc);
    expect(d.text).toBe("hello");
  });

  test("Escape cancels a pending operator and is consumed", () => {
    const { engine, doc } = fresh("hello", 0);
    const first = engine.handleKey(
      {
        key: "d",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(first).not.toBeNull();
    const esc = engine.handleKey(
      {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(esc).not.toBeNull(); // consumed: cancelled the operator, no stop
    const d = press(engine, "w", doc);
    expect(d.text).toBe("hello"); // w moved, nothing deleted
  });

  test("meta/ctrl shortcuts pass through in normal mode", () => {
    const { engine, doc } = fresh("hello", 0);
    const res = engine.handleKey(
      {
        key: "a",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      },
      doc,
    );
    expect(res).toBeNull();
  });
});
