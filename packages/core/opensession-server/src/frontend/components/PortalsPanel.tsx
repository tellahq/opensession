import { useState } from "react";
import type {
  PreviewPortalRecipe,
  PreviewService,
  PreviewStatus,
} from "../lib/api";
import { portalTargetFor, type PortalTarget } from "../lib/portals";
import {
  INFO_LABEL_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { cn } from "../ui/cn";
import { IconArrowUpRight } from "./icons";
import { PanelPageHeader } from "./PanelPageHeader";

/** A plain divided list. Portal rows do not need a shared grey plate around
 * them: the panel itself is already their surface. */
const PORTAL_LIST_CLASS = "grid divide-y divide-line/70";

/** What a service row says on its right: where it is, in one word. */
function statusLabel(
  service: PreviewService,
  target: PortalTarget | null,
  active: boolean,
): string {
  if (target) return active ? "Open" : "Running";
  if (service.running) {
    if (service.state === "starting") return "Starting";
    if (service.state === "sleeping") return "Sleeping";
    if (service.state === "waking") return "Waking";
    return "Unavailable";
  }
  return service.state === "failed" ? "Failed" : `Port ${service.port}`;
}

function DiscoveringRow() {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-supporting text-dim">
      <span className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      Discovering services…
    </div>
  );
}

/**
 * The portals page: the panel one level deeper, opened from the Portals item
 * in the panel's tab strip. The recipes this repository can start, every
 * discovered service, and the restart and stop controls for the ones we manage.
 */
export function PortalsPage({
  sessionId,
  status,
  activePortal,
  onBack,
  hideHeader = false,
  onOpenPortal,
  onStartPortal,
  onPortalAction,
}: {
  sessionId: string;
  status: PreviewStatus | null;
  activePortal?: PortalTarget | null;
  onBack: () => void;
  hideHeader?: boolean;
  onOpenPortal?: (target: PortalTarget) => void;
  onStartPortal?: (recipe: PreviewPortalRecipe) => Promise<void>;
  onPortalAction?: (name: string, action: "stop" | "restart") => Promise<void>;
}) {
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const services = status?.services ?? [];
  const recipes = status?.portalRecipes ?? [];
  const liveCount = services.filter((service) =>
    portalTargetFor(sessionId, service),
  ).length;

  return (
    <>
      {!hideHeader && (
        <PanelPageHeader
          title="Portals"
          onBack={onBack}
          trailing={
            liveCount > 0 && (
              <span className="shrink-0 px-1 text-label font-semibold tabular-nums text-faint">
                {liveCount} live
              </span>
            )
          }
        />
      )}
      <div className="grid gap-4 px-2 pt-2 pb-[22px]">
        {error ? (
          <div
            role="alert"
            className="rounded-control bg-red-soft px-3 py-2 text-label text-red"
          >
            {error}
          </div>
        ) : null}
        {!status ? (
          <DiscoveringRow />
        ) : (
          <>
            {recipes.length ? (
              <div className={INFO_SECTION_CLASS}>
                <div className={INFO_LABEL_CLASS}>Start a portal</div>
                <div className={PORTAL_LIST_CLASS}>
                  {recipes.map((recipe) => {
                    const service = recipe.serviceKey
                      ? services.find(
                          (candidate) => candidate.key === recipe.serviceKey,
                        )
                      : null;
                    const target = service
                      ? portalTargetFor(sessionId, service)
                      : null;
                    return (
                      <button
                        key={recipe.id}
                        type="button"
                        disabled={
                          !target && (!onStartPortal || requestedId != null)
                        }
                        onClick={() => {
                          if (target) {
                            onOpenPortal?.(target);
                            return;
                          }
                          if (!onStartPortal) return;
                          setError(null);
                          setRequestedId(recipe.id);
                          void onStartPortal(recipe)
                            .catch((cause) =>
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              ),
                            )
                            .finally(() => setRequestedId(null));
                        }}
                        className="focus-ring flex min-h-11 w-full min-w-0 items-center gap-3 rounded-control px-2 py-1.5 text-left transition-[background-color,scale] hover:bg-hover active:scale-[0.96] disabled:cursor-default disabled:opacity-45"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-label font-medium text-fg">
                            {recipe.name}
                          </span>
                          {recipe.description ? (
                            <span className="mt-0.5 block line-clamp-2 text-supporting text-dim">
                              {recipe.description}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-label font-semibold text-faint">
                          {target
                            ? "Open"
                            : requestedId === recipe.id
                              ? "Starting…"
                              : "Start"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className={INFO_SECTION_CLASS}>
              {recipes.length > 0 && (
                <div className={INFO_LABEL_CLASS}>Services</div>
              )}
              <div className={PORTAL_LIST_CLASS}>
                {services.length ? (
                  services.map((service) => {
                    const target = portalTargetFor(sessionId, service);
                    const active =
                      !!target &&
                      activePortal?.sessionId === sessionId &&
                      activePortal.key === service.key;
                    return (
                      <div
                        key={service.key}
                        className={cn(
                          "group flex min-h-11 min-w-0 items-center gap-1 rounded-control pr-1 transition-colors",
                          active ? "bg-hover" : "hover:bg-hover",
                        )}
                      >
                        <button
                          type="button"
                          disabled={!target}
                          onClick={() => target && onOpenPortal?.(target)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-[5px] text-left disabled:cursor-default"
                        >
                          <span
                            className={cn(
                              "size-[7px] shrink-0 rounded-full",
                              service.running ? "bg-green" : "bg-line-strong",
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate text-label text-fg">
                            {service.name}
                          </span>
                          <span className="shrink-0 truncate text-label text-faint">
                            {statusLabel(service, target, active)}
                          </span>
                        </button>
                        {target ? (
                          <a
                            href={target.url}
                            target="_blank"
                            rel="noopener"
                            className="focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-control text-faint opacity-0 transition-[color,opacity] phone:opacity-100 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`Open ${service.name} in a separate browser window`}
                            title="Open in browser"
                          >
                            <IconArrowUpRight size={14} />
                          </a>
                        ) : null}
                        {service.managed && onPortalAction ? (
                          <div className="flex shrink-0 items-center opacity-0 transition-opacity phone:opacity-100 group-hover:opacity-100 focus-within:opacity-100">
                            <button
                              type="button"
                              disabled={working === service.name}
                              onClick={() => {
                                setError(null);
                                setWorking(service.name);
                                void onPortalAction(service.name, "restart")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
                                  .finally(() => setWorking(null));
                              }}
                              className="focus-ring rounded-control px-1.5 py-1 text-label font-semibold text-faint transition-colors phone:min-h-11 hover:text-fg disabled:opacity-45"
                            >
                              Restart
                            </button>
                            <button
                              type="button"
                              disabled={
                                working === service.name || !service.running
                              }
                              onClick={() => {
                                setError(null);
                                setWorking(service.name);
                                void onPortalAction(service.name, "stop")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
                                  .finally(() => setWorking(null));
                              }}
                              className="focus-ring rounded-control px-1.5 py-1 text-label font-semibold text-red transition-colors phone:min-h-11 hover:text-red disabled:opacity-45"
                            >
                              Stop
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="px-2 py-[7px] text-label text-dim">
                    {status.sandboxLifecycle === "waking" ||
                    status.sandboxLifecycle === "preparing"
                      ? "Waking the Sandbox…"
                      : "No Portals are running. Start one above, or ask the agent to expose a service."}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
