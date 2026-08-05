import React, { useState } from "react";
import {
	SessionUpgradeError,
	upgradeSessionApi,
} from "../lib/api";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { IconGlobe } from "./icons";

export function MoveToCloudDialog({
	open,
	sessionId,
	onOpenChange,
}: {
	open: boolean;
	sessionId: string;
	onOpenChange: (open: boolean) => void;
}) {
	const [moving, setMoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uncommittedFiles, setUncommittedFiles] = useState<string[]>([]);

	async function move() {
		if (moving) return;
		setMoving(true);
		setError(null);
		setUncommittedFiles([]);
		try {
			const result = await upgradeSessionApi(sessionId);
			window.location.assign(result.url);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setUncommittedFiles(
				cause instanceof SessionUpgradeError ? cause.uncommittedFiles : [],
			);
			setMoving(false);
		}
	}

	function changeOpen(next: boolean) {
		if (moving) return;
		setError(null);
		setUncommittedFiles([]);
		onOpenChange(next);
	}

	return (
		<Modal.Root
			open={open}
			onOpenChange={changeOpen}
			disablePointerDismissal={moving}
		>
			<Modal.Content widthClassName="max-w-[28rem]">
				<Modal.Header
					icon={<IconGlobe size={22} />}
					title="Move to cloud"
					description="Push this branch and continue the same session in your cloud OpenSession. The local copy will be archived after the transfer succeeds."
				/>

				{error && (
					<div
						className="rounded-md border border-red/30 bg-red-soft px-3 py-2.5 text-label leading-relaxed text-red"
						role="alert"
					>
						<div>{error}</div>
						{uncommittedFiles.length > 0 && (
							<ul className="mb-0 mt-2 max-h-40 overflow-y-auto pl-5 text-meta">
								{uncommittedFiles.map((file) => (
									<li key={file}>{file}</li>
								))}
							</ul>
						)}
					</div>
				)}

				<Modal.Footer>
					<div className="flex-1" />
					<Button
						variant="ghost"
						onClick={() => changeOpen(false)}
						disabled={moving}
					>
						Cancel
					</Button>
					<Button variant="primary" onClick={move} disabled={moving}>
						{moving ? "Moving..." : "Move to cloud"}
					</Button>
				</Modal.Footer>
			</Modal.Content>
		</Modal.Root>
	);
}
