// Open Session element picker — injected on demand into the inspected page
// (isolated world). Hover highlights the element under the cursor; click
// selects it, Escape cancels. On select the element is tagged with a
// data-os1-picked attribute (so a follow-up MAIN-world script can find the
// same node and walk its React fiber — isolated worlds can't see page-JS
// expandos like __reactFiber$*), its DOM shape is summarized, and the result
// is sent back over chrome.runtime messaging to the side panel.

(() => {
  if (window.__os1PickerActive) return;
  window.__os1PickerActive = true;

  const Z = 2147483647;
  const box = document.createElement("div");
  box.style.cssText =
    `position:fixed;z-index:${Z};pointer-events:none;` +
    "border:2px solid #6c8cff;background:rgba(108,140,255,0.15);" +
    "border-radius:3px;transition:all 40ms linear;display:none;";
  const label = document.createElement("div");
  label.style.cssText =
    `position:fixed;z-index:${Z};pointer-events:none;` +
    "background:#1b1e2e;color:#dfe4ff;font:12px/1.6 ui-monospace,monospace;" +
    "padding:1px 7px;border-radius:4px;border:1px solid #6c8cff;display:none;" +
    "max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const hint = document.createElement("div");
  hint.textContent = "Click an element to capture it · Esc to cancel";
  hint.style.cssText =
    `position:fixed;z-index:${Z};pointer-events:none;` +
    "top:12px;left:50%;transform:translateX(-50%);background:#1b1e2e;" +
    "color:#dfe4ff;font:12.5px system-ui;padding:6px 14px;border-radius:999px;" +
    "border:1px solid #444a66;box-shadow:0 4px 16px rgba(0,0,0,0.4);";
  document.documentElement.append(box, label, hint);

  let current = null;

  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === "string" ? el.className : "";
    for (const c of cls.split(/\s+/).filter(Boolean).slice(0, 3)) s += `.${c}`;
    return s;
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label || el === hint || el === current)
      return;
    current = el;
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    label.style.display = "block";
    label.textContent = describe(el);
    label.style.left = `${Math.max(4, r.left)}px`;
    label.style.top = `${r.top > 28 ? r.top - 24 : r.bottom + 4}px`;
  };

  const cleanup = () => {
    window.__os1PickerActive = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    label.remove();
    hint.remove();
  };

  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onClick = (e) => {
    swallow(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label || el === hint) return;
    // DOM path: element plus a few ancestors, innermost first.
    const path = [];
    let n = el;
    while (n && n.nodeType === 1 && path.length < 8) {
      path.push(describe(n));
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    el.setAttribute("data-os1-picked", "1");
    const info = {
      dom: describe(el),
      domPath: path.join(" ← "),
      text: (el.innerText || "").trim().slice(0, 300),
      rect: {
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        dpr: window.devicePixelRatio || 1,
      },
      aria:
        el.getAttribute("aria-label") ||
        el.getAttribute("role") ||
        el.getAttribute("data-testid") ||
        "",
    };
    cleanup();
    chrome.runtime.sendMessage({ type: "os1PickerResult", ok: true, info });
  };

  const onKey = (e) => {
    if (e.key !== "Escape") return;
    swallow(e);
    cleanup();
    chrome.runtime.sendMessage({ type: "os1PickerResult", ok: false });
  };

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", onKey, true);
})();
