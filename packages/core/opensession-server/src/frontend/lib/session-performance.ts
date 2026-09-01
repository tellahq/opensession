export interface SessionPerfSample {
  name: string;
  value: number;
  at: number;
  meta?: Record<string, string | number | boolean>;
}

const samplesByName = new Map<string, SessionPerfSample[]>();
const recentSamples: SessionPerfSample[] = [];
const counters = new Map<string, number>();
const MAX_SAMPLES_PER_METRIC = 200;
const MAX_RECENT_SAMPLES = 100;
let observersStarted = false;
let transcriptDomSamplePending = false;

export function recordSessionPerf(
  name: string,
  value: number,
  meta?: SessionPerfSample["meta"],
) {
  const sample = { name, value, at: performance.now(), meta };
  const metricSamples = samplesByName.get(name) ?? [];
  metricSamples.push(sample);
  if (metricSamples.length > MAX_SAMPLES_PER_METRIC)
    metricSamples.splice(0, metricSamples.length - MAX_SAMPLES_PER_METRIC);
  samplesByName.set(name, metricSamples);
  recentSamples.push(sample);
  if (recentSamples.length > MAX_RECENT_SAMPLES)
    recentSamples.splice(0, recentSamples.length - MAX_RECENT_SAMPLES);
}

export function countSessionPerf(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function measureSessionPerf(name: string, start: number) {
  recordSessionPerf(name, performance.now() - start);
}

export function sessionPerfSnapshot() {
  const metrics = Object.fromEntries(
    [...samplesByName].map(([name, samples]) => {
      const values = samples.map((sample) => sample.value);
      const sorted = [...values].sort((a, b) => a - b);
      const at = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return [
        name,
        {
          count: sorted.length,
          p50: at(0.5),
          p95: at(0.95),
          max: sorted[sorted.length - 1] ?? 0,
        },
      ];
    }),
  );
  return {
    metrics,
    counters: Object.fromEntries(counters),
    recent: [...recentSamples],
  };
}

/** DOM cardinality is useful telemetry but a full transcript query is not
 * commit work. Coalesce samples and run them when the browser is idle. */
export function scheduleTranscriptDomNodeSample() {
  if (transcriptDomSamplePending || typeof document === "undefined") return;
  transcriptDomSamplePending = true;
  const sample = () => {
    transcriptDomSamplePending = false;
    recordSessionPerf(
      "transcript_dom_nodes",
      document.querySelectorAll(".viewer-messages [data-eid]").length,
    );
  };
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(sample, { timeout: 1_000 });
  else setTimeout(sample, 0);
}

export function startSessionPerfObservers() {
  if (
    observersStarted ||
    typeof window === "undefined" ||
    typeof PerformanceObserver === "undefined"
  )
    return;
  observersStarted = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordSessionPerf("long_task_ms", entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Safari and older WebViews do not expose long-task entries.
  }
  try {
    const events = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        recordSessionPerf("input_event_ms", entry.duration);
    });
    events.observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit & { durationThreshold: number });
  } catch {
    // Event Timing is progressive telemetry.
  }
  (
    window as typeof window & { __sessionPerf?: typeof sessionPerfSnapshot }
  ).__sessionPerf = sessionPerfSnapshot;
}
