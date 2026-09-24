import { useEffect, useState } from "react";
import type { ServerResourceSample } from "../../shared/server-resources";
import { useServerResources } from "../hooks/useServerResources";
import {
  formatResourceBytes,
  formatResourcePercent,
  RESOURCE_METRICS,
  resourceChart,
  resourcePercent,
  type ResourceMetric,
} from "../lib/server-resource-chart";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Popover } from "../ui/popover";
import { IconServer, IconX } from "./icons";
import { FrontendFpsCounter } from "./FrontendFpsCounter";
import {
  getServerHealthMonitorPref,
  onServerHealthMonitorChanged,
} from "../lib/server-health-pref";

function ResourceGraph({
  samples,
  metric,
  className,
}: {
  samples: ServerResourceSample[];
  metric: ResourceMetric;
  className?: string;
}) {
  const { path, last } = resourceChart(samples, metric);
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M1,29 H99"
        className="stroke-line"
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {last && <circle cx={last.x} cy={last.y} r="0.9" fill="currentColor" />}
    </svg>
  );
}

/** Desktop sidebar only. Phones keep the top bar clear of host metrics.
 * Hidden unless enabled in Preferences > Debug; unmounting also stops polling. */
export function ServerHealthMonitor() {
  const [enabled, setEnabled] = useState(getServerHealthMonitorPref);
  useEffect(
    () =>
      onServerHealthMonitorChanged(() =>
        setEnabled(getServerHealthMonitorPref()),
      ),
    [],
  );
  return enabled ? <ServerHealthPopover /> : null;
}

function ServerHealthPopover() {
  const state = useServerResources();
  const samples = state.kind === "ready" ? state.data.samples : [];
  const latest = samples.at(-1);
  const status =
    state.kind === "loading"
      ? "Connecting…"
      : state.kind === "unavailable"
        ? "Metrics unavailable. Retrying…"
        : "Updates every 2 seconds";
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Server health"
        render={<Button variant="ghost" size="sm" />}
        className="shrink-0 gap-1.5 min-h-8 px-1 font-normal [-webkit-app-region:no-drag] [app-region:no-drag] @max-[160px]/server-health:p-0"
      >
        {/* The sidebar slot measures space left after traffic lights and navigation. */}
        <span className="hidden @min-[64px]/server-health:@max-[160px]/server-health:flex">
          {latest?.cpu != null ? (
            <ResourceGraph
              samples={samples}
              metric="cpu"
              className="h-5 w-5 text-dim"
            />
          ) : (
            <IconServer size={20} />
          )}
        </span>
        <span className="flex gap-1.5 @max-[160px]/server-health:hidden">
          {RESOURCE_METRICS.map(({ key, shortLabel }) => (
            <span key={key} className="flex w-9 flex-col gap-0.5">
              <span className="flex flex-col items-center gap-0.5 text-meta leading-none">
                <span className="text-faint">{shortLabel}</span>
                <span className="tabular-nums text-dim">
                  {formatResourcePercent(resourcePercent(latest, key))}
                </span>
              </span>
              <ResourceGraph
                samples={samples}
                metric={key}
                className="h-1 w-full text-dim"
              />
            </span>
          ))}
        </span>
        <FrontendFpsCounter />
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="end"
        initialFocus
        className="max-h-[var(--available-height)] w-[340px] max-w-[calc(100vw-16px)] overflow-y-auto p-4 motion-reduce:transition-none"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-item-title font-semibold text-fg">
              Server health
            </h2>
            <p className="m-0 mt-1 text-meta text-dim" role="status">
              {status}
            </p>
          </div>
          <Popover.Close
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Close server health"
                className="size-11 p-0"
              />
            }
          >
            <IconX size={18} />
          </Popover.Close>
        </div>
        <div className="space-y-4">
          {RESOURCE_METRICS.map(({ key, label }) => {
            const value = resourcePercent(latest, key);
            const capacity = key === "cpu" ? null : latest?.[key];
            return (
              <section key={key} aria-label={label}>
                <div className="flex items-baseline justify-between text-supporting">
                  <h3 className="m-0 text-supporting font-medium text-fg">
                    {label}
                  </h3>
                  <span className="tabular-nums text-fg">
                    {formatResourcePercent(value)}
                  </span>
                </div>
                <ResourceGraph
                  samples={samples}
                  metric={key}
                  className={cn(
                    "my-2 h-14 w-full",
                    value !== null && value >= 90
                      ? "text-yellow"
                      : "text-accent",
                  )}
                />
                <p className="m-0 text-meta text-dim">
                  {value === null
                    ? state.kind === "loading" ||
                      (state.kind === "ready" && key === "cpu")
                      ? "Collecting samples…"
                      : "Unavailable"
                    : capacity
                      ? `${formatResourceBytes(capacity.usedBytes)} of ${formatResourceBytes(capacity.totalBytes)} used${key === "disk" ? " · System disk" : ""}`
                      : "Across all server cores"}
                </p>
              </section>
            );
          })}
        </div>
        <div className="mt-4 flex justify-between text-meta text-faint">
          <span>2 minutes ago</span>
          <span>Now · 0–100%</span>
        </div>
        <p className="m-0 mt-2 text-meta text-faint">
          Host resources, not this browser.
        </p>
      </Popover.Popup>
    </Popover.Root>
  );
}
