/**
 * Turn a human time expression ("next Tuesday 9am", "in a week", "tomorrow
 * morning", "in 3 hours") into one exact future ISO8601 UTC instant, via a
 * single no-tools Haiku call (mirrors mention-intent.ts) — no regex/keyword
 * date parsing. The model has no clock, so we anchor it to a `now` we pass in.
 *
 * Returns the ISO string, or null if the text isn't a usable time expression
 * (caller surfaces a friendly error). Fail-closed: any hiccup returns null.
 */
import { oneShot } from "../../server/one-shot";

const WHEN_MODEL = process.env.SCHEDULE_WHEN_MODEL || "claude-haiku-4-5";

export async function parseWhen(
  when: string,
  now = new Date(),
): Promise<string | null> {
  const text = (when || "").trim();
  if (!text) return null;

  const system = `You convert a human time expression into one exact future instant, given the current time.

Current time: ${now.toISOString()} (UTC). The server clock is UTC.

Rules:
- Interpret the expression relative to the current time: "in a week" = 7 days later; "tomorrow at 9am" = the next calendar day at 09:00; "in 3 hours" = 3 hours later; "next Tuesday" = the next Tuesday; "+30m" = 30 minutes later.
- Times are UTC unless the user names a timezone — then convert to UTC.
- If a date is given with no time of day, use 09:00 UTC.
- The result must be in the future relative to the current time. If the most natural reading is already past, roll forward to the next sensible occurrence.
- If the text is not a time/date expression at all, return null.

Respond with ONLY a JSON object: {"iso": "<ISO8601 UTC, e.g. 2026-07-06T16:00:00Z>"} or {"iso": null}.`;

  try {
    const resultText = await oneShot(
      `Convert this to an instant:\n\n${text.slice(0, 200)}`,
      { system, model: WHEN_MODEL, label: "parse-when" },
    );
    if (!resultText) return null;
    // Extract the JSON object from the model's reply (same approach as
    // mention-intent.ts) — this is JSON extraction, not date parsing.
    const m = resultText.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const iso = JSON.parse(m[0]).iso;
    if (typeof iso !== "string") return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString();
  } catch (e) {
    console.error("[schedule] when parsing failed:", e);
    return null;
  }
}
