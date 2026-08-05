/**
 * Colors, lifted from the web UI's dark palette (src/frontend/styles/foundation-adapters.css)
 * so the two clients read as the same product. Warm charcoal, not blue-black.
 *
 * A terminal already has a background, so we deliberately do NOT paint one on
 * the root: the user's own theme shows through and `os` looks native next to
 * their other panes. Only raised surfaces get a fill.
 */

export const theme = {
	fg: "#eee9e3",
	dim: "#aaa29a",
	faint: "#7d756e",
	panel: "#24211f",
	raised: "#292624",
	active: "#3a3531",
	border: "#38332f",
	borderStrong: "#4c4640",
	accent: "#ff3b3b",
	green: "#3fb950",
	yellow: "#d29922",
	blue: "#58a6ff",
	red: "#f85149",
	purple: "#a371f7",
} as const;

/** Per-status color + glyph — the sidebar's whole vocabulary. */
export const statusStyle = {
	waiting: { glyph: "?", color: theme.yellow, label: "needs you" },
	running: { glyph: "", color: theme.blue, label: "working" },
	error: { glyph: "!", color: theme.red, label: "failed" },
	done: { glyph: "✓", color: theme.green, label: "done" },
	idle: { glyph: "·", color: theme.faint, label: "idle" },
	preparing: { glyph: "⧗", color: theme.purple, label: "preparing" },
} as const;

/** Braille spinner — the same frames the web UI's running indicator uses. */
export const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export const roleStyle: Record<string, { label: string; color: string }> = {
	user: { label: "›", color: theme.blue },
	assistant: { label: "", color: theme.fg },
	tool_use: { label: "▸", color: theme.purple },
	tool_result: { label: "◂", color: theme.faint },
	system: { label: "•", color: theme.faint },
};
