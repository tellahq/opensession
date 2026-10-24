/**
 * Size probes for process-lifetime in-memory structures.
 *
 * A module that keeps a Map, Set or buffer for the life of the gateway
 * registers a probe here so memory diagnostics can report how large each one
 * is without importing the module that owns it. Registration only stores a
 * function: it binds nothing, starts no timer and does no I/O, so calling it at
 * import time is safe. Probes must be cheap (a `.size` read, a short loop over
 * already-resident values) because an operator may call them on a gateway that
 * is already short of memory.
 *
 * This module imports nothing so any server module can depend on it.
 */

/** A count, or named counts for a structure with several dimensions. */
export type MemoryProbeValue = number | Record<string, number>;
export type MemoryProbe = () => MemoryProbeValue;

const g = globalThis as typeof globalThis & {
  __osMemoryProbes?: Map<string, MemoryProbe>;
};

function probes(): Map<string, MemoryProbe> {
  return (g.__osMemoryProbes ??= new Map());
}

/** Register (or replace, on hot reload) the probe for one named structure.
 *  Names read as `<module>.<structure>`. */
export function registerMemoryProbe(name: string, probe: MemoryProbe): void {
  probes().set(name, probe);
}

/** Run every probe. A failing probe reports its error instead of hiding the
 *  rest. Sorted by name so successive reports diff cleanly. */
export function readMemoryProbes(): Record<
  string,
  MemoryProbeValue | { error: string }
> {
  const out: Record<string, MemoryProbeValue | { error: string }> = {};
  for (const name of [...probes().keys()].sort()) {
    try {
      out[name] = probes().get(name)!();
    } catch (error) {
      out[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return out;
}

/** Total string length of a collection's values: a cheap proxy for the bytes
 *  a cache of patches or path lists retains. */
export function totalChars(values: Iterable<string | null | undefined>) {
  let total = 0;
  for (const value of values) total += value?.length ?? 0;
  return total;
}
