import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type * as React from "react";
import { cn } from "./cn";

/**
 * Underline tabs: the pages of one object (a pull request's Overview and
 * Files changed), drawn the way GitHub draws them. A word with an optional
 * count, and a bar under the page you are on that slides to the next one.
 *
 * Use it for page navigation that sits on a divider line. A short exclusive
 * setting stays a `Segmented`; this is a place you go, not a value you set.
 *
 * Built on Base UI's Tabs, so arrow keys move between tabs and the list is
 * one tab stop. It renders no panels: the caller swaps the page itself.
 */
function Root({
  value,
  onValueChange,
  label,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={onValueChange}
      className={cn("flex min-w-0 items-stretch", className)}
    >
      <BaseTabs.List
        aria-label={label}
        className="relative flex min-w-0 items-stretch gap-1"
      >
        {children}
        <BaseTabs.Indicator className="absolute bottom-0 left-[var(--active-tab-left)] h-0.5 w-[var(--active-tab-width)] rounded-[999px] bg-accent transition-[left,width] duration-200 ease-out motion-reduce:transition-none" />
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}

function Tab({
  value,
  icon,
  count,
  children,
}: {
  value: string;
  icon?: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Tab
      value={value}
      className="group/tab focus-ring flex shrink-0 cursor-pointer items-center rounded-control border-0 bg-transparent px-0 py-0 text-label text-dim data-[active]:font-semibold data-[active]:text-fg"
    >
      {/* The wash sits on an inner plate so the underline keeps the row's
          full height under it. */}
      <span className="flex items-center gap-1.5 rounded-control px-2 py-1 transition-colors group-hover/tab:bg-hover group-hover/tab:text-fg">
        {icon && (
          <span className="inline-flex shrink-0 text-faint group-data-[active]/tab:text-dim">
            {icon}
          </span>
        )}
        {children}
        {count !== undefined && (
          <span className="rounded-[999px] bg-hover px-1.5 text-meta font-medium text-dim tabular-nums">
            {count}
          </span>
        )}
      </span>
    </BaseTabs.Tab>
  );
}

export const UnderlineTabs = { Root, Tab };
