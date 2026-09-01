import { clsx, type ClassValue } from "clsx";
import * as stylex from "@stylexjs/stylex";
import type {
  CompiledStyles,
  InlineStyles,
  StyleXArray,
} from "@stylexjs/stylex";
import {
  utilityStyles,
  type UtilityClass,
} from "../styles/utility-compat.stylex";

type StyleXProp = StyleXArray<
  | null
  | undefined
  | CompiledStyles
  | boolean
  | Readonly<[CompiledStyles, InlineStyles]>
>;

type RegisteredOverride = {
  className: ClassValue;
  styles: ReadonlyArray<StyleXProp>;
};

/** True when StyleX is running uncompiled (bun test): stylex.props resolves
 *  to inline styles and no class name, so source spellings are the only thing
 *  tests can read. Probed once; compiled builds always produce classes. */
const STYLEX_UNCOMPILED = !stylex.props({ probe: { color: "red" } } as never)
  .className;

/** Caller overrides passed through custom components. Ordinary shared class
 * maps stay opaque strings: replaying their compiled styles would collapse a
 * base + responsive pair into the conditional class only. */
const registeredOverrides = new Map<string, RegisteredOverride>();

function resolveOverrides(inputs: readonly ClassValue[]): {
  classNames: ClassValue[];
  uncompiledUtilityNames: string[];
  styles: StyleXProp[];
} {
  const classNames: ClassValue[] = [];
  const uncompiledUtilityNames: string[] = [];
  const styles: StyleXProp[] = [];
  const resolvingRegistered = new Set<string>();
  const collect = (value: ClassValue): void => {
    if (!value) return;
    if (typeof value === "string") {
      const registered = registeredOverrides.get(value);
      if (registered && !resolvingRegistered.has(value)) {
        resolvingRegistered.add(value);
        collect(registered.className);
        styles.push(...registered.styles);
        resolvingRegistered.delete(value);
      } else {
        for (const token of value.split(/\s+/).filter(Boolean)) {
          const mapped = utilityStyles[token as UtilityClass];
          if (mapped) {
            styles.push(mapped);
            uncompiledUtilityNames.push(token);
            // Uncompiled StyleX cannot name these styles, so the
            // token stays visible in the class list for suite tests
            // written against the Tailwind build. Compiled builds
            // drop it here and carry it as the hashed class.
            if (STYLEX_UNCOMPILED) classNames.push(token);
          } else classNames.push(token);
        }
      }
      return;
    }
    if (typeof value === "number") {
      classNames.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === "object") {
      for (const [name, enabled] of Object.entries(value)) {
        if (enabled) collect(name);
      }
    }
  };
  for (const input of inputs) collect(input);
  return { classNames, uncompiledUtilityNames, styles };
}

/** Uncompiled StyleX (bun test, dev) returns inline styles and no class name, so
 * a registration keyed by the joined result would be dropped whenever no
 * semantic or residual hook travels beside it. Derive a stable key from the
 * resolved declarations instead, so the styles survive to the receiving
 * primitive's mergeStylexProps boundary. Compiled builds always produce a class
 * name and never reach this. */
function styleKey(props: { readonly style?: unknown }): string {
  const source = JSON.stringify(props.style ?? null);
  let hash = 2166136261;
  for (const char of source)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `sx-styles-${(hash >>> 0).toString(36)}`;
}

/** Convert utility strings introduced by a merged branch through the generated,
 * fail-closed StyleX compatibility map. Residual selector hooks stay as class
 * names; mapped declarations retain metadata so a surrounding cn() composes
 * conditional alternatives in call order. */
export function utilityClassName(value: string): string {
  const classNames: string[] = [];
  const styles: StyleXProp[] = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    const mapped = utilityStyles[token as UtilityClass];
    if (mapped) styles.push(mapped);
    else classNames.push(token);
  }
  const props = stylex.props(...styles);
  // Uncompiled StyleX (bun test, dev) returns inline styles and no class
  // name. Keep the source spelling — residual selectors and tests read it —
  // WITHOUT registering it: a registered marker flowing into cn() would
  // contribute its styles but no visible class, hiding the tokens that
  // suite tests (written against the Tailwind build) assert on. Compiled
  // builds have a class name, register normally, and never reach this.
  if (!props.className) {
    // The unmapped tokens are already part of the source string, so return
    // it verbatim — no duplicates, no registration (a registered marker
    // would hide these spellings from a surrounding cn() at test time).
    return value || clsx(classNames);
  }
  const result = clsx(classNames, props.className);
  if (result && styles.length > 0) {
    registeredOverrides.set(result, { className: classNames, styles });
  }
  return result;
}

/** Join semantic/residual hooks. If a caller override travels through cn(),
 * preserve its metadata for the primitive's mergeStylexProps boundary. */
export function cn(...inputs: ClassValue[]): string {
  const resolved = resolveOverrides(inputs);
  const props = stylex.props(...resolved.styles);
  let result = clsx(resolved.classNames, props.className);
  // Uncompiled StyleX names nothing, so a call whose tokens all mapped to
  // styles would render classless and lose its registration. Fall back to the
  // source spelling, which both keeps the tokens visible and keys the styles.
  if (!result && resolved.styles.length > 0)
    result = clsx(inputs) || styleKey(props);
  if (result && resolved.styles.length > 0) {
    registeredOverrides.set(result, {
      className: resolved.classNames,
      styles: resolved.styles,
    });
  }
  return result;
}

/** Compose primitive defaults with caller overrides. */
export function mergeStylexProps(
  className: ClassValue,
  ...styles: ReadonlyArray<StyleXProp>
) {
  const override = resolveOverrides([className]);
  const props = stylex.props(...styles, ...override.styles);
  return { ...props, className: clsx(override.classNames, props.className) };
}

/** Class-name form for shared style maps and third-party APIs. The result stays
 * opaque so base and responsive classes can coexist in the cascade. */
export function mergeStylexClassName(
  className: ClassValue,
  ...styles: ReadonlyArray<StyleXProp>
): string {
  const props = stylex.props(...styles);
  return clsx(className, props.className);
}

/** Class-name form specifically for a custom component's caller override. The
 * receiving primitive's mergeStylexProps() will compose these styles after its
 * defaults, preserving the pre-migration cn(defaults, className) contract. */
export function mergeStylexOverrideClassName(
  className: ClassValue,
  ...styles: ReadonlyArray<StyleXProp>
): string {
  const props = stylex.props(...styles);
  let result = clsx(className, props.className);
  if (!result && styles.length > 0) result = styleKey(props);
  if (result) registeredOverrides.set(result, { className, styles });
  return result;
}
