import React, { useEffect, useState } from "react";
import { cn } from "../ui/cn";

/**
 * GitHub logins for the team, keyed by lowercased first name — the shape of
 * web user-picker names, presence viewers and `startedBy`, and also the first
 * token of full names coming from chat integrations. lib/people.ts populates
 * the map from the server directory (GET /api/people).
 */
const GITHUB_LOGIN: Record<string, string> = {};

/** Merge directory-fetched logins into the map (lib/people.ts). */
export function registerGithubLogins(entries: Record<string, string>) {
	Object.assign(GITHUB_LOGIN, entries);
}

export function githubLoginFor(name?: string | null): string | null {
	if (!name) return null;
	const first = name.trim().split(/\s+/)[0]?.toLowerCase();
	return (first && GITHUB_LOGIN[first]) || null;
}

/**
 * Squircle user picture: the person's GitHub avatar, falling back to their
 * initial for unknown users (the agent persona, Anonymous) or when the image fails to
 * load. `children` render on top of the squircle — the presence facepile uses
 * that for its count badge.
 */
export function UserAvatar({
	name,
	size = 24,
	className,
	title,
	style,
	children,
}: {
	name: string;
	size?: number;
	className?: string;
	title?: string;
	style?: React.CSSProperties;
	children?: React.ReactNode;
}) {
	const login = githubLoginFor(name);
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [login]);
	return (
		<span
			className={cn(
				"user-avatar relative inline-flex shrink-0 select-none items-center justify-center rounded-[32%] border border-line-strong bg-active font-bold text-dim [&>img]:absolute [&>img]:inset-0 [&>img]:size-full [&>img]:rounded-[inherit] [&>img]:object-cover",
				className,
			)}
			style={{
				width: size,
				height: size,
				fontSize: Math.max(9, Math.round(size * 0.46)),
				...style,
			}}
			title={title}
		>
			{login && !failed ? (
				<img
					src={`https://github.com/${login}.png?size=${size * 2}`}
					alt={name}
					loading="lazy"
					draggable={false}
					onError={() => setFailed(true)}
				/>
			) : (
				name.charAt(0).toUpperCase()
			)}
			{children}
		</span>
	);
}
