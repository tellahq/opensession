# Blocks: what an agent can show in a message

A message in a session is markdown. Beyond prose, code and images, an agent
can write a handful of block forms that the web UI renders as something live
or visual in place. This is the catalog, the grammar each one reads, and the
contract for adding a new kind.

Blocks are web-only progressive enhancements. Everywhere else (Slack, the
native app, an export, a client that predates the block) the fence stays a
readable code block and a marker stays a readable line. Never make a block the
only carrier of information the reader needs.

## Catalog

| Form                                 | Renders as                                             | Source                                                            |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------- |
| ` ```mermaid `                       | Diagram, expandable to the lightbox                    | `lib/mermaid-fence.ts`, `lib/mermaid.ts`                          |
| ` ```vega-lite ` (`chart`)           | Interactive chart with tooltips, themed, expandable    | `lib/chart-fence.ts`, `lib/vega-chart.ts`, `server/charts-mcp.ts` |
| ` ```diff `                          | Patch with whole added and removed rows washed         | `lib/shiki-engine.ts`                                             |
| `OPENSESSION_IMAGE: /abs/path.png`   | Image in place, full column width, optional caption    | `server/transcript-media.ts`, `lib/markdown.ts`                   |
| `OPENSESSION_VIDEO: /abs/path.mp4`   | Video player in place                                  | same                                                              |
| `OPENSESSION_COMPARE: /a.png /b.png` | Before/after slider                                    | `lib/compare-block.ts`                                            |
| `> [!NOTE]` … `> [!CAUTION]`         | GitHub-style callout                                   | `lib/markdown.ts`                                                 |
| `$$ … $$`, `$ … $`, ` ```math `      | Typeset math (KaTeX)                                   | `lib/math-block.ts`                                               |
| ` ```palette `, `` `#ff0080` ``      | Colour swatches; a hex codespan gets a swatch chip     | `lib/palette-block.ts`                                            |
| ` ```json ` (large)                  | Collapsible tree with a raw toggle                     | `lib/json-tree-block.ts`                                          |
| ` ```ansi ` (`terminal`)             | Terminal output with its ANSI colours                  | `lib/ansi-block.ts`                                               |
| ` ```csv ` (`tsv`, `table`)          | Sortable, filterable data grid with copy as CSV        | `lib/table-block.ts`                                              |
| ` ```choices `                       | Quick-reply chips that send that text as the next turn | `lib/choices-block.ts`                                            |
| ` ```tree `                          | Collapsible file tree; a row opens the file            | `lib/tree-block.ts`                                               |
| ` ```artifact ` (`svg`)              | Sandboxed HTML/SVG preview in an iframe, expandable    | `lib/artifact-block.ts`                                           |
| ` ```slides `                        | Swipeable deck of markdown slides split on `---`       | `lib/slides-block.ts`                                             |
| ` ```metrics `                       | Metric cards: big number, label, delta                 | `lib/metrics-block.ts`                                            |

Paths are under `packages/core/opensession-server/src/frontend/`. Each row's
section below is owned by the module that renders it; keep the grammar there
in step with the code.

### Diagrams and charts

See `.agents/skills/show-me/SKILL.md` for when to reach for each and
`docs/generated/mcp-tools.md` for `opensession-charts.make_chart`, which
validates a Vega-Lite spec and offloads large data into a session asset.

### Media in place

`OPENSESSION_IMAGE:` and `OPENSESSION_VIDEO:` lines render where they are
written, at the column's width. A line of plain text directly under a marker
is its caption. The entry's `images[]` / `videos[]` still carry the media for
the turn fold's strip and the lightbox gallery; the trailing thumbnail row
under a message only shows media the body did not already place.

### Before/after

`OPENSESSION_COMPARE: /abs/before.png /abs/after.png` renders the two images
as one slider. Both paths obey the same media rules as `OPENSESSION_IMAGE:`.

### Callouts

