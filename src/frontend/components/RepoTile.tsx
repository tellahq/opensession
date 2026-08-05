import React from "react";
import { repoLetter } from "../lib/repo-label";
import { cn } from "../ui/cn";

// Deterministic swatch palette shared by the sidebar's person dots and the
// per-repo tiles. The (lowercased) key hashes to a stable color, so each
// teammate/repo keeps the same color everywhere it appears.
export const SWATCH_COLORS = [
	"#e8836b",
	"#6ba5e8",
	"#8ed99c",
	"#e8c46b",
	"#c06be8",
	"#6be8d2",
	"#e86b9c",
	"#a3b86b",
];

export function swatchColor(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return SWATCH_COLORS[Math.abs(hash) % SWATCH_COLORS.length];
}

export function repoColor(key: string): string {
	return swatchColor(key);
}

// The display-name map lives in lib/repo-label so lib-level formatters can
// use it too; re-exported here because most callers reach it alongside the
// tile. The tile color stays keyed on the raw id (via repoColor) so it's
// stable across the rename.
export { repoLabel } from "../lib/repo-label";

// A repo's icon tile (sidebar Repo dropdown, session-header breadcrumb, repo
// menus): the server's /repo-icon/<id>.png — the repo's GitHub org avatar,
// with backstage wearing the OS1 mac app icon — falling back to the colored
// letter tile when no icon resolves (unregistered/local repos). `size` (px)
// shrinks it for tight spots like the phone header's model line; omitted =
// the 18px default. `round` makes it a full circle (e.g. the phone title
// pill, where it sits against the pill's own rounding).
export function RepoTile({
	name,
	size,
	round,
}: {
	name: string;
	size?: number;
	round?: boolean;
}) {
	// Failure is tracked per name so a tile that switches repo retries the img.
	const [failedFor, setFailedFor] = React.useState<string | null>(null);
	const style: React.CSSProperties = {};
	if (size) {
		style.width = size;
		style.height = size;
		style.fontSize = Math.round(size * 0.6);
		style.borderRadius = round ? "50%" : Math.max(3, Math.round(size * 0.28));
	} else if (round) {
		style.borderRadius = "50%";
	}
	if (failedFor !== name) {
		return (
			<span
				className={cn(
					"repo-tile repo-tile--img inline-flex size-[18px] shrink-0 items-center justify-center overflow-hidden text-label font-bold text-white",
					name === "backstage" && "repo-tile--app-icon [&_img]:scale-80",
				)}
				style={style}
			>
				<img
					src={`/repo-icon/${encodeURIComponent(name)}.png`}
					alt=""
					loading="lazy"
					className="size-full rounded-[inherit] object-cover"
					onError={() => setFailedFor(name)}
				/>
			</span>
		);
	}
	style.background = repoColor(name);
	const letter = repoLetter(name);
	return (
		<span
			className="repo-tile inline-flex size-[18px] shrink-0 items-center justify-center text-label font-bold text-white"
			style={style}
		>
			{letter}
		</span>
	);
}
