import { useLayoutEffect, useRef, useState } from "react";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { primeSoftKeyboard } from "../lib/soft-keyboard";

interface NewSessionPaletteState {
  open: boolean;
  prompt?: string;
  workspaceId?: string;
  repo?: string;
  branch?: string;
  mode?: NewSessionPrefill["mode"];
  mcpServers?: string[];
}

type NewSessionPalettePrefill = Omit<NewSessionPaletteState, "open">;

interface UseNewSessionPaletteOptions {
  initiallyOpen: boolean;
  initialPrompt?: string;
}

export function useNewSessionPalette({
  initiallyOpen,
  initialPrompt,
}: UseNewSessionPaletteOptions) {
  const [palette, setPaletteState] = useState<NewSessionPaletteState>(() =>
    initiallyOpen ? { open: true, prompt: initialPrompt } : { open: false },
  );

  // Every direct action that opens the palette goes through here, so the phone
  // keyboard is raised from inside the tap rather than a frame later, when iOS
  // no longer grants it. The prompt takes the keyboard over as soon as it mounts.
  const setPalette = (next: NewSessionPaletteState) => {
    if (next.open) primeSoftKeyboard();
    setPaletteState(next);
  };

  const paletteOpenRef = useRef(palette.open);
  useLayoutEffect(() => {
    paletteOpenRef.current = palette.open;
  });

  const openPalette = (prompt?: string, mcpServers?: string[]) => {
    const next: NewSessionPaletteState = { open: true, prompt };
    if (mcpServers?.length) next.mcpServers = mcpServers;
    setPalette(next);
  };

  const openPrefilledSession = (prefill: NewSessionPalettePrefill) => {
    setPalette({ open: true, ...prefill });
  };

  const hidePalette = () => {
    setPaletteState((current) => ({ ...current, open: false }));
  };

  const restorePalette = () => {
    primeSoftKeyboard();
    setPaletteState((current) => ({ ...current, open: true }));
  };

  return {
    palette,
    paletteOpenRef,
    openPalette,
    openPrefilledSession,
    hidePalette,
    restorePalette,
  };
}
