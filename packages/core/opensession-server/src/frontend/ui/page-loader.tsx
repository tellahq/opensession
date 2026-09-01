import * as React from "react";
import { Spinner } from "./spinner";

/**
 * The page loader: a quiet turning ring, for a whole region that has nothing
 * in it yet.
 *
 * The app has three loading marks, and they are not interchangeable. Each says
 * a different thing, and the size of what is waiting picks between them:
 *
 *  - `PageLoader` (this) is for a whole page, pane or region. Same ring as the
 *    small spinner, one size up, so an empty canvas reads as waiting without a
 *    second piece of choreography competing with the copy under it. It used to
 *    be the launch splash's five-bar wave. At label scale that wave drew more
 *    attention than the thing it was standing in for.
 *  - `Spinner` (ui/spinner) is for a small element working: a button mid-save,
 *    a row refreshing, a control that is fetching.
 *  - `PixelSpinner` (components/PixelSpinner) means a MODEL is generating.
 *    Never reach for it to mean "fetching": worn on a slow request it says an
 *    agent is working on something nobody asked for.
 *
 * Colour comes from `currentColor`, so the caller's text class sets it.
 * base.css keeps the shared spinner turning under prefers-reduced-motion, which
 * is right here: this mark is the only thing on an otherwise empty region saying
 * the app is still working, and a frozen one reads as hung.
 */
export function PageLoader(props: React.ComponentPropsWithoutRef<"span">) {
  return <Spinner size="lg" {...props} />;
}
