// Pure helpers for the "Send messages with" preference: key-combo matching
// and platform-aware labels. Deliberately side-effect-free (unit-tested) —
// the stored per-user preference itself lives in lib/send-key-pref.

import { isApple, isTouchPrimary } from "./platform";

export type SendKeyPref = "enter" | "mod-enter";

/** Platform-aware display label for the modifier combo ("⌘ Enter" / "Ctrl Enter"). */
export const MOD_ENTER_LABEL = isApple ? "⌘ Enter" : "Ctrl Enter";

/** Compact glyph form for inline hints ("⌘↩" / "Ctrl ↩"). */
export const MOD_ENTER_GLYPH = isApple ? "⌘↩" : "Ctrl ↩";

export function sendKeyLabel(pref: SendKeyPref): string {
  return pref === "mod-enter" ? MOD_ENTER_LABEL : "Enter";
}

/**
 * True when the caret sits inside an unclosed ``` fence. Plain Enter has to
 * insert a newline there instead of sending — otherwise a multi-line code
 * block can't be typed at all. Closing the fence sends as usual.
 */
export function insideOpenFence(text: string, caret: number): boolean {
  const fences = text.slice(0, caret).match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

/**
 * The send key a client can actually offer. "Enter sends" is a bargain with
 * Shift+Enter, and a soft keyboard has no Shift+Enter to give: on a phone it
 * would leave no way to type a second line at all. Touch clients therefore
 * keep the return key for newlines and send from the button, while
 * ⌘/Ctrl+Enter still sends for anyone with a keyboard attached. The native
 * app's composer already behaves this way, so the two clients agree.
 *
 * The stored preference is untouched: it is the answer for real keyboards,
 * and the same account keeps Enter-to-send on the desktop.
 */
export function effectiveSendKey(
  pref: SendKeyPref,
  touch: boolean = isTouchPrimary,
): SendKeyPref {
  return touch ? "mod-enter" : pref;
}

/** True when this keydown should send under the given preference. */
export function isSendCombo(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  pref: SendKeyPref,
): boolean {
  if (e.key !== "Enter") return false;
  if (pref === "mod-enter") return e.metaKey || e.ctrlKey;
  return !e.shiftKey;
}
