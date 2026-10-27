import type { ReactNode } from "react";
import { TopBar } from "../../ui/top-bar";

/** One phone title row; the diff, not repeated workspace chrome, owns the screen.
 *  Trailing actions share one pill, the way GitHub's app groups them. */
export function PhoneReviewHeader({
  title,
  subtitle,
  navigation,
  actions,
}: {
  title: string;
  subtitle: ReactNode;
  navigation: ReactNode;
  actions: ReactNode;
}) {
  return (
    <TopBar as="header" className="min-h-16 shrink-0 gap-2 px-3 py-2">
      {navigation}
      <div className="min-w-0 flex-1 text-center">
        <h1
          className="m-0 truncate text-body font-semibold text-fg"
          title={title}
        >
          {title}
        </h1>
        <div className="truncate text-body text-dim">{subtitle}</div>
      </div>
      <div className="flex shrink-0 items-center rounded-full bg-panel">
        {actions}
      </div>
    </TopBar>
  );
}
