// The Channels composer's formatting row, written as Slack's own markup
// (mrkdwn): *bold*, _italic_, ~strike~, `code`, ```block```, "> " quotes and
// list prefixes. Each action takes the text and its selection and returns the
// new text and selection, so the textarea stays the one source of truth.

export type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "link"
  | "ordered"
  | "bullet"
  | "quote"
  | "code"
  | "codeblock";

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

const WRAP: Partial<Record<FormatKind, string>> = {
  bold: "*",
  italic: "_",
  strike: "~",
  code: "`",
};

/** The start of the line `index` sits on. */
function lineStart(value: string, index: number): number {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next < 0 ? value.length : next;
}

function prefixLines(
  edit: TextEdit,
  prefix: (index: number) => string,
): TextEdit {
  const from = lineStart(edit.value, edit.start);
  const to = lineEnd(edit.value, Math.max(edit.start, edit.end - 1));
  const lines = edit.value.slice(from, to).split("\n");
  const block = lines.map((line, i) => prefix(i) + line).join("\n");
  const value = edit.value.slice(0, from) + block + edit.value.slice(to);
  return {
    value,
    start: from + prefix(0).length,
    end: from + block.length,
  };
}

export function applyFormat(edit: TextEdit, kind: FormatKind): TextEdit {
  const { value, start, end } = edit;
  const selected = value.slice(start, end);
  const mark = WRAP[kind];
  if (mark) {
    // Already wrapped: take the marks off again, as Slack's toolbar does.
    if (
      value.slice(start - mark.length, start) === mark &&
      value.slice(end, end + mark.length) === mark
    )
      return {
        value:
          value.slice(0, start - mark.length) +
          selected +
          value.slice(end + mark.length),
        start: start - mark.length,
        end: end - mark.length,
      };
    return {
      value: value.slice(0, start) + mark + selected + mark + value.slice(end),
      start: start + mark.length,
      end: end + mark.length,
    };
  }
  switch (kind) {
    case "codeblock": {
      const block = "```\n" + selected + "\n```";
      return {
        value: value.slice(0, start) + block + value.slice(end),
        start: start + 4,
        end: start + 4 + selected.length,
      };
    }
    case "link": {
      // Slack's link form is <url|label>. The URL slot is selected so it can
      // be typed or pasted straight away.
      const url = /^https?:\/\//.test(selected) ? selected : "https://";
      const label = url === selected ? "" : selected;
      const link = label ? `<${url}|${label}>` : `<${url}>`;
      return {
        value: value.slice(0, start) + link + value.slice(end),
        start: start + 1,
        end: start + 1 + url.length,
      };
    }
    case "quote":
      return prefixLines(edit, () => "> ");
    case "bullet":
      return prefixLines(edit, () => "• ");
    case "ordered":
      return prefixLines(edit, (i) => `${i + 1}. `);
    default:
      return edit;
  }
}

/** The "@name" being typed at the caret, for the mention picker. */
export function mentionContextAt(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && caret - i <= 32) {
    const ch = value[i]!;
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : undefined;
      if (prev && /[\w@]/.test(prev)) return null;
      return { start: i, query: value.slice(i + 1, caret) };
    }
    // Names carry spaces ("@Ada L"), but a second space ends the query.
    if (ch === "\n" || (ch === " " && value[i - 1] === " ")) return null;
    i--;
  }
  return null;
}
