import type { ModelOption, ProviderAccountOption } from "./api";
import type { SessionUsage } from "./types";

export interface ModelEffortSelection {
  models: ModelOption[];
  defaultModel: string;
  /** Current model id; "" = default. */
  model: string;
  /** This person's preferred model for new sessions. */
  preferredDefaultModel?: string;
  /** Model is set elsewhere (e.g. Slack-owned sessions) — effort stays switchable. */
  modelDisabled?: boolean;
  modelTitle?: string;
  /** When effort isn't wired, the menu is just the model list. */
  effort?: string;
  fastMode?: boolean;
  /**
   * Pinnable provider accounts. The menu filters these to the active model's
   * Claude or Codex pool; "" = auto (personal-first, pool fallback).
   */
  accounts?: ProviderAccountOption[];
  /** Pinned account id; "" / undefined = auto. */
  accountId?: string;
  /** Conversation usage shown inside this menu; omitted in new-session pickers. */
  usage?: SessionUsage;
}

export interface ModelEffortAppearance {
  showUsage?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** The same menu can sit behind the composer pill, the full-width settings
   * row, or the compact model link below the phone Workspace title. */
  triggerVariant?: "pill" | "menu-row" | "hero";
  /** Label fallback for a model that has not reached the catalog yet. */
  fallbackModelLabel?: (id: string) => string;
}

export interface ModelEffortActions {
  changeModel: (model: string) => void;
  /** Makes the current conversation model this person's default for new sessions. */
  setAsDefault?: (model: string) => void;
  changeEffort?: (effort: string) => void;
  changeFastMode?: (fastMode: boolean) => void;
  changeAccount?: (accountId: string) => void;
  /** Fires as the menu opens/closes. The phone composer needs it: the popup
   * takes focus (blurring the textarea), and the composer must stay expanded
   * while open or this trigger unmounts and the menu closes with it. */
  changeOpen?: (open: boolean) => void;
}

export interface ModelEffortSelectProps {
  selection: ModelEffortSelection;
  appearance?: ModelEffortAppearance;
  actions: ModelEffortActions;
}
