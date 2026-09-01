import React, { use } from "react";
import type { NavigationActions } from "../lib/navigation";

export const NavigationContext: React.Context<NavigationActions | null> =
  React.createContext<NavigationActions | null>(null);

export function useNavigation(): NavigationActions {
  const actions = use(NavigationContext);
  if (!actions) {
    throw new Error("useNavigation must be used within NavigationProvider");
  }
  return actions;
}
