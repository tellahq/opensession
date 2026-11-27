import { useState } from "react";
import { avatarUrl, type Provider } from "../../lib/provider";
import { reviewerVerdict } from "../../lib/review-lines";
import type { PrFile, PrReviewer } from "../../lib/types";
import { IconCheck, IconClock, IconFile, IconMessage, IconX } from "../icons";

export function ReviewerRow({
  reviewer,
  provider,
}: {
  reviewer: PrReviewer;
  provider: Provider;
}) {
  const src = reviewer.isTeam ? null : avatarUrl(reviewer.login, provider, 40);
  // Offline or rate-limited avatars fall back to the initial, not a broken image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const meta = reviewerStateMeta(reviewer.state);
  const toneClass =
    meta.tone === "green"
      ? "text-green"
      : meta.tone === "red"
        ? "text-red"
        : meta.tone === "yellow"
          ? "text-yellow"
          : "text-faint";
  return (
    <div className="flex items-center gap-3 rounded-control border border-transparent px-1.5 py-1.5 hover:border-line hover:bg-hover/50">
      {src && failedSrc !== src ? (
        <img
          className="size-7 rounded-full object-cover"
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span
          className="inline-flex size-7 items-center justify-center rounded-full border border-line bg-surface text-meta font-semibold text-faint"
          aria-hidden
        >
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-fg">
        {reviewer.login}
      </span>
      <span className={`shrink-0 ${toneClass}`} title={meta.label}>
        {meta.icon}
      </span>
    </div>
  );
}

export function reviewerStateMeta(state: PrReviewer["state"]) {
  switch (state) {
    case "APPROVED":
      return { ...reviewerVerdict(state), icon: <IconCheck size={20} /> };
    case "CHANGES_REQUESTED":
      return { ...reviewerVerdict(state), icon: <IconX size={20} /> };
    case "COMMENTED":
      return { ...reviewerVerdict(state), icon: <IconMessage size={20} /> };
    default:
      return { ...reviewerVerdict(state), icon: <IconClock size={20} /> };
  }
}

/**
 * One changed file, sized for a narrow column: the file name and its diff
 * counts, with the full path on hover.
 *
 * The directory is deliberately absent. A path truncated to fit a 264px rail
 * leaves every row reading `packages/core/webapp/…`, which is the half that
 * tells you nothing, and the name is what a reviewer scans for. The whole path
 * is a click away, on the file's own diff header.
 */
export function FileRow({
  file,
  onClick,
}: {
  file: PrFile;
  onClick?: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-control border border-transparent px-1.5 py-1 text-left hover:border-line hover:bg-hover/50 disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent"
      onClick={onClick}
      disabled={!onClick}
      title={file.path}
    >
      <IconFile size={20} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate text-label text-fg">{base}</span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-meta">
        {file.additions > 0 && (
          <span className="text-green">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-red">−{file.deletions}</span>
        )}
      </span>
    </button>
  );
}
