/**
 * Controls on a rendered code fence: copy, plus per-block display settings.
 *
 * Built as DOM rather than JSX for the same reason the mermaid expand button
 * is (MarkdownBody.tsx): a markdown body is injected as an innerHTML string,
 * so there is no element for React to own. The controls are siblings of the
 * <pre>, keeping them fixed while an unwrapped block scrolls sideways and
 * keeping their labels out of copied code.
 */

import {
  checkIconMarkup,
  copyIconMarkup,
  slidersIconMarkup,
} from "../components/icons";
import { copyToClipboard } from "./share-link";

const WRAP_CLASS = "md-code-wrap";
const CONTROLS_CLASS = "md-code-controls";
const COPY_BUTTON_CLASS = "md-code-copy";
const SETTINGS_BUTTON_CLASS = "md-code-settings-trigger";
const SETTINGS_PANEL_CLASS = "md-code-settings";
const WRAP_BUTTON_CLASS = "md-code-wrap-toggle";
const COPY_LABEL = "Copy code";
const COPIED_LABEL = "Copied";
const SETTINGS_LABEL = "Code block settings";
/** How long the check stays before the copy glyph comes back. */
const COPIED_MS = 1600;

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let settingsId = 0;

/**
 * The block's text as it is laid out. `innerText` rather than `textContent`:
 * shiki wraps every line in its own `<span class="line">` and does not
 * reliably leave a newline between them, so textContent can hand back a
 * forty-line block as one unbroken line. Layout is what knows where the
 * breaks are.
 */
function codeText(pre: HTMLElement): string {
  const text = pre.innerText || pre.textContent || "";
  // A fence always ends in a newline the author did not type.
  return text.replace(/\n+$/, "");
}

function flashCopied(button: HTMLElement): void {
  const running = flashTimers.get(button);
  if (running) clearTimeout(running);
  button.dataset.copied = "";
  button.title = COPIED_LABEL;
  button.setAttribute("aria-label", COPIED_LABEL);
  flashTimers.set(
    button,
    setTimeout(() => {
      delete button.dataset.copied;
      button.title = COPY_LABEL;
      button.setAttribute("aria-label", COPY_LABEL);
      flashTimers.delete(button);
    }, COPIED_MS),
  );
}

function setSettingsOpen(trigger: HTMLElement, open: boolean): void {
  const panelId = trigger.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) return;
  panel.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  trigger.toggleAttribute("data-open", open);
}

function closeSettings(except?: HTMLElement): void {
  for (const trigger of Array.from(
    document.querySelectorAll<HTMLElement>(
      `.${SETTINGS_BUTTON_CLASS}[aria-expanded="true"]`,
    ),
  )) {
    if (trigger !== except) setSettingsOpen(trigger, false);
  }
}

/**
 * Give every code fence under `root` its controls. Idempotent: a fence that
 * already sits in a wrapper is left alone, so this can run again after a
 * re-render without stacking controls.
 */
