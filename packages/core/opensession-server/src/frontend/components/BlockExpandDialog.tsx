import { useEffect, useState } from "react";
import {
  registerBlockExpandHost,
  type BlockExpandRequest,
} from "../lib/block-expand";
import { cn } from "../ui/cn";
import { Modal } from "../ui/modal";

/**
 * The one dialog a markdown block opens itself large in (lib/block-expand.ts):
 * a sandboxed artifact at the window's size, a slide deck at reading width.
 * Hosted once in the app, beside the media lightbox, because the blocks are
 * DOM built inside innerHTML bodies and have no React tree to render a
 * dialog from.
 */
export function BlockExpandHost() {
  const [request, setRequest] = useState<BlockExpandRequest | null>(null);
  const [open, setOpen] = useState(false);
  // The body node as state rather than a ref: Base UI mounts a popup's
  // children in a later commit than the one that opens it, so an effect on
  // a ref would run against null (see useScrolledUnder in ui/modal.tsx).
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useEffect(
    () =>
      registerBlockExpandHost((next) => {
        setRequest(next);
        setOpen(true);
      }),
    [],
  );
  useEffect(() => {
    if (!body || !request) return;
    return request.mount(body);
  }, [body, request]);

  return (
    <Modal.Root open={open} onOpenChange={setOpen}>
      {request && (
        <Modal.Content
          widthClassName="max-w-[min(1280px,96vw)]"
          className="w-[96vw]"
          finalFocus={false}
        >
          <Modal.Header title={request.title} />
          <div
            ref={setBody}
            className={cn(
              "min-h-0 min-w-0",
              request.fill && "h-[min(820px,calc(85dvh-104px))]",
            )}
          />
        </Modal.Content>
      )}
    </Modal.Root>
  );
}
