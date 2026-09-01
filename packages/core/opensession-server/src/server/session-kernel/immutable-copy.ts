import {
  activeSessionKernels,
  peekSessionKernel,
  sessionKernel,
} from "./kernel";

export function immutableCopy<V>(
  value: V,
  seen = new WeakMap<object, unknown>(),
): V {
  if (!value || typeof value !== "object") return value;
  const prior = seen.get(value as object);
  if (prior) return prior as V;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(immutableCopy(item, seen));
    return copy as V;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as Record<string, unknown>;
  seen.set(value as object, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    copy[key] = immutableCopy(item, seen);
  return copy as V;
}
