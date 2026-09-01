import { utilityClassName } from "../../ui/cn";
import type { CSSProperties, RefObject } from "react";
import { motion } from "motion/react";
import { composerMorph } from "../../ui/motion";
import { cn } from "../../ui/cn";
import { VoiceInput } from "../VoiceInput";

interface VoiceControlProps {
  minimized: boolean;
  className: string;
  cancelClassName: string;
  shortcutActive: boolean;
  focused: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  overlayTargetRef: RefObject<HTMLDivElement | null>;
  overlayStyle?: CSSProperties;
  onText: (text: string) => void;
  onTextSend: (text: string) => void;
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
}

export function VoiceControl({
  minimized,
  className,
  cancelClassName,
  shortcutActive,
  focused,
  textareaRef,
  overlayTargetRef,
  overlayStyle,
  onText,
  onTextSend,
  onActiveChange,
  disabled,
}: VoiceControlProps) {
  return (
    <motion.div
      layout="position"
      transition={composerMorph}
      layoutDependency={minimized}
      className={cn(
        utilityClassName(
          "pwa-composer-dictation inline-flex shrink-0 items-center",
        ),
        minimized && utilityClassName("order-3"),
      )}
    >
      {/* The mic is one of the resting pill's circles, so it takes the
          round variant with the "+". That pairing used to come from a
          `.composer.composer-min .palette-icon-btn` descendant rule. */}
      <VoiceInput
        className={className}
        shortcutActive={shortcutActive || focused}
        cancelClassName={cancelClassName}
        cancelFromPlus
        onText={onText}
        onTextSend={onTextSend}
        editTargetRef={textareaRef}
        overlayTargetRef={overlayTargetRef}
        overlayStyle={overlayStyle}
        onActiveChange={onActiveChange}
        // The bar covers the whole composer, so it takes the composer's
        // own corner. The resting phone pill is included, which is a
        // capsule rather than the expanded box's radius.
        overlayClassName={
          minimized
            ? utilityClassName(
                "rounded-[999px] phone:pl-2 phone:pr-0.5 phone:pb-1",
              )
            : utilityClassName("rounded-[var(--composer-radius)]")
        }
        disabled={disabled}
      />
    </motion.div>
  );
}
