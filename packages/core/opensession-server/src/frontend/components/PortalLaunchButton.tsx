import { useEffect } from "react";
import type { PreviewPortalRecipe, PreviewStatus } from "../lib/api";
import { portalTargetFor, type PortalTarget } from "../lib/portals";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { IconPlayOutline } from "./icons";

/** The recipes the button can start, each with its open target once live. */
export function launchablePortals(
  sessionId: string,
  status: PreviewStatus | null,
): { recipe: PreviewPortalRecipe; target: PortalTarget | null }[] {
  const services = status?.services ?? [];
  return (status?.portalRecipes ?? [])
    .filter((recipe) => recipe.command || recipe.skill)
    .map((recipe) => {
      const service = recipe.serviceKey
        ? services.find((candidate) => candidate.key === recipe.serviceKey)
        : null;
      return {
        recipe,
        target: service ? portalTargetFor(sessionId, service) : null,
      };
    });
}

/**
 * The session header's play button: starts the repository's declared Portal
 * (or wakes it) and opens it in the Portal pane. Several declared Portals get
 * a menu. Hidden when the repository declares none.
 */
export function PortalLaunchButton({
  sessionId,
  status,
  launching,
  onLaunchingChange,
  onStart,
  onOpen,
}: {
  sessionId: string;
  status: PreviewStatus | null;
  launching: string | null;
  onLaunchingChange: (recipeId: string | null) => void;
  onStart: (recipe: PreviewPortalRecipe) => Promise<void>;
  onOpen: (target: PortalTarget) => void;
}) {
  const portals = launchablePortals(sessionId, status);
  const pending = portals.find((portal) => portal.recipe.id === launching);
  const pendingService = pending?.recipe.serviceKey
    ? status?.services.find(
        (service) => service.key === pending.recipe.serviceKey,
      )
    : null;

  // Open the Portal the moment the status poll reports it live, or give up
  // with a toast when its service fails.
  useEffect(() => {
    if (!launching) return;
    if (pending?.target) {
      onLaunchingChange(null);
      onOpen(pending.target);
    } else if (pendingService?.state === "failed") {
      onLaunchingChange(null);
      toast(`${pending?.recipe.name ?? "Portal"} failed to start`, {
        variant: "error",
      });
    }
  }, [launching, pending, pendingService, onLaunchingChange, onOpen]);

  if (!portals.length) return null;

  function launch(portal: (typeof portals)[number]) {
    if (portal.target) {
      onOpen(portal.target);
      return;
    }
    if (launching) return;
    const { recipe } = portal;
    // A skill-only recipe asks the agent to start it; nothing to wait on here.
    if (!recipe.command) {
      void onStart(recipe).catch(showError);
      return;
    }
    onLaunchingChange(recipe.id);
    void onStart(recipe).catch((cause) => {
      onLaunchingChange(null);
      showError(cause);
    });
  }

  const busy = launching != null;
  const icon = busy ? <Spinner size="md" /> : <IconPlayOutline size={20} />;
  const className = cn(
    "rounded-control text-dim hover:bg-hover hover:text-fg",
    portals.some((portal) => portal.target) && "text-green",
  );
  const label = busy
    ? `Starting ${pending?.recipe.name ?? "Portal"}`
    : portals.length === 1
      ? portals[0].target
        ? `Open ${portals[0].recipe.name}`
        : `Start ${portals[0].recipe.name}`
      : "Start a Portal";

  if (portals.length === 1)
    return (
      <Tooltip label={label}>
        <Button
          variant="ghost"
          size="md"
          className={className}
          icon={icon}
          aria-label={label}
          aria-busy={busy || undefined}
          onClick={() => launch(portals[0])}
        />
      </Tooltip>
    );

  return (
    <Menu.Root>
      <Tooltip label={label}>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="md"
              className={className}
              icon={icon}
            />
          }
          aria-label={label}
          aria-busy={busy || undefined}
        />
      </Tooltip>
      <Menu.Popup
        align="end"
        sideOffset={6}
        className="min-w-[220px] max-w-[min(300px,calc(100vw-24px))]"
      >
        {portals.map((portal) => (
          <Menu.Item
            key={portal.recipe.id}
            disabled={!portal.target && busy}
            onClick={() => launch(portal)}
          >
            <span className="min-w-0 grow truncate">{portal.recipe.name}</span>
            <span className="shrink-0 text-label text-faint">
              {portal.target
                ? "Open"
                : launching === portal.recipe.id
                  ? "Starting"
                  : "Start"}
            </span>
          </Menu.Item>
        ))}
      </Menu.Popup>
    </Menu.Root>
  );
}

function showError(cause: unknown) {
  toast(cause instanceof Error ? cause.message : String(cause), {
    variant: "error",
  });
}
