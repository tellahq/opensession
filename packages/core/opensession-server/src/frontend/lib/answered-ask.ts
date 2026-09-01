import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";

export const ANSWER_OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Resolve the legacy string answer back onto its offered choices. A single
 * option label can contain a comma, so only split when the question actually
 * allowed several selections. */
export function answeredAskState(
  question: AnsweredAskData["questions"][number],
): { selected: Set<string>; typed: string[] } {
  const options = question.options ?? [];
  const answer = question.answer.trim();
  if (!answer) return { selected: new Set(), typed: [] };

  if (!question.multiSelect) {
    const offered = options.find((option) => option.label === answer);
    return offered
      ? { selected: new Set([offered.label]), typed: [] }
      : { selected: new Set(), typed: [answer] };
  }

  const parts = answer
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const labels = new Set(options.map((option) => option.label));
  return {
    selected: new Set(parts.filter((part) => labels.has(part))),
    typed: parts.filter((part) => !labels.has(part)),
  };
}
