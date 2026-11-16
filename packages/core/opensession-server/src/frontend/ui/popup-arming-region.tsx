import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { PopupArmingContext } from "./popup-arming";

const FOCUSABLE =
  "a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])";

/**
 * A region whose tooltips, menus and popovers are built on first intent (see
 * ui/popup-arming.ts). Renders one div, so it can replace a wrapper the
 * caller already had.
 *
 * Arming re-renders the deferred triggers as Base UI triggers, which
 * remounts their elements. So it happens before anyone presses them: a
 * hovering mouse or pen with no button down, a keyboard focus (the focused
 * element is put back after the swap), or a click, after its handlers ran. A
 * touch arms on its click; until then a plain menu trigger opens its own menu.
 */
export function PopupArmingRegion({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [armed, setArmed] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const focusIndex = React.useRef(-1);
  const arm = () => setArmed(true);
  React.useLayoutEffect(() => {
    const root = ref.current;
    const index = focusIndex.current;
    focusIndex.current = -1;
    if (!armed || !root || index < 0 || root.contains(document.activeElement))
      return;
    root.querySelectorAll<HTMLElement>(FOCUSABLE)[index]?.focus({
      preventScroll: true,
    });
  }, [armed]);
  return (
    <div
      ref={ref}
      className={className}
      onPointerEnter={
        armed
          ? undefined
          : (event) => {
              if (event.pointerType !== "touch" && event.buttons === 0) arm();
            }
      }
      onFocus={
        armed
          ? undefined
          : (event) => {
              // A pointer press focuses too, between its down and its click;
              // swapping the element then would swallow the click.
              if (!event.target.matches(":focus-visible")) return;
              const target = event.target;
              focusIndex.current = [
                ...(ref.current?.querySelectorAll(FOCUSABLE) ?? []),
              ].findIndex((element) => element === target);
              arm();
            }
      }
      onClickCapture={armed ? undefined : arm}
    >
      <PopupArmingContext value={{ armed, arm }}>{children}</PopupArmingContext>
    </div>
  );
}

type TriggerProps = ReturnType<typeof mergeProps<"button">>;

/** A deferred root's trigger: the closed button Base UI would render, which
 *  opens the real popup when clicked. */
export function DeferredPopupTrigger<
  State extends { open: boolean; disabled: boolean },
>({
  haspopup,
  onOpen,
  render,
  state,
  props,
}: {
  haspopup: "menu" | "dialog";
  onOpen: () => void;
  render: useRender.RenderProp<State> | undefined;
  /** The closed state a function `render` is called with. */
  state: State;
  props: TriggerProps;
}) {
  return useRender({
    defaultTagName: "button",
    render,
    state,
    props: mergeProps<"button">(
      { type: "button", "aria-haspopup": haspopup, "aria-expanded": false },
      props,
      { onClick: onOpen },
    ),
  });
}
