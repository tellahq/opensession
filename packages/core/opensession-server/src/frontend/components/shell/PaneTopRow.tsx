import { useEffect, type ReactNode } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  NEW_LAYOUT_LIGHTS_ROW_PX,
  PANE_TOP_ROW,
  PANE_TOP_ROW_TABS,
} from "../../lib/app-shell-classes";
import { useNewLayoutPref } from "../../lib/new-layout-pref";
import { os1Shell } from "../../lib/os1-shell";

/**
 * The top of the pane: the page's top bar (`children`) and the session tab
 * strip.
 *
 * By default the strip is a band under the bar. In the new layout the two
 * share one window row, strip first: the tabs are the name of what is open,
 * so the bar keeps only its trailing controls. The strip is rendered here and
 * not portaled into the header, which remounts with every session, so its
 * scroll position and reorder state survive a change of tab.
 *
 * What lays itself out around the strip reads where it is from the
 * `tabStripVisible` prop the pane hands down (TabStripPlacement).
 */
export function PaneTopRow({
  strip,
  children,
}: {
  strip: ReactNode;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const newLayout = useNewLayoutPref() && !isPhone;
  // The desktop shell centres its traffic lights on this row, which is
  // shorter in the new layout (NEW_LAYOUT_ROW_HEIGHT); the old layout's
  // lights stay where a 48px row puts them.
  useEffect(() => {
    os1Shell()?.setTitlebarHeight?.(newLayout ? NEW_LAYOUT_LIGHTS_ROW_PX : 48);
  }, [newLayout]);
  if (!newLayout) {
    return (
      <>
        {children}
        {strip && <div className="shrink-0">{strip}</div>}
      </>
    );
  }
  return (
    <div className={PANE_TOP_ROW} data-pane-top-row>
      {strip && (
        <div className={PANE_TOP_ROW_TABS} data-pane-top-row-tabs>
          {strip}
        </div>
      )}
      {children}
    </div>
  );
}
