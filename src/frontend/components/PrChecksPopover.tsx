import type React from "react";
import type { PrCheck } from "../lib/types";
import { Popover } from "../ui/popover";

type CheckVisual = "success" | "failure" | "pending" | "skipped" | "neutral";

function checkStatusMeta(check: PrCheck): { kind: CheckVisual; label: string } {
	const running = check.status !== "COMPLETED" && check.status !== "";
	if (
		running ||
		check.conclusion === "PENDING" ||
		check.conclusion === "EXPECTED"
	)
		return { kind: "pending", label: running ? "Running" : "Queued" };
	switch (check.conclusion) {
		case "SUCCESS":
			return { kind: "success", label: "Succeeded" };
		case "FAILURE":
			return { kind: "failure", label: "Failed" };
		case "TIMED_OUT":
			return { kind: "failure", label: "Timed out" };
		case "ERROR":
			return { kind: "failure", label: "Error" };
		case "ACTION_REQUIRED":
			return { kind: "failure", label: "Action required" };
		case "CANCELLED":
			return { kind: "neutral", label: "Cancelled" };
		case "SKIPPED":
			return { kind: "skipped", label: "Skipped" };
		case "NEUTRAL":
			return { kind: "neutral", label: "Neutral" };
		default:
			return { kind: "neutral", label: check.conclusion || "Pending" };
	}
}

function checkToneClass(kind: CheckVisual): string {
	switch (kind) {
		case "success":
			return "text-green";
		case "failure":
			return "text-red";
		case "pending":
			return "text-yellow";
		default:
			return "text-dim";
	}
}

function CheckStatusIcon({ kind }: { kind: CheckVisual }) {
	if (kind === "pending")
		return (
			<span
				className="m-[1.5px] block size-[13px] animate-spin rounded-full border-[1.6px] border-current/30 border-t-current"
				aria-hidden
			/>
		);
	if (kind === "success")
		return (
			<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M4.4 8.3l2.3 2.3 4.9-4.9"
					fill="none"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		);
	if (kind === "failure")
		return (
			<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
				/>
			</svg>
		);
	return (
		<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
			<circle
				cx="8"
				cy="8"
				r="7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeDasharray="2.4 2.2"
			/>
		</svg>
	);
}

/** A shared checks preview: hover for detail, click its trigger to open Review's Checks tab. */
export function PrChecksPopover({
	checks,
	trigger,
}: {
	checks: PrCheck[];
	trigger: React.ReactElement;
}) {
	const order: Record<CheckVisual, number> = {
		failure: 0,
		pending: 1,
		success: 2,
		skipped: 3,
		neutral: 3,
	};
	const sorted = [...checks].sort(
		(a, b) => order[checkStatusMeta(a).kind] - order[checkStatusMeta(b).kind],
	);
	const summary = sorted.reduce(
		(sum, check) => {
			switch (checkStatusMeta(check).kind) {
				case "success":
					sum.passed++;
					break;
				case "failure":
					sum.failed++;
					break;
				case "pending":
					sum.pending++;
					break;
			}
			return sum;
		},
		{ passed: 0, failed: 0, pending: 0 },
	);

	return (
		<Popover.Root>
			<Popover.Trigger render={trigger} openOnHover delay={200} closeDelay={120} />
			<Popover.Popup
				side="left"
				align="start"
				sideOffset={10}
				className="flex max-h-[min(560px,70vh,var(--available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden p-0"
			>
				<div className="flex items-baseline justify-between gap-2.5 border-b border-line bg-surface px-3 py-[9px]">
					<span className="text-label font-semibold text-fg">
						{sorted.length} check{sorted.length === 1 ? "" : "s"}
					</span>
					<span className="inline-flex gap-2 text-meta font-semibold">
						{summary.passed > 0 && <span className="text-green">{summary.passed} passed</span>}
						{summary.failed > 0 && <span className="text-red">{summary.failed} failed</span>}
						{summary.pending > 0 && <span className="text-yellow">{summary.pending} running</span>}
					</span>
				</div>
				<div className="overflow-y-auto p-1">
					{sorted.map((check, i) => {
						const status = checkStatusMeta(check);
						const content = (
							<>
								<span className={`inline-flex size-4 shrink-0 ${checkToneClass(status.kind)}`}>
									<CheckStatusIcon kind={status.kind} />
								</span>
								<span className="min-w-0 flex-1 truncate text-control-label font-medium text-fg">
									{check.name}
								</span>
								<span className="shrink-0 text-label font-medium text-dim">
									{status.label}
								</span>
							</>
						);
						return check.url ? (
							<a
								key={`${check.name}:${i}`}
								className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg no-underline hover:bg-surface"
								href={check.url}
								target="_blank"
								rel="noopener"
							>
								{content}
							</a>
						) : (
							<div key={`${check.name}:${i}`} className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg">
								{content}
							</div>
						);
					})}
				</div>
			</Popover.Popup>
		</Popover.Root>
	);
}
