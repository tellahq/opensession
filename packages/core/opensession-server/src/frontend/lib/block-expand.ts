/**
 * Opening a markdown block large: the artifact frame and the slide deck.
 *
 * The blocks are DOM built inside an innerHTML body, so like the media
 * lightbox (media-lightbox.ts) the dialog is hosted once in the app
 * (components/BlockExpandDialog.tsx) and opened imperatively. The block
 * hands over a `mount` that builds a fresh copy of itself into the dialog's
 * body rather than moving its own nodes there: the inline block stays where
 * it is, and closing the dialog only has to tear the copy down.
 */

export interface BlockExpandRequest {
  /** The dialog's title: "Artifact", "Slides". */
  title: string;
  /** Build the expanded content into `host`; return its teardown. */
  mount: (host: HTMLElement) => () => void;
  /** Give the content the dialog's full height (a frame) rather than let it
   *  take its own (a deck). */
  fill?: boolean;
}

let host: ((request: BlockExpandRequest) => void) | null = null;

export function registerBlockExpandHost(
  open: (request: BlockExpandRequest) => void,
): () => void {
  host = open;
  return () => {
    if (host === open) host = null;
  };
}

/** False when no dialog is mounted to show it. */
export function openBlockExpand(request: BlockExpandRequest): boolean {
  if (!host) return false;
  host(request);
  return true;
}
