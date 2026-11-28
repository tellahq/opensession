import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { ModelDefaultsSection } from "../Models";
import { ModelProvidersPanel } from "../ModelProviders";
import { ProviderAccountsSection } from "./ModelAccounts";
import { OpenAIKeySection } from "./OpenAIKeySection";

/** Models: which model runs start on, the subscription accounts they draw
 * from, the providers someone brought a key for, and the OpenAI key behind
 * voice and Autocomplete. */
export function ProvidersPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Models"
        description="Which models sessions use, and the accounts behind them."
      />
      <ModelDefaultsSection />
      <ProviderAccountsSection />
      <ModelProvidersPanel />
      <OpenAIKeySection />
    </SettingsPanel>
  );
}
