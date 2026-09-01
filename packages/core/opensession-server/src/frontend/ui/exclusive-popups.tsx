import * as React from "react";

type PopupEntry = {
  close: () => void;
};

type PopupGroup = {
  activate: (entry: PopupEntry) => void;
  deactivate: (entry: PopupEntry) => void;
  instant: boolean;
};

const PopupGroupContext = React.createContext<PopupGroup | null>(null);

export function ExclusivePopupProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const activeRef = React.useRef<PopupEntry | null>(null);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [instant, setInstant] = React.useState(false);

  const activate = (entry: PopupEntry) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const previous = activeRef.current;
    activeRef.current = entry;
    setInstant(true);
    if (previous !== entry) previous?.close();
  };
  const deactivate = (entry: PopupEntry) => {
    if (activeRef.current !== entry) return;
    activeRef.current = null;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setInstant(false), 300);
  };

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const group = {
    activate,
    deactivate,
    instant,
  };

  return (
    <PopupGroupContext.Provider value={group}>
      {children}
    </PopupGroupContext.Provider>
  );
}

export function useExclusivePopup(entry: PopupEntry) {
  const group = React.useContext(PopupGroupContext);
  const deactivate = group?.deactivate;

  React.useEffect(() => () => deactivate?.(entry), [entry, deactivate]);

  return group;
}

export function useExclusivePopupDelay(delay: number | undefined) {
  const group = React.useContext(PopupGroupContext);
  return group?.instant ? 0 : delay;
}
