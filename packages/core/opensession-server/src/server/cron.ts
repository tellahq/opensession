// Minimal 5-field cron (UTC): minute hour day-of-month month day-of-week.
// Supports "*", "*/n", "a", "a-b", "a-b/n" and comma lists. dow 0 or 7 = Sunday.

interface FieldSpec {
  any: boolean;
  values: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

export function parseCron(expr: string): FieldSpec[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const specs: FieldSpec[] = [];
  for (let i = 0; i < 5; i++) {
    const spec = parseField(
      parts[i],
      FIELD_RANGES[i][0],
      FIELD_RANGES[i][1],
      i === 4,
    );
    if (!spec) return null;
    specs.push(spec);
  }
  return specs;
}

function parseField(
  field: string,
  min: number,
  max: number,
  isDow: boolean,
): FieldSpec | null {
  if (field === "*") return { any: true, values: new Set() };

  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const [, base, stepStr] = m;
    const step = stepStr ? parseInt(stepStr) : 1;
    if (step < 1) return null;

    let lo: number, hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(base);
      if (stepStr) hi = max; // "a/n" means a..max step n
    }

    for (let v = lo; v <= hi; v += step) {
      let val = v;
      if (isDow && val === 7) val = 0;
      if (val < min || val > max) {
        if (!(isDow && v === 7)) return null;
      }
      values.add(val);
    }
  }
  return { any: false, values };
}

export function cronMatches(expr: string, date: Date): boolean {
  const specs = parseCron(expr);
  if (!specs) return false;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  const [mSpec, hSpec, domSpec, monSpec, dowSpec] = specs;
  if (!fieldMatches(mSpec, minute)) return false;
  if (!fieldMatches(hSpec, hour)) return false;
  if (!fieldMatches(monSpec, month)) return false;

  // Standard cron: if both dom and dow are restricted, either may match
  const domOk = fieldMatches(domSpec, dom);
  const dowOk = fieldMatches(dowSpec, dow);
  if (!domSpec.any && !dowSpec.any) return domOk || dowOk;
  return domOk && dowOk;
}

function fieldMatches(spec: FieldSpec, value: number): boolean {
  return spec.any || spec.values.has(value);
}

/** Next matching minute strictly after `from`, scanning up to ~1 year. */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  if (!parseCron(expr)) return null;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < 527040; i++) {
    if (cronMatches(expr, cursor)) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
