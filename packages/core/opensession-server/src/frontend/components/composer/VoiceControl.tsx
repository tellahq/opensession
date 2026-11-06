import { useSyncExternalStore, type Ref, type RefObject } from "react";
import { sessionVoice } from "../../lib/session-voice-runtime";
import { motion } from "motion/react";
import { composerMorph } from "../../ui/motion";
import { cn } from "../../ui/cn";
import { VoiceInput, type VoiceInputControl } from "../VoiceInput";

interface VoiceControlProps {
  minimized: boolean;
  className: string;
  shortcutActive: boolean;
  focused: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  controlRef: Ref<VoiceInputControl>;
  onText: (text: string) => void;
  onTextSend: (text: string) => void;
  onActiveChange: (active: boolean) => void;
  disabled?: boolean;
  /** Phone dictation: the live pill fills the toolbar row. */
  wide?: boolean;
}

export function VoiceControl({
  minimized,
  className,
  shortcutActive,
  focused,
  textareaRef,
  controlRef,
  onText,
  onTextSend,
  onActiveChange,
  disabled,
  wide,
}: VoiceControlProps) {
  const callActive = useSyncExternalStore(
    sessionVoice.subscribe,
    sessionVoice.isActive,
  );
  return (
    <motion.div
      layout="position"
      transition={composerMorph}
      layoutDependency={minimized}
      className={cn(
        "pwa-composer-dictation inline-flex shrink-0 items-center",
        minimized && "order-3",
        wide && "min-w-0 grow basis-0",
      )}
    >
      {/* The mic is one of the resting pill's circles, so it takes the
          round variant with the "+". Recording swaps it for a compact live
          pill in the same place; the draft above stays visible. */}
      <VoiceInput
        className={className}
        shortcutActive={shortcutActive || focused}
        onText={onText}
        onTextSend={onTextSend}
        editTargetRef={textareaRef}
        controlRef={controlRef}
        onActiveChange={onActiveChange}
        disabled={disabled || callActive}
        wide={wide}
      />
    </motion.div>
  );
}