GitHub's admonition syntax: a blockquote whose first line is `[!NOTE]`,
`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` (any case) and
nothing else. The rest of the quote is the body, ordinary markdown. A marker
with text after it on the same line, or anywhere but the first line, is a
plain quote, as on GitHub.

### Math

`$$` on its own lines opens and closes a display block; `$x^2$` is inline.
Inline math needs the opening `$` to touch the expression and the closing `$`
to touch it too, with no digit after the close, so `$1.84`, `$5 to $10` and
`$5-$10` stay prose. It never spans a line or reaches into a code span; write
`\$` for a literal dollar next to an expression. A one-line `$$E=mc^2$$`
typesets in display mode where it sits. A ` ```math ` fence is a display
block as well, and a `$$` block renders as that fence until it is typeset,
so a block that does not parse stays readable source.

KaTeX writes MathML only (no katex.css, no fonts to serve); the browser
lays it out in its math font and the current text colour.

### Colour

A ` ```palette ` fence lists one colour per line, with an optional
name on either side: `#ff0080 Brand pink` or `Brand pink: #ff0080`. A
colour is `#hex` (3, 4, 6 or 8 digits), a colour function with a flat
argument list (`rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`,
`oklch()`, `color()`; no `color-mix()` or `calc()`), or a CSS colour
name. A trailing `;` or `,` on the value is ignored, so lines lifted from
a stylesheet parse. Blank lines are skipped; any other line that is not a
colour keeps the whole fence as code. Each swatch copies its value on
click.

A codespan that is exactly a six or eight digit hex (`` `#ff0080` ``)
gets a swatch chip before the text. Three and four digit forms do not,
since `#123` in a codespan is usually an issue number or an anchor.

### JSON tree

