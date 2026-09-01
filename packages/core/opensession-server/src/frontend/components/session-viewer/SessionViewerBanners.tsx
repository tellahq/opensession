import type { UnifiedSession } from "../../lib/types";
import { SESSION_BANNERS } from "../../lib/session-viewer-classes";

interface SessionViewerBannersProps {
  goal: UnifiedSession["goal"];
  loop: UnifiedSession["loop"];
}

export function SessionViewerBanners({
  goal,
  loop,
}: SessionViewerBannersProps) {
  if (!goal && !loop) return null;

  return (
    <div className={SESSION_BANNERS}>
      {goal && (
        <span
          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
          title="Cleared with /goal clear"
        >
          🎯 {goal}
        </span>
      )}
      {loop && (
        <span
          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
          title={`"${loop.prompt}" · stop with /loop stop`}
        >
          ⟳ every {loop.intervalMinutes}m · {loop.prompt.slice(0, 60)}
          {loop.prompt.length > 60 ? "…" : ""}
        </span>
      )}
    </div>
  );
}
