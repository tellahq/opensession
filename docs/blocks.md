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
`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. The rest of the quote
is the body.

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

A ` ```palette ` fence lists one colour per line, `#hex` or any CSS
colour, optionally followed by a name. A hex colour in a codespan
(`` `#ff0080` ``) gets a swatch chip beside it.

### JSON tree

A ` ```json ` fence that parses and is large enough to be worth
folding renders as a collapsible tree with a toggle back to the raw text.
Small JSON stays highlighted code.

### Terminal output

` ```ansi ` and ` ```terminal ` fences render ANSI SGR colours and
styles. A `bash` or `console` fence that carries escape codes renders them
too.

### Tables

` ```csv `, ` ```tsv ` and ` ```table ` fences (first row
is the header) render as a data grid: click a header to sort, type to filter,
copy the whole thing as CSV. Numeric columns sort numerically.

### Quick replies

A ` ```choices ` fence lists one reply per line. Each renders as a chip;
picking one sends that text as the next message. Chips go quiet once a
message has been sent after them.

### File trees

A ` ```tree ` fence holds an indented tree (two spaces per level, or
`tree` CLI box-drawing output). Directories fold; a file row opens that file
in the workspace pane when the session has one.

### Artifacts

An ` ```artifact ` fence holds a complete HTML document or fragment;
an ` ```svg ` fence holds an SVG. Both render in a sandboxed iframe
(no same-origin access, no navigation, scripts only when the fence asks)
with a toggle to the source, and expand to the lightbox.

### Slides

A ` ```slides ` fence is markdown split into slides on `---` lines.
Renders as a deck with arrows, dots and swipe; each slide is ordinary
markdown, including the other block kinds.

### Metrics

A ` ```metrics ` fence lists one metric per line as
`Label: value (delta)`, or is a JSON array of `{label, value, delta, unit}`.
Renders as a row of cards.

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
