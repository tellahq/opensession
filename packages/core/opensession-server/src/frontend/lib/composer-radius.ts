/**
 * The expanded box's resting corner, resolved from `--composer-radius` in
 * legacy.css. Motion writes `borderRadius` inline to morph between the phone's
 * resting pill and the expanded box, so the number has to exist in JS — but it
 * shouldn't be a SECOND copy of the token (the old inline `32` had drifted
 * from the stylesheet's own value, and the phone breakpoint restated a third).
 * Read through a throwaway element rather than `getPropertyValue`: an
 * unregistered custom property computes to its token stream, so we'd get the
 * literal `calc(18px * 1.35)` instead of a length. `--rf` is a `@supports`
 * switch, so the answer can't change within a page's life — resolve it once.
 */
let composerRadiusPx: number | null = null;

export function composerRadius(): number {
  if (composerRadiusPx !== null) return composerRadiusPx;
  if (typeof document === "undefined") return 24;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;width:100px;height:100px;border-radius:var(--composer-radius)";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).borderTopLeftRadius);
  probe.remove();
  composerRadiusPx = Number.isFinite(px) && px > 0 ? px : 24;
  return composerRadiusPx;
}
