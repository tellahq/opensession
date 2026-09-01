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
  fastMode,
  onFastModeChange,
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
  fastMode: boolean;
  onFastModeChange: (fastMode: boolean) => void;
  accounts: ProviderAccountOption[];
  accountId: string;
  onAccountChange: (accountId: string) => void;
  usage?: SessionUsage;
  variant?: "menu-row" | "hero";
}) {
  const { preferredDefaultModel, setPreferredDefaultModel } =
    useDefaultModelPreference();

  return (
    <ModelEffortSelect
      selection={{
        models,
        defaultModel,
        model,
        preferredDefaultModel,
        effort,
        fastMode,
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
        changeFastMode: onFastModeChange,
        changeAccount: onAccountChange,
      }}
    />
  );
}
