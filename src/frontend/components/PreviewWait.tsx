import { useEffect, useState } from "react";
import { ApiError, fetchPreview } from "../lib/api";
import { BASE_PATH, stripBasePath } from "../lib/base";
import { PRODUCT_NAME, docTitle } from "../lib/brand";
import { withPreviewPath } from "../lib/preview-url";

/**
 * Preview interstitial — the page a "Start preview" click opens in a new tab
 * while the dev server boots (`/preview-wait/<sessionId>`).
 *
 * Popup blockers only allow window.open inside the user gesture, but the
 * preview URL doesn't exist until the server is up — so the button opens THIS
 * same-origin page synchronously and we poll the preview-status endpoint here,
 * replacing ourselves with the app the moment it's live. Served by the SPA
 * fallback (any non-API GET under the prefix serves the shell), so no server
 * route was needed; App.tsx renders this INSTEAD of the app for this path —
 * deliberately outside UserGate, so it also works in contexts with cold
 * localStorage (e.g. the iOS PWA's in-app browser view).
 *
 * The final hop is a plain `location.replace(previewUrl)` onto the preview's
 * own `https://<host>:9xxx` origin — a different port, so a different origin,
 * out of the PWA's scope, and never proxied through the app origin. Per
 * platform that means: a normal browser tab stays a tab in that browser; an
 * installed desktop PWA treats the target as out-of-scope (Chrome keeps the
 * window but drops in its out-of-scope toolbar / hands off to a regular
 * browser window); the iOS PWA shows it in the in-app Safari view (platform
 * limitation — a web app can't choose the browser).
 */

/** `/preview-wait/<sessionId>` (either prefix) → sessionId, else null. */
export function matchPreviewWaitRoute(pathname: string): string | null {
	const m = stripBasePath(pathname).match(/^\/preview-wait\/(.+)$/);
	return m ? decodeURIComponent(m[1]) : null;
}

// Dev-server bring-ups are minutes at worst (first build); past this we stop
// polling and say so instead of spinning forever.
const TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 2000;

type WaitState = "waiting" | "timeout" | "gone";

export function PreviewWait({ sessionId }: { sessionId: string }) {
	const [state, setState] = useState<WaitState>("waiting");
	// Whose preview this is (title · branch), from the status poll — so a
	// reused/stale tab is immediately recognizable as belonging to a session.
	const [who, setWho] = useState<string | null>(null);

	// Tear down the launch splash (rendered in index.html), same as App does.
	useEffect(() => {
		document.title = docTitle("Starting preview");
		const splash = document.getElementById("splash");
		if (!splash) return;
		splash.classList.add("splash-hide");
		const t = setTimeout(() => splash.remove(), 400);
		return () => clearTimeout(t);
	}, []);

	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const deadline = Date.now() + TIMEOUT_MS;
		// Deep-link recorded by the agent (set_preview_path), snapshotted onto the
		// interstitial URL by the button so the redirect lands on the feature
		// under test, matching what a direct click on the live link would open.
		const previewPath = new URLSearchParams(location.search).get("path");

		const tick = async () => {
			try {
				const s = await fetchPreview(sessionId);
				if (!alive) return;
				const label = [s.sessionTitle, s.sessionBranch]
					.filter(Boolean)
					.join(" · ");
				if (label) setWho(label);
				if (s.running && s.previewUrl) {
					// Sever the opener link before leaving — the preview is another
					// origin and has no business scripting the tab that spawned us.
					try {
						window.opener = null;
					} catch {}
					location.replace(withPreviewPath(s.previewUrl, previewPath));
					return; // keep showing the spinner while the browser navigates
				}
			} catch (e) {
				if (e instanceof ApiError && e.status === 404) {
					if (alive) setState("gone");
					return;
				}
				// Transient fetch errors (server restart blip) — just keep polling.
			}
			if (!alive) return;
			if (Date.now() >= deadline) {
				setState("timeout");
				return;
			}
			timer = setTimeout(tick, POLL_MS);
		};
		tick();
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	}, [sessionId]);

	// A vanished session has nothing to go back to — send those home instead.
	const backHref =
		state === "gone"
			? `${BASE_PATH}/`
			: `${BASE_PATH}/session/${encodeURIComponent(sessionId)}`;

	return (
		<div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
			<div className="text-control-label font-semibold tracking-wide text-faint select-none">
				{PRODUCT_NAME}
			</div>
			{state === "waiting" ? (
				<>
					<span
						className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
						aria-hidden="true"
					/>
					<div className="text-item-title font-semibold text-fg">
						Starting the dev server…
					</div>
					{who && (
						<div className="max-w-sm truncate text-control-label font-semibold text-dim">
							{who}
						</div>
					)}
					<div className="max-w-sm text-control-label font-medium leading-relaxed text-dim">
						The first build can take a minute. This tab will open the app
						automatically when it's ready — keep it in the background.
					</div>
				</>
			) : (
				<>
					<div className="text-item-title font-semibold text-fg">
						{state === "gone"
							? "Session not found"
							: "The dev server didn't come up"}
					</div>
					<div className="max-w-sm text-control-label font-medium leading-relaxed text-dim">
						{state === "gone"
							? "This preview link points at a session that no longer exists."
							: "It's been a few minutes with nothing listening — the boot may have failed. Check the session's Preview services for details, or try starting it again."}
					</div>
					<a
						href={backHref}
						className="rounded-md border border-line-strong px-3.5 py-1.5 text-control-label font-semibold text-fg no-underline hover:border-accent hover:bg-accent-soft"
					>
						{state === "gone" ? "Open " + PRODUCT_NAME : "Back to the session"}
					</a>
				</>
			)}
		</div>
	);
}
