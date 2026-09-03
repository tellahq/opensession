import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import type { NewTabMorphOrigin } from "../lib/session-tabs-types";

interface NewTabMorph {
  id: string;
  origin: NewTabMorphOrigin;
}

export function useNewTabMorphTimer(
  setNewTabMorph: Dispatch<SetStateAction<NewTabMorph | null>>,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const clearNewTabMorphTimer = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const startNewTabMorphTimer = (id: string) => {
    timer.current = setTimeout(() => {
      setNewTabMorph((current) => (current?.id === id ? null : current));
      timer.current = undefined;
    }, 260);
  };

  return { clearNewTabMorphTimer, startNewTabMorphTimer };
}
