import type { ReactNode } from "react";
import { TopBar, TopBarActions, TopBarBack, TopBarTitle } from "../ui/top-bar";

/**
 * The shared top bar for a page one level deeper than the workspace panel's
 * overview. It stays above the panel's own sticky tabs and file headers.
 */
export function PanelPageHeader({
  title,
  onBack,
  trailing,
}: {
  title: string;
  onBack: () => void;
  trailing?: ReactNode;
}) {
  return (
    <TopBar
      as="header"
      className="sticky top-0 z-3 gap-1 bg-panel-surface px-2 pt-3 pb-2"
    >
      <TopBarBack
        onClick={onBack}
        aria-label="Back to workspace"
        iconSize={20}
        className="shrink-0 rounded-control text-dim hover:bg-hover hover:text-fg"
      />
      <TopBarTitle className="flex-1 truncate text-supporting font-semibold text-fg">
        {title}
      </TopBarTitle>
      {trailing && <TopBarActions>{trailing}</TopBarActions>}
    </TopBar>
  );
}
