import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import type { TranscriptEntry } from "./types";

export class HandoffBudgetError extends Error {
  constructor() {
    super(
      "Conversation references cannot fit the handoff budget. Choose a larger-context model or a smaller history range.",
    );
    this.name = "HandoffBudgetError";
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).length;
const hint = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60);

/** Conservative byte accounting, not a tokenizer. Only history spends this
 * allowance; the current request is never clipped or placed in the selection. */
export function selectPortableHandoff(input: {
  entries: TranscriptEntry[];
  sessionId?: string;
  contextWindow?: number;
  reservedBytes?: number;
  maxBytes?: number;
  maxEntries?: number;
  requiredEntryId?: string;
}): string {
  const window = input.contextWindow || 128_000;
  const budget = Math.max(
    0,
    Math.min(
      input.maxBytes ?? 64_000,
      Math.floor(window / 4),
      window -
        (input.reservedBytes ?? 0) -
        Math.max(16_000, Math.floor(window / 4)),
    ),
  );
  const calls = new Map(
    input.entries
      .filter((e) => e.type === "tool_use")
      .map((e) => [e.toolUseId || e.id, e]),
  );
  const candidates = input.entries
    .filter((e) => !isContextInjection(e) && !e.isReasoning)
    .flatMap((e) => {
      let content = e.content;
      if (e.type === "tool_use" || e.type === "tool_result") {
        const call = e.type === "tool_use" ? e : calls.get(e.toolUseId || "");
        const args = call?.toolInput as Record<string, unknown> | undefined;
        const command = args?.command ?? args?.cmd;
        const exitCode = e.content.match(
          /exit (?:code|status)[: ]+(\d+)/i,
        )?.[1];
        const path = args?.path ?? args?.file_path;
        if (typeof command === "string")
          content = `Command: ${hint(command)}${e.type === "tool_result" ? `; ${e.isError ? "failed" : "completed"}${exitCode ? `; exit ${exitCode}` : ""}` : ""}`;
        else if (
          typeof path === "string" &&
          /edit|write/i.test(call?.toolName || "")
        )
          content = `File edited: ${hint(path)}${e.isError ? " (failed)" : ""}`;
        else return [];
      }
      const role = {
        user: "User",
        assistant: "Assistant",
        system: "System",
        tool_use: "Tool",
        tool_result: "Tool result",
      }[e.type];
      return [
        {
          entry: e,
          full: `- ${role}: ${content}`,
          reference: `- Omitted ${e.type} entry ${e.id}: ${hint(content)}`,
        },
      ];
    });
  if (!candidates.length) return "";
  const header = `Read omitted entries with opensession-sessions read_session_transcript (session id: ${input.sessionId || "this session"}, entry_id, offset). Offsets are characters.\n`;
  const selected = new Set<number>();
  const render = () =>
    header +
    candidates
      .map((c, i) => (selected.has(i) ? c.full : c.reference))
      .join("\n\n");
  const fullCosts = candidates.map((c) => bytes(c.full));
  const referenceCosts = candidates.map((c) => bytes(c.reference));
  const separators = 2 * (candidates.length - 1);
  const fullCost =
    bytes(header) + separators + fullCosts.reduce((a, b) => a + b, 0);
  if (input.maxEntries === undefined && fullCost <= budget) {
    candidates.forEach((_, i) => selected.add(i));
    return render();
  }
  let cost =
    bytes(header) + separators + referenceCosts.reduce((a, b) => a + b, 0);
  if (input.requiredEntryId) {
    const required = candidates.findIndex(
      (c) => c.entry.id === input.requiredEntryId,
    );
    if (required >= 0) {
      selected.add(required);
      cost += fullCosts[required] - referenceCosts[required];
    }
  }
  // Original request first, then newest requests/answers and recent activity.
  const first = candidates.findIndex((c) => c.entry.type === "user");
  const recent = candidates.map((_, i) => i).reverse();
  const priority = [
    ...(first >= 0 ? [first] : []),
    ...recent.filter((i) =>
      ["user", "assistant"].includes(candidates[i].entry.type),
    ),
    ...recent,
  ];
  if (cost > budget) throw new HandoffBudgetError();
  for (const i of new Set(priority)) {
    if (selected.has(i)) continue;
    if (input.maxEntries !== undefined && selected.size >= input.maxEntries)
      break;
    const next = cost + fullCosts[i] - referenceCosts[i];
    if (next <= budget) {
      selected.add(i);
      cost = next;
    }
  }
  return render();
}
