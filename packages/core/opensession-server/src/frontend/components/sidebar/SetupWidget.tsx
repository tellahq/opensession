import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import type { SettingsSectionKey } from "../../lib/settings-sections";
import {
  dismissSetupWidget,
  setupWidgetDismissed,
  setupWidgetItems,
  visibleSetupWidgetItems,
  type SetupWidgetItem,
} from "../../lib/setup-widget";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import {
  IconBranches,
  IconCheck,
  IconCheckCircleFilled,
  IconChevronDown,
  IconConnections,
  IconGlobe,
  IconMessage,
  IconPeople,
  IconPlug,
  IconServer,
  "IconShapes" as IconModels,
  IconX,
} from "../icons";

function SetupStepIcon({ id }: { id: SetupWidgetItem["id"] }) {
  switch (id) {
    case "server":
      return <IconServer size={20} />;
    case "github":
      return <IconConnections size={20} />;
    case "models":
      return <IconModels size={20} />;
    case "repository":
      return <IconBranches size={20} />;
    case "domain":
      return <IconGlobe size={20} />;
    case "tools":
      return <IconPlug size={20} />;
    case "members":
      return <IconPeople size={20} />;
    case "session":
      return <IconMessage size={20} />;
  }
}

function SetupStep({
  item,
  complete,
  onOpenSettings,
  onNewSession,
}: {
  item: SetupWidgetItem;
  complete: boolean;
  onOpenSettings: (section?: SettingsSectionKey) => void;
  onNewSession: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "focus-ring flex min-h-9 w-full items-center gap-1.5 rounded-control px-1.5 text-left text-label font-medium transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover active:scale-[0.96] phone:min-h-11",
        complete ? "text-dim" : "text-fg",
      )}
      onClick={() =>
        item.target === "new-session"
          ? onNewSession()
          : onOpenSettings(item.target)
      }
    >
      <span
        className="flex size-7 shrink-0 items-center justify-center text-dim"
        aria-hidden="true"
      >
        <SetupStepIcon id={item.id} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {complete ? (
        <IconCheckCircleFilled
          size={20}
          className="mr-1 shrink-0 text-accent"
          aria-hidden="true"
        />
      ) : (
        <span
          className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-transparent"
          aria-hidden="true"
        >
          <IconCheck size={16} />
        </span>
      )}
    </button>
  );
}

export function SetupWidget({
  placement,
  hasCreatedSession,
  onOpenSettings,
  onNewSession,
}: {
  placement: "desktop" | "phone";
  hasCreatedSession: boolean;
  onOpenSettings: (section?: SettingsSectionKey) => void;
  onNewSession: () => void;
}) {
  const [dismissed, setDismissed] = useState(setupWidgetDismissed);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const setup = useSetupStatus();
  if (dismissed || !setup.status) return null;

  const items = setupWidgetItems(setup.status, hasCreatedSession);
  const completed = items.filter((item) => item.complete);
  if (completed.length === items.length) return null;
  const visibleItems = visibleSetupWidgetItems(items);

  const progress = (completed.length / items.length) * 100;
  const completedLabel = `${completed.length} ${completed.length === 1 ? "step" : "steps"} checked`;

  if (placement === "desktop" && !desktopOpen) {
    return (
      <aside
        aria-label="Get started"
        className="mx-2 mb-2 flex flex-none items-center gap-2 rounded-xl border border-divider-soft bg-popup-glass py-1.5 pr-1.5 pl-3 [backdrop-filter:var(--popup-blur)] smooth-shadow-sm"
        onPointerEnter={() => void setup.refetch()}
        onFocusCapture={() => void setup.refetch()}
      >
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="max-w-full truncate text-supporting font-medium leading-[1.3] text-fg">
            Get started
          </span>
          <span className="tabular-nums text-meta leading-[1.3] text-faint">
            {completed.length} of {items.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setDesktopOpen(true)}
          >
            Open
          </Button>
          <Tooltip label="Dismiss" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<IconX size={16} />}
              aria-label="Dismiss setup checklist"
              onClick={() => {
                dismissSetupWidget();
                setDismissed(true);
              }}
            />
          </Tooltip>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-labelledby="sidebar-setup-title"
      className={cn(
        "z-30 flex-none rounded-2xl border border-divider-soft bg-popup-glass p-2 [backdrop-filter:var(--popup-blur)] smooth-shadow-sm",
        placement === "desktop" ? "mx-2 mb-2" : "mx-3 mt-3 mb-20",
      )}
      style={placement === "phone" ? { order: 100 } : undefined}
      onPointerEnter={() => void setup.refetch()}
      onFocusCapture={() => void setup.refetch()}
    >
      <div className="flex min-h-10 items-center gap-2 pl-2">
        <h2
          id="sidebar-setup-title"
          className="m-0 shrink-0 text-label font-semibold text-fg"
        >
          Get started
        </h2>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={completed.length}
            className="h-1 w-8 overflow-hidden rounded-[999px] bg-active"
          >
            <div
              className="h-full rounded-[999px] bg-accent"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="tabular-nums text-meta text-faint">
            {completed.length} of {items.length}
          </span>
        </div>
        <Tooltip label="Dismiss">
          <button
            type="button"
            aria-label="Dismiss setup checklist"
            className="focus-ring flex size-10 shrink-0 items-center justify-center rounded-control text-faint transition-[color,background-color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:size-11"
            onClick={() => {
              dismissSetupWidget();
              setDismissed(true);
            }}
          >
            <IconX size={20} />
          </button>
        </Tooltip>
      </div>

      {completed.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={completedOpen}
            className="focus-ring flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-label font-medium text-dim transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:min-h-11"
            onClick={() => setCompletedOpen((open) => !open)}
          >
            <IconCheckCircleFilled
              size={20}
              className="ml-1 shrink-0 text-accent"
            />
            <span className="min-w-0 flex-1 truncate">{completedLabel}</span>
            <IconChevronDown
              size={20}
              className={cn(
                "mr-0.5 shrink-0 transition-transform duration-[var(--dur-micro)]",
                completedOpen && "rotate-180",
              )}
            />
          </button>
          {completedOpen && (
            <div className="flex flex-col">
              {completed.map((item) => (
                <SetupStep
                  key={item.id}
                  item={item}
                  complete
                  onOpenSettings={onOpenSettings}
                  onNewSession={onNewSession}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col">
        {visibleItems.map((item) => (
          <SetupStep
            key={item.id}
            item={item}
            complete={false}
            onOpenSettings={onOpenSettings}
            onNewSession={onNewSession}
          />
        ))}
      </div>
    </aside>
  );
}
