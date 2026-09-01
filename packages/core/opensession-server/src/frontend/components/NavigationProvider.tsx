import type React from "react";
import { NavigationContext } from "../hooks/useNavigation";
import type { NavigationActions } from "../lib/navigation";

export function NavigationProvider({
  actions,
  children,
}: {
  actions: NavigationActions;
  children: React.ReactNode;
}): React.ReactElement {
  return <NavigationContext value={actions}>{children}</NavigationContext>;
}
