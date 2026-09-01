/**
 * The app's one breakpoint as StyleX media-query keys.
 *
 * These MUST live in a `.stylex.const` file: StyleX statically evaluates
 * computed keys across files only from theme/const files (see
 * stylex-build.ts). The boundary itself is documented in lib/breakpoints.ts,
 * whose test keeps this file, PHONE_QUERY and base.css on one number.
 */
import * as stylex from "@stylexjs/stylex";

export const MQ = stylex.defineConsts({
  PHONE: "@media (max-width: 720px)",
  DESKTOP: "@media (min-width: 721px)",
});
