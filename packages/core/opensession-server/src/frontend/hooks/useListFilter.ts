import { useNewLayoutPref } from "../lib/new-layout-pref";
import type { Place } from "../lib/new-layout-place";
import { filterForPlace, type FilterState } from "../lib/sidebar-filter";
import { useIsPhone } from "./useIsPhone";

/**
 * The lens the sidebar's session list is queried with. The new layout, shown
 * on desktop only (AppSidebar), pins its Sessions place to your own list.
 */
export function useListFilter(filter: FilterState, place: Place): FilterState {
  const newLayout = useNewLayoutPref();
  const phone = useIsPhone();
  return filterForPlace(filter, newLayout && !phone ? place : undefined);
}
