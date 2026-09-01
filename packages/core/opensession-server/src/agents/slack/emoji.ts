/**
 * Slack emoji rendering: shortcode → character/image.
 *
 * Standard emoji come from emoji-datasource (iamcal/emoji-data — the dataset
 * Slack itself uses, so short names like :face_with_rolling_eyes: and
 * :skin-tone-3: match exactly). Custom workspace emoji come from emoji.list,
 * cached an hour; aliases resolve through the map. Skin-tone modifiers need
 * no special casing — :wave::skin-tone-3: replaces token-by-token and the
 * modifier codepoint combines with the preceding base glyph.
 */
import emojiData from "emoji-datasource";
import { slackApiGet } from "./slack-api";

let standardMap: Map<string, string> | null = null;

function unifiedToChar(unified: string): string {
  return String.fromCodePoint(
    ...unified.split("-").map((h) => parseInt(h, 16)),
  );
}

/** Slack short name → unicode character ("thumbsup" → 👍). */
export function standardEmoji(name: string): string | undefined {
  if (!standardMap) {
    standardMap = new Map();
    for (const e of emojiData as any[]) {
      for (const n of e.short_names || []) {
        standardMap.set(n, unifiedToChar(e.unified));
      }
    }
  }
  return standardMap.get(name);
}

const CUSTOM_TTL_MS = 60 * 60 * 1000;
let customCache: { at: number; map: Map<string, string> } | null = null;

/**
 * Custom workspace emoji: name → image URL. Cached; resolves alias chains
 * (emoji.list values like "alias:partyparrot"). Empty map on API failure
 * (e.g. a token without emoji:read) — rendering degrades to the :code:.
 */
export async function customEmojiMap(
  token?: string,
): Promise<Map<string, string>> {
  if (customCache && Date.now() - customCache.at < CUSTOM_TTL_MS) {
    return customCache.map;
  }
  const map = new Map<string, string>();
  try {
    const data = await slackApiGet("emoji.list", {}, token);
    if (data?.ok && data.emoji) {
      const raw: Record<string, string> = data.emoji;
      const resolve = (name: string, depth = 0): string | undefined => {
        const v = raw[name];
        if (!v) return undefined;
        if (v.startsWith("alias:")) {
          if (depth > 3) return undefined;
          const target = v.slice("alias:".length);
          // Alias to a standard emoji has no image; the caller falls
          // back to standardEmoji for those.
          return resolve(target, depth + 1);
        }
        return v;
      };
      for (const name of Object.keys(raw)) {
        const url = resolve(name);
        if (url) map.set(name, url);
      }
    }
  } catch {}
  // Cache failures too — a scope-less token should not retry every message.
  customCache = { at: Date.now(), map };
  return map;
}

const EMOJI_CODE_RE = /:([a-z0-9_+\-']+):/g;

/**
 * Replace :shortcode: tokens: standard → unicode char, custom → an inline
 * image token `![:name:](url)` (the Conversation pane renders those as
 * <img>), unknown → left as typed. Alias-to-standard custom names (raw value
 * "alias:tada") resolve through standardEmoji by name when no URL exists.
 */
export function emojifySlackText(
  text: string,
  custom: Map<string, string>,
): string {
  return text.replace(EMOJI_CODE_RE, (whole, name: string) => {
    const std = standardEmoji(name);
    if (std) return std;
    const url = custom.get(name);
    if (url) return `![:${name}:](${url})`;
    return whole;
  });
}

/** A reaction's display form: unicode char, image URL, or neither (raw name). */
export function reactionDisplay(
  name: string,
  custom: Map<string, string>,
): { emoji?: string; url?: string } {
  // Reaction names can carry a skin tone ("thumbsup::skin-tone-2").
  const [base, ...mods] = name.split("::");
  const baseChar = standardEmoji(base);
  if (baseChar) {
    const modChars = mods.map((m) => standardEmoji(m) || "").join("");
    return { emoji: baseChar + modChars };
  }
  const url = custom.get(base);
  return url ? { url } : {};
}
