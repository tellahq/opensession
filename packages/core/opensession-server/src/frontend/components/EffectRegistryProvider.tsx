import type { ReactNode } from "react";
import { RegistryProvider } from "@effect/atom-react/RegistryContext";

export function EffectRegistryProvider({ children }: { children: ReactNode }) {
  return <RegistryProvider defaultIdleTTL={400}>{children}</RegistryProvider>;
}
