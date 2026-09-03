/**
 * Open Session protocol — the contracts a cloud agent session is made of:
 *
 * - `./events`  — engine-neutral run event stream (`StreamEvent`, `TurnUsage`)
 * - `./live-text` — the live bubble's text (`LiveTextBuffer`): how a surface
 *                 showing a running turn cancels a block once it lands
 *                 durably, so a reply never renders twice
 * - `./runner`  — the run-host wire contract (`RunHostSpec`, host/client
 *                 messages, NDJSON framing): what "bring your own runner" means
 * - `./executor` — the tool/workspace-only execution wire contract
 * - `./session` — the client↔server session contract (`TranscriptEntry`,
 *                 asks, usage, core WebSocket frames): "bring your own UI"
 * - `./notices` — how a transcript entry reads: the classifier that turns
 *                 operational deliveries into one uniform `notice`
 * - `./pasted-text` — a large paste as an attachment: how it folds into the
 *                 prompt and lifts back onto the entry as `pastedTexts`
 * - `./tool-presentation` — what a tool call is and what it did, derived once
 *                 for every client (`./todo-plan` parses the model's plan)
 * - `./identity` — cross-cutting identity records (`GitIdentity`)
 *
 * The Open Session server, web UI, and native clients are the reference
 * implementations; anything speaking these types can run or watch a session.
 */
export * from "./events";
export * from "./live-text";
export * from "./runner";
export * from "./session";
export * from "./notices";
export * from "./pasted-text";
export * from "./todo-plan";
export * from "./tool-presentation";
export * from "./identity";
export * from "./executor";
