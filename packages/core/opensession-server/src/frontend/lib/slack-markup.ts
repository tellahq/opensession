// Slack message text as the Channels place shows it. The server has already
// turned Slack's own tokens into this app's: ![:name:](url) custom emoji,
// [label](url) links, [[@Name]] / [[#channel]] tags. What is left is Slack's
// mrkdwn, which this parses into blocks (paragraphs, "> " quotes, ``` code)
// and inline runs (*bold*, _italic_, ~strike~, `code`).

export type SlackInline =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: SlackInline[] }
  | { type: "code"; text: string }
  | { type: "emoji"; name: string; url: string }
  | { type: "tag"; label: string }
  | { type: "link"; href: string; label: string };

export type SlackBlock =
  | { type: "paragraph"; inlines: SlackInline[] }
  | { type: "quote"; inlines: SlackInline[] }
  | { type: "code"; text: string };

const TOKEN =
  /!\[([^\]]*)\]\((https?:[^)\s]+)\)|\[([^\]]+)\]\((https?:[^)\s]+)\)|\[\[([@#][^\]]+)\]\]|(https?:\/\/[^\s<>]+[^\s<>.,)\]}])/g;

// A Slack emphasis mark opens after a start, space or opening bracket and
// closes before an end, space or punctuation, with no space just inside.
const EMPHASIS =
  /(^|[\s([{"'])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s.,!?:;)\]}"'])/;

function emphasisType(mark: string): "bold" | "italic" | "strike" {
  return mark === "*" ? "bold" : mark === "_" ? "italic" : "strike";
}

function emphasis(text: string): SlackInline[] {
  const match = EMPHASIS.exec(text);
  if (!match) return text ? [{ type: "text", text }] : [];
  const [whole, lead, mark, inner] = match;
  const before = text.slice(0, match.index) + lead;
  const after = text.slice(match.index + whole.length);
  return [
    ...(before ? [{ type: "text" as const, text: before }] : []),
    {
      type: emphasisType(mark!),
      children: emphasis(inner!),
    },
    ...emphasis(after),
  ];
}

function tokens(text: string): SlackInline[] {
  const out: SlackInline[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(...emphasis(text.slice(last, m.index)));
    if (m[2] !== undefined) out.push({ type: "emoji", name: m[1]!, url: m[2] });
    else if (m[5] !== undefined) out.push({ type: "tag", label: m[5] });
    else
      out.push({
        type: "link",
        href: (m[4] ?? m[6])!,
        label: (m[3] ?? m[6])!,
      });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...emphasis(text.slice(last)));
  return out;
}

/** Inline runs of one paragraph: `code` first, since nothing inside it is
 *  markup, then links, tags and emphasis around it. */
export function slackInlines(text: string): SlackInline[] {
  const out: SlackInline[] = [];
  const parts = text.split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      out.push({ type: "code", text: part.slice(1, -1) });
    else if (part) out.push(...tokens(part));
  }
  return out;
}

export function slackBlocks(text: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const fenced = text.split("```");
  fenced.forEach((chunk, index) => {
    // Odd chunks sit between fences. An unclosed fence stays text.
    if (index % 2 === 1 && index < fenced.length - 1) {
      blocks.push({ type: "code", text: chunk.replace(/^\n|\n$/g, "") });
      return;
    }
    const raw = index % 2 === 1 ? "```" + chunk : chunk;
    // Runs of "> " lines are one quote; everything between is a paragraph.
    let run: { quote: boolean; lines: string[] } | null = null;
    const flush = () => {
      if (!run) return;
      const body = run.lines.join("\n").replace(/^\n+|\n+$/g, "");
      if (body || run.quote)
        blocks.push({
          type: run.quote ? "quote" : "paragraph",
          inlines: slackInlines(body),
        });
      run = null;
    };
    for (const line of raw.split("\n")) {
      const quoted = /^>\s?(.*)$/.exec(line);
      const quote = !!quoted;
      if (run && run.quote !== quote) flush();
      run ??= { quote, lines: [] };
      run.lines.push(quoted ? quoted[1]! : line);
    }
    flush();
  });
  return blocks;
}
