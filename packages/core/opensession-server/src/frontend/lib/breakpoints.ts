/**
 * The app's one breakpoint, shared by matchMedia and StyleX. The source guard
 * in styles/stylex-parity.test.ts rejects alternate spellings.
 */

/**
 * A phone-width viewport. The same query as the `phone:` variant in
 * `styles/tailwind.css` and the `@media (max-width: 720px)` blocks in
 * `styles/base.css`, 720 included.
 *
 * Note it is not what `max-[720px]:` compiles to. That is `< 720`, so an
 * element spelled that way drops its phone value one pixel early and disagrees
 * with everything here at exactly 720px wide.
 */
export const PHONE_QUERY = "(max-width: 720px)";

/**
 * The same two queries as StyleX media-query keys, spelled once here so the
 * boundary has one TypeScript authoring site. base.css repeats the global
 * media block, and the parity guard pins every StyleX declaration to this
 * exact spelling.
 *
 * 720 included on the phone side, exactly like PHONE_QUERY and base.css.
 */
export const PHONE_MQ = "@media (max-width: 720px)" as const;
export const DESKTOP_MQ = "@media (min-width: 721px)" as const;
