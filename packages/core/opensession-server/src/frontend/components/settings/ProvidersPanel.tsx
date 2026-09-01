import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { ModelDefaultsSection } from "../Models";
import { ModelProvidersPanel } from "../ModelProviders";
import { WorkspaceModelPresetSettings } from "../WorkspaceModelPresets";
import type { Workspace } from "../../lib/types";
import { ProviderAccountsSection } from "./ModelAccounts";

/** Providers: everything behind the model a run uses. Which model it starts
 * on, the subscription accounts it draws from and how close each one is to its
 * limit, and any provider someone brought a key for.
 *
 * The account meters used to be a page of their own (Settings → Usage) on the
 * grounds that they move hourly while a default model is set once. They are
 * back here because the answer to "this pool is spent" is on this page too:
 * connect another account, or start runs on a different model. */
export function ProvidersPanel({ workspace }: { workspace?: Workspace }) {
  return (
    <SettingsPanel>
      <SettingsHeader title="Providers" />
      <ModelDefaultsSection />
      <WorkspaceModelPresetSettings workspace={workspace} />
      {/* The pool those models run on, and how full each account is. */}
      <ProviderAccountsSection />
      {/* Last: one row per model, Auto on all of them until someone pins
			    one, so it sits below everything people came here to read. */}
      <ModelProvidersPanel />
    </SettingsPanel>
  );
}
