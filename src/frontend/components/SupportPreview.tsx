import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useRef, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { fetchModels, fetchPlainThreadById, type ModelOption } from "../lib/api";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { ConversationPane } from "./ConversationPane";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { getDefaultModelPref } from "../lib/default-model-pref";

interface Props {
	/** The Plain thread id — the preview's key. */
	threadId: string;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	/** Navigate into a session (the triage button resolves to one over HTTP). */
	onOpenSession: (id: string) => void;
}

/**
 * Session-less support-ticket view: what a sidebar Support row opens when no
 * session is linked to the Plain thread yet. The conversation itself is the
 * shared ConversationPane (also the workspace Conversation tab); this wrapper
 * adds the composer at the bottom that creates a fresh linked session on the
 * first message (`create_session` with `plainThreadId` — the server files it
 * under the ticket's one workspace) — App navigates into it on
 * `session_created` exactly like the PR preview.
 */
export function SupportPreview({
	threadId,
	connected,
	send,
	addHandler,
	onOpenSession,
}: Props) {
	const draftKey = `support-preview:${threadId}`;
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [ticketName, setTicketName] = useState<string | null>(null);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();

	// The workspace-name hint for the create (the pane loads the full thread
	// itself; this fetch only feeds the title fallback and is best-effort).
	useEffect(() => {
		let alive = true;
		fetchPlainThreadById(threadId)
			.then((t) => {
				if (alive)
					setTicketName(
						t?.title || t?.customer?.name || t?.customer?.email || null,
					);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [threadId]);

	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
				// Preselect the user's own default-model pref (Settings →
				// Composer) when set and selectable; "" keeps the workspace default.
				const pref = getDefaultModelPref();
				if (pref && m.models.some((item) => item.id === pref))
					setModel((current) => current || pref);
			})
			.catch(() => {});
	}, []);

	// Success navigates away on session_created (App handles it); on failure the
	// `starting` lock would stick forever — reset on server error or timeout
	// (same pattern as the PR preview).
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "error" && startingRef.current) {
				clearTimeout(startTimer.current);
				startingRef.current = false;
				setStarting(false);
				setStartError(msg.message || "Failed to start the session.");
			} else if (msg.type === "session_created" && startingRef.current) {
				clearDraft(draftKey);
			}
		});
	}, [addHandler, draftKey]);
	useEffect(() => () => clearTimeout(startTimer.current), []);

	function handleStart() {
		const q = prompt.trim();
		if (!q || starting || !connected) return;
		setStarting(true);
		startingRef.current = true;
		setStartError(null);
		clearTimeout(startTimer.current);
		startTimer.current = setTimeout(() => {
			if (!startingRef.current) return;
			startingRef.current = false;
			setStarting(false);
			setStartError(`${AGENT_NAME} didn't respond. Check your connection and try again.`);
		}, 15_000);
		send({
			type: "create_session",
			mode: "ask",
			branch: "",
			prompt: q,
			user: currentUser,
			plainThreadId: threadId,
			// Title hint for a first-time workspace resolve (the server files the
			// chat under the ticket's ONE workspace — see workspace-resolve.ts).
			createWorkspace: {
				name: (ticketName ? `Support: ${ticketName}` : "Support ticket").slice(0, 80),
			},
			...(model ? { model } : {}),
		});
		// App navigates into the session on session_created
	}

	return (
		<div className="flex flex-col h-full min-h-0">
			<ConversationPane threadId={threadId} onOpenSession={onOpenSession} />

			<div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={
						starting
							? "Starting…"
							: "Start a session on this ticket…"
					}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start session on this ticket (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this session"
				/>
				{startError && <div className="ask-error mt-2.5 rounded-md bg-red-soft px-2.5 py-1.5 text-center text-supporting text-red">{startError}</div>}
			</div>
		</div>
	);
}