A ` ```json ` fence that parses to an object or array and is large enough
to be worth folding (more than 30 lines, or more than 1500 characters)
renders as a collapsible tree: keys and typed values in shiki's inks, the
root and its children open, anything deeper folded behind its count, and a
Tree / Raw toggle in the header that swaps to the highlighted text. Copy
still copies the JSON text. Small JSON, a bare scalar, and JSON that does
not parse (still streaming, comments, trailing commas) stay highlighted
code; `jsonc` and `json5` are not trees.

### Terminal output

` ```ansi ` and ` ```terminal ` fences render ANSI SGR sequences
(`ESC[...m`: bold, dim, italic, underline, strikethrough, inverse, the 16
colours and their bright forms, 256-colour and 24-bit) as styled text; every
other escape (cursor movement, erase, OSC) is stripped. Write the real escape
byte, or in an `ansi`/`terminal` fence its usual spellings (`\x1b[`, `\e[`,
`\033[`, `\u001b[`), which are decoded when the fence holds no real one. A
`bash`, `sh`, `zsh`, `shell`, `console`, `text` or `log` fence that carries
a real escape byte renders the same way. Copy copies the text without its
escape codes.

### Tables

` ```csv `, ` ```tsv ` and ` ```table ` fences (first row
is the header; `table` auto-detects comma, tab, semicolon or pipe, and reads
a GitHub pipe table, where `\|` is a literal pipe) render as a data grid:
click a header to sort, type to filter once there are more than eight rows,
copy the rows on screen as CSV. The grid puts at most 500 rows in the DOM
and says so in its count; sort, filter and copy still cover the whole table.
Fields follow RFC 4180, so a quoted field may hold the delimiter, a doubled
quote or a line break. A column whose every value is a number (thousands
separators, a currency sign and a trailing `%` allowed) sorts numerically
and right-aligns. Fewer than two rows, a header of one column or more than
a hundred, or more than one ragged row in ten keeps the plain code fence.

### Quick replies

A ` ```choices ` fence lists one reply per line. Each renders as a chip;
picking one sends that text as the next message. Chips go quiet once a
message has been sent after them.

### File trees

A ` ```tree ` fence holds an indented tree (two spaces per level, or
`tree` CLI box-drawing output). Directories fold; a file row opens that file
in the workspace pane when the session has one.

### Artifacts

An ` ```artifact ` fence holds a complete HTML document or a fragment; a
fragment is wrapped in a document that takes the app's background, text
colour and font, so it reads as native in both themes. An ` ```svg ` fence
holds an SVG, shown as an `<img>` inside the same frame. Both render in an
`<iframe sandbox>` by `srcdoc`: no same-origin access, no navigation, no
forms, no popups, and a `Content-Security-Policy` meta in the head with
`default-src 'none'` (inline styles and `data:` images allowed), so an
artifact cannot phone home. Scripts are off unless the info string is
` ```artifact scripts `, which adds `allow-scripts` and inline `script-src`
and labels the block "Scripts on". A scripted artifact reports its height
to the page (clamped to 120 to 900px); a static one starts at 320px with a
drag handle. The header row has a Source toggle (the original fence, whose
copy control copies the source) and an expand button that opens the same
sandboxed document in a full-width dialog. A fence still streaming renders
as it arrives.

### Slides

A ` ```slides ` fence is markdown split into slides on lines that are
exactly `---`. Renders as a deck in a 16:9 well: one slide at a time,
previous/next arrows, dots, a counter, arrow keys when the deck has focus,
and swipe on a phone. Each slide is ordinary markdown through the app's
renderer, with two limits: a nested fence inside a slide stays a plain code
block (neither upgraded into another block kind nor syntax highlighted,
since the body's upgrade pass has already run), and a `---` inside such a
fence belongs to the fence, not the deck. Nest fences by giving the deck a
longer fence (` ````slides `). The expand button opens the deck at the
dialog's width, on the current slide.

### Metrics

A ` ```metrics ` fence lists one metric per line as
`Label: value (delta)`, the parenthesised delta optional, or is a JSON array
of `{label, value, delta?, unit?}` (a numeric `value` or `delta` is formatted
for reading, `1204` as `1,204`). Renders as a row of cards: the value big and
tabular, the label under it, the delta beside the value and coloured by its
lead character: `+`, `▲` or `↑` is up, `-`, `▼` or `↓` is down, anything else
is neutral. A fence that does not parse stays a code block.

## Adding a block kind

Fence-shaped blocks register in `lib/fence-upgraders.ts`. The contract:

- One module, `lib/<name>-block.ts`, exporting a `FenceUpgrader`: the langs it
  claims (lowercase), `upgrade(ctx)` that replaces `ctx.pre` with the block
  and returns `true`, or returns `false` to keep the plain fence for shiki.
  Keep the module light; `import()` the renderer inside `upgrade`.
- `keepsCodeControls: true` when the block is still code someone might copy
  (the copy and wrap controls stay); otherwise the block carries its own
  controls, like a diagram's expand button.
- `finalize(root)` when the block mounts anything live: it runs on every
  reset and on unmount.
- Check `ctx.alive()` after every `await`; a superseded pass must not touch
  the DOM.
- One entry in `FENCE_UPGRADERS`. Its order is the upgrade order.
- Styles in `styles/blocks/<name>.css`, imported from `styles/base.css` with
  the other local modules. Use the semantic tokens from `base-theme.css`; no
  raw colours. Check dark and light, desktop and phone.
- Pure parsing in a plain function with a unit test beside the module; the
  DOM part stays thin.
- Tooling for the lightbox: add the block's expandable node to
  `GALLERY_SELECTOR` in `lib/media-lightbox-gallery.ts` if it opens there.

Marker-shaped blocks (`OPENSESSION_*:` lines) are read on the server by
`server/transcript-media.ts`, which is what every engine's parser calls, and
rendered by `lib/markdown.ts`.

Whatever the form, the agent has to know it exists: the model prompt
(`server/run-instructions.ts`, capped in length by its test) names the
forms in one line, and `.agents/skills/show-me/SKILL.md` explains when to use
each.
