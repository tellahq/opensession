import { useMemo } from "react";
import { cn } from "../ui/cn";
import { Popover } from "../ui/popover";
import { lineBreakdown } from "../lib/review-groups";

interface DiffStatFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A "+N −M" diffstat that opens a breakdown of those lines by file role
 * (code, tests, docs, config, dependencies, generated) on hover or tap. With
 * one role or no file list it stays plain text, since a single row would
 * only repeat the headline.
 */
export function DiffStat({
  files,
  additions,
  deletions,
  className,
  countClassName,
}: {
  files: readonly DiffStatFile[];
  /** Headline totals. Default to the sum of `files`; pass the provider's
   *  totals when its file list can be partial. */
  additions?: number;
  deletions?: number;
  className?: string;
  countClassName?: string;
}) {
  const totalAdditions =
    additions ?? files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions =
    deletions ?? files.reduce((sum, file) => sum + file.deletions, 0);
  const rows = useMemo(
    () =>
      lineBreakdown(files, {
        additions: totalAdditions,
        deletions: totalDeletions,
      }),
    [files, totalAdditions, totalDeletions],
  );
  const counts = (dotted: boolean) => {
    const dots = dotted
      ? "underline decoration-dotted underline-offset-[3px]"
      : "";
    return (
      <>
        <span className={cn("text-green", countClassName, dots)}>
          +{totalAdditions}
        </span>
        <span className={cn("text-red", countClassName, dots)}>
          −{totalDeletions}
        </span>
      </>
    );
  };
  const wrapper = cn(
    "inline-flex items-center gap-1.5 tabular-nums",
    className,
  );

  if (rows.length < 2) return <span className={wrapper}>{counts(false)}</span>;

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        closeDelay={120}
        aria-label={`${totalAdditions} lines added, ${totalDeletions} removed. Show breakdown by file type`}
        className={cn(
          wrapper,
          "cursor-default rounded-sm border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        )}
      >
        {counts(true)}
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="center"
        aria-label="Lines changed by file type"
        className="min-w-48 px-3.5 py-2.5"
      >
        <table className="w-full border-collapse text-label tabular-nums">
          <tbody>
            {rows.map((row) => (
              <tr key={row.title}>
                <th
                  scope="row"
                  className="py-1 pr-5 text-left font-normal text-dim"
                >
                  {row.title}
                </th>
                <td
                  className={cn(
                    "py-1 pl-3 text-right",
                    row.additions ? "text-green" : "text-faint",
                  )}
                >
                  +{row.additions}
                </td>
                <td
                  className={cn(
                    "py-1 pl-3 text-right",
                    row.deletions ? "text-red" : "text-faint",
                  )}
                >
                  −{row.deletions}
                </td>
              </tr>
            ))}
            <tr className="border-t border-divider">
              <th
                scope="row"
                className="pt-2 pb-0.5 pr-5 text-left font-normal text-dim"
              >
                Total
              </th>
              <td className="pt-2 pb-0.5 pl-3 text-right font-semibold text-green">
                +{totalAdditions}
              </td>
              <td className="pt-2 pb-0.5 pl-3 text-right font-semibold text-red">
                −{totalDeletions}
              </td>
            </tr>
          </tbody>
        </table>
      </Popover.Popup>
    </Popover.Root>
  );
}
