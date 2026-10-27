import type { SessionSpeed } from "@tellahq/opensession-protocol/session";
import type { ModelOption, ProviderAccountOption } from "../lib/api";
import { useDefaultModelPreference } from "../hooks/useDefaultModelPreference";
import type { SessionUsage } from "../lib/types";
import { ModelEffortSelect } from "./ModelEffortSelect";

/**
 * Full-width model control for session info. It deliberately delegates the
 * popup to ModelEffortSelect so this surface and the composer expose the same
 * usage, model, effort, speed, account, and reset options.
 */
export function ModelMenuRow({
  models,
  model,
  defaultModel,
  onChange,
  prettyLabel,
  effort,
  onEffortChange,
  autoFallback,
  onAutoFallbackChange,
  speed,
  onSpeedChange,
  accounts,
  accountId,
  onAccountChange,
  usage,
  variant = "menu-row",
}: {
  models: ModelOption[];
  /** Current model id; "" = follow the default. */
  model: string;
  defaultModel: string;
  onChange: (model: string) => void;
  /** Fallback label when a model id isn't in `models` yet. */
  prettyLabel: (id: string) => string;
  effort: string;
  onEffortChange: (effort: string) => void;
  autoFallback?: boolean;
  onAutoFallbackChange?: (enabled: boolean) => void;
  speed: SessionSpeed;
  onSpeedChange: (speed: SessionSpeed) => void;
  accounts: ProviderAccountOption[];
  accountId: string;
  onAccountChange: (accountId: string) => void;
  usage?: SessionUsage;
  variant?: "menu-row" | "hero";
}) {
  const {
    preferredDefaultModel,
    preferredDefaultEffort,
    setPreferredDefaultModel,
  } = useDefaultModelPreference();

  return (
    <ModelEffortSelect
      selection={{
        models,
        defaultModel,
        model,
        preferredDefaultModel,
        preferredDefaultEffort,
        effort,
        autoFallback,
        speed,
        accounts,
        accountId,
        usage,
      }}
      appearance={{
        triggerVariant: variant,
        title: "Model and reasoning effort for this session",
        fallbackModelLabel: prettyLabel,
        showUsage: true,
      }}
      actions={{
        changeModel: onChange,
        setAsDefault: setPreferredDefaultModel,
        changeEffort: onEffortChange,
        changeAutoFallback: onAutoFallbackChange,
        changeSpeed: onSpeedChange,
        changeAccount: onAccountChange,
      }}
    />
  );
}