export function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.parentElement?.classList.contains(WRAP_CLASS)) continue;
    // A ```mermaid fence is on its way to becoming a diagram (MarkdownBody
    // upgrades it asynchronously, after this has run). Its source is not
    // what anyone wants on the clipboard, and the diagram that replaces it
    // carries its own control.
    if (pre.querySelector('code[class*="language-mermaid"]')) continue;
    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;
    wrap.dataset.wrapped = "true";

    const controls = document.createElement("div");
    controls.className = CONTROLS_CLASS;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = COPY_BUTTON_CLASS;
    copyButton.title = COPY_LABEL;
    copyButton.setAttribute("aria-label", COPY_LABEL);
    // Both glyphs are always in the DOM, stacked in one grid cell, so the
    // swap to the check has no layout in it and cannot shift the button.
    copyButton.innerHTML =
      `<span class="md-code-copy-glyph" data-state="idle">${copyIconMarkup()}</span>` +
      `<span class="md-code-copy-glyph" data-state="done">${checkIconMarkup()}</span>`;

    const panelId = `md-code-settings-${++settingsId}`;
    const titleId = `${panelId}-title`;
    const descriptionId = `${panelId}-description`;

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = SETTINGS_BUTTON_CLASS;
    settingsButton.title = SETTINGS_LABEL;
    settingsButton.setAttribute("aria-label", SETTINGS_LABEL);
    settingsButton.setAttribute("aria-haspopup", "dialog");
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.setAttribute("aria-controls", panelId);
    settingsButton.innerHTML = slidersIconMarkup();

    const settings = document.createElement("div");
    settings.id = panelId;
    settings.className = SETTINGS_PANEL_CLASS;
    settings.setAttribute("role", "dialog");
    settings.setAttribute("aria-labelledby", titleId);
    settings.hidden = true;
    settings.innerHTML =
      `<div class="md-code-settings-copy">` +
      `<div class="md-code-settings-title" id="${titleId}">Code wrapping</div>` +
      `<div class="md-code-settings-description" id="${descriptionId}">Wrap long lines to fit this code block.</div>` +
      `</div>`;

    const wrapButton = document.createElement("button");
    wrapButton.type = "button";
    wrapButton.className = WRAP_BUTTON_CLASS;
    wrapButton.title = "Turn off code wrapping";
    wrapButton.setAttribute("role", "switch");
    wrapButton.setAttribute("aria-labelledby", titleId);
    wrapButton.setAttribute("aria-describedby", descriptionId);
    wrapButton.setAttribute("aria-checked", "true");
    settings.append(wrapButton);

    pre.replaceWith(wrap);
    controls.append(copyButton, settingsButton, settings);
    wrap.append(pre, controls);
  }
}

/**
 * Listen for code-control clicks under `root`. Delegated because the buttons
 * are created and destroyed by innerHTML rewrites; real buttons also turn
 * keyboard Enter and Space into the same click, so this is the whole primary
 * interaction. Returns the detach function.
 */
export function attachCodeCopy(root: HTMLElement): () => void {
  function onClick(e: MouseEvent) {
    if (!(e.target instanceof Element)) return;
    const target = e.target;
    const settingsButton = target.closest(`button.${SETTINGS_BUTTON_CLASS}`);
    if (
      settingsButton instanceof HTMLElement &&
      root.contains(settingsButton)
    ) {
      const opening = settingsButton.getAttribute("aria-expanded") !== "true";
      closeSettings(opening ? settingsButton : undefined);
      setSettingsOpen(settingsButton, opening);
      e.preventDefault();
      return;
    }

    const wrapButton = target.closest(`button.${WRAP_BUTTON_CLASS}`);
    if (wrapButton instanceof HTMLElement && root.contains(wrapButton)) {
      const wrap = wrapButton.closest(`.${WRAP_CLASS}`);
      if (!(wrap instanceof HTMLElement)) return;
      const wrapped = wrap.dataset.wrapped !== "false";
      wrap.dataset.wrapped = String(!wrapped);
      wrapButton.setAttribute("aria-checked", String(!wrapped));
      wrapButton.title = wrapped
        ? "Turn on code wrapping"
        : "Turn off code wrapping";
      e.preventDefault();
      return;
    }

    const copyButton = target.closest(`button.${COPY_BUTTON_CLASS}`);
    if (!(copyButton instanceof HTMLElement) || !root.contains(copyButton))
      return;
    const pre = copyButton
      .closest(`.${WRAP_CLASS}`)
      ?.querySelector<HTMLElement>("pre");
    if (!pre) return;
    e.preventDefault();
    copyToClipboard(codeText(pre), () => flashCopied(copyButton));
  }

  function onPointerDown(e: PointerEvent) {
    if (!(e.target instanceof Element)) return;
    const target = e.target;
    if (
      target.closest(`.${SETTINGS_PANEL_CLASS}`) ||
      target.closest(`.${SETTINGS_BUTTON_CLASS}`)
    )
      return;
    closeSettings();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    const trigger = document.querySelector<HTMLElement>(
      `.${SETTINGS_BUTTON_CLASS}[aria-expanded="true"]`,
    );
    if (!trigger) return;
    setSettingsOpen(trigger, false);
    trigger.focus();
    e.preventDefault();
  }

  root.addEventListener("click", onClick);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  return () => {
    root.removeEventListener("click", onClick);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
  };
}
