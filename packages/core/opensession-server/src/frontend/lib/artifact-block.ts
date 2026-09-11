/**
 * The cheap half of an artifact block: which fences are artifacts. Building
 * the sandboxed frame (artifact-frame.ts) is imported when a body carries
 * one, the way a diagram's renderer is. What goes into the frame and what
 * keeps it there is in artifact-document.ts; see that file for the sandbox
 * and the policy.
 */

import type { FenceUpgrader } from "./fence-upgraders";

let framePromise: Promise<typeof import("./artifact-frame")> | null = null;
function loadFrame() {
  framePromise ??= import("./artifact-frame");
  return framePromise;
}

/**
 * The block keeps the fence's <pre> beside the frame for its Source view,
 * so the copy and wrap controls stay: what they copy is the artifact's own
 * source, which is what anyone asking for it wants.
 */
export const artifactUpgrader: FenceUpgrader = {
  langs: ["artifact", "svg"],
  keepsCodeControls: true,
  async upgrade({ pre, source, lang, root, alive }) {
    const m = await loadFrame().catch(() => null);
    if (!m || !alive() || !root.contains(pre)) return false;
    if (!source.trim()) return false;
    m.mountArtifactBlock(pre, source, lang);
    return true;
  },
};
