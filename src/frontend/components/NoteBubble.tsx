import React from "react";
import type { ChatMessage } from "../lib/types";
import { chatImageUrl } from "../lib/api";
import { UserAvatar } from "./UserAvatar";

/**
 * A team note interleaved into the session transcript — a human-to-human
 * message the agent never sees (Plain's "internal note" concept). Backed by
 * the session's chat channel (`session:<id>`, src/server/chat.ts); rendered
 * with a deliberate yellow tint so it can't be mistaken for a prompt or an
 * agent reply.
 */

function noteTime(ts: number): string {
	const d = new Date(ts);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === new Date().toDateString()) return time;
	return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const NOTE_TOKEN_RE = /(@[A-Za-z][\w.-]*|https?:\/\/[^\s<>"')\]]+)/g;

/** Note text with @Name emphasized and bare URLs clickable. */
function NoteText({ text }: { text: string }) {
	const parts = text.split(NOTE_TOKEN_RE);
	if (parts.length === 1) return <>{text}</>;
	return (
		<>
			{parts.map((p, i) => {
				if (/^https?:\/\//.test(p))
					return (
						<a
							key={i}
							href={p}
							target="_blank"
							rel="noreferrer"
							className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
						>
							{p}
						</a>
					);
				if (p.startsWith("@") && !p.startsWith("@session:"))
					return (
						<span key={i} className="font-semibold text-fg">
							{p}
						</span>
					);
				return <React.Fragment key={i}>{p}</React.Fragment>;
			})}
		</>
	);
}

export function NoteBubble({ note }: { note: ChatMessage }) {
	return (
		<div
			// A note is a transcript block like any other, so it takes the same
			// centered reading column the turns, footers and walkthrough cards use
			// (mx-auto + --chat-col) instead of spanning the whole pane, and the
			// same mt-2/mb-6 rhythm as the column's other card blocks (AskCard,
			// WalkthroughCard) so it doesn't crowd whatever follows it.
			className="note-bubble mx-auto mb-6 mt-2 w-full max-w-[var(--chat-col)] rounded-lg px-4 py-3.5"
			style={{
				background: "color-mix(in srgb, var(--yellow) 7%, transparent)",
			}}
		>
			<div className="mb-1 flex items-center gap-2">
				<UserAvatar name={note.user} size={18} />
				<span className="text-supporting font-semibold text-fg">{note.user}</span>
				<span
					className="text-meta font-semibold"
					style={{ color: "var(--yellow)" }}
					title="Team note — the agent doesn't see this"
				>
					Note
				</span>
				<span className="text-meta text-faint">{noteTime(note.ts)}</span>
			</div>
			{note.text && (
				<div className="whitespace-pre-wrap text-body leading-relaxed text-fg">
					<NoteText text={note.text} />
				</div>
			)}
			{!!note.images?.length && (
				<div className="mt-1.5 flex flex-wrap gap-2">
					{note.images.map((img) => (
						<a
							key={img.id}
							href={chatImageUrl(img.id)}
							target="_blank"
							rel="noreferrer"
						>
							<img
								src={chatImageUrl(img.id)}
								alt={img.name}
								loading="lazy"
								className="max-h-[180px] max-w-[240px] rounded-md border border-line object-cover"
							/>
						</a>
					))}
				</div>
			)}
		</div>
	);
}
