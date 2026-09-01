export interface TranscriptVirtualNavigation {
  scrollToEntry(entryId: string): boolean;
}

const virtualNavigation = new WeakMap<
  HTMLElement,
  TranscriptVirtualNavigation
>();

/** Register the virtual transcript living inside one scroll container. */
export function registerTranscriptVirtualNavigation(
  container: HTMLElement,
  navigation: TranscriptVirtualNavigation,
): () => void {
  virtualNavigation.set(container, navigation);
  return () => {
    if (virtualNavigation.get(container) === navigation)
      virtualNavigation.delete(container);
  };
}

/** Ask a virtual transcript to mount and reveal an entry. */
export function scrollToVirtualTranscriptEntry(
  container: HTMLElement,
  entryId: string,
): boolean {
  return virtualNavigation.get(container)?.scrollToEntry(entryId) ?? false;
}
