import { AnimatePresence, motion } from "motion/react";
import type { ModelOption, ProviderAccountOption } from "../../lib/api";
import {
  composerToolbarPill,
  composerToolbarSelect,
} from "../../lib/composer-classes";
import { palettePill } from "../../lib/palette-classes";
import type { SessionUsage } from "../../lib/types";
import { cn } from "../../ui/cn";
import { composerChipMotion } from "../../ui/motion";
import { ModelEffortSelect } from "../ModelEffortSelect";

interface ModelRowProps {
  minimized: boolean;
  models: ModelOption[];
  defaultModel: string;
  model: string;
  onModelChange: (model: string) => void;
  preferredDefaultModel: string;
  onSetAsDefault: (model: string) => void;
  modelDisabled?: boolean;
  modelTitle?: string;
  effort?: string;
  onEffortChange?: (effort: string) => void;
  fastMode?: boolean;
  onFastModeChange?: (fastMode: boolean) => void;
  accounts?: ProviderAccountOption[];
  accountId?: string;
  onAccountChange?: (accountId: string) => void;
  usage?: SessionUsage;
  disabled?: boolean;
  effortDownLabel: string | null;
  effortUpLabel: string | null;
  onOpenChange: (open: boolean) => void;
}

export function ModelRow({
  minimized,
  models,
  defaultModel,
  model,
  onModelChange,
  preferredDefaultModel,
  onSetAsDefault,
  modelDisabled,
  modelTitle,
  effort,
  onEffortChange,
  fastMode,
  onFastModeChange,
  accounts,
  accountId,
  onAccountChange,
  usage,
  disabled,
  effortDownLabel,
  effortUpLabel,
  onOpenChange,
}: ModelRowProps) {
  return (
    <AnimatePresence initial={false}>
      {!minimized && (
        <motion.div
          key="model-effort"
          layout="position"
          {...composerChipMotion}
          className={composerToolbarSelect}
        >
          <ModelEffortSelect
            selection={{
              models,
              defaultModel,
              model,
              preferredDefaultModel,
              modelDisabled,
              modelTitle,
              effort,
              fastMode,
              accounts,
              accountId,
              usage,
            }}
            appearance={{
              className: cn(palettePill, composerToolbarPill),
              // The pill is where the effort chords are worth naming: they
              // step what it displays. Appended to the native title the
              // trigger already carries, so a reader who hovers the thing
              // they would otherwise click finds them.
              title:
                (modelTitle || "Model and reasoning effort for this session") +
                (effortDownLabel && effortUpLabel
                  ? `\n${effortDownLabel} / ${effortUpLabel} steps the effort`
                  : ""),
              showUsage: true,
              disabled,
            }}
            actions={{
              changeModel: onModelChange,
              setAsDefault: onSetAsDefault,
              changeEffort: onEffortChange,
              changeFastMode: onFastModeChange,
              changeAccount: onAccountChange,
              changeOpen: onOpenChange,
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
