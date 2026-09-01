// Raising the on-screen keyboard for a field that does not exist yet.
//
// iOS only opens the keyboard for a focus() that happens inside the task the
// tap started. Tapping the sidebar's + mounts a dialog, and Base UI moves
// focus to its `initialFocus` a frame later, which is already outside that
// task: the palette opens with a caret and no keyboard, and the person has to
// tap the prompt as well.
//
// So the tap focuses a stand-in field synchronously, which is what actually
// raises the keyboard, and the real prompt takes focus from it as soon as it
// mounts. A hand-off between two text fields keeps the keyboard up.

import { isTouchPrimary } from "./platform";

let primer: HTMLTextAreaElement | null = null;
let safety: ReturnType<typeof setTimeout> | null = null;

function remove() {
  if (safety) clearTimeout(safety);
  safety = null;
  primer?.remove();
  primer = null;
}

/** Call synchronously from the tap that opens a surface whose text field
 *  mounts later. No-op with a real keyboard. */
export function primeSoftKeyboard() {
  if (!isTouchPrimary || primer) return;
  const el = document.createElement("textarea");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // 16px: anything smaller makes iOS zoom the page on focus. The rest keeps
  // it out of sight and out of the layout.
  el.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;background:transparent;caret-color:transparent;";
  document.body.appendChild(el);
  primer = el;
  el.focus({ preventScroll: true });
  // If the surface never arrives, don't leave a focused field behind.
  safety = setTimeout(() => {
    if (primer && document.activeElement === primer) primer.blur();
    remove();
  }, 2000);
}

/** Hand the keyboard to the real field as soon as it exists. The field can be
 *  a frame or two behind the effect that asks for it (a dialog mounts its popup
 *  after the trap is installed), so this waits for it rather than giving up on
 *  the first null. Focus moves before the stand-in is removed: dropping a
 *  focused field is what closes the keyboard again. */
export function handOffSoftKeyboard(get: () => HTMLElement | null) {
  if (!primer) return;
  let frames = 0;
  const step = () => {
    if (!primer) return;
    const el = get();
    if (el) {
      el.focus({ preventScroll: true });
      remove();
      return;
    }
    if (frames++ > 30) return; // the safety timer clears the stand-in
    requestAnimationFrame(step);
  };
  step();
}
