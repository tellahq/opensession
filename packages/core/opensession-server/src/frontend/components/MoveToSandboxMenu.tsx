import { useEffect, useState } from "react";
import { fetchSandboxStatus } from "../lib/api/automations";
import { ApiError } from "../lib/api/request";
import { attachSandbox } from "../lib/api/sandboxes";
import { errorMessage } from "../lib/error-message";
import {
  readySandboxProviders,
  sandboxProviderLabel,
} from "../lib/ready-sandbox-providers";
import { Menu, MENU_ICON } from "../ui/menu";
import type { ConfirmRequest } from "../ui/confirm";
import { toast } from "../ui/toast";
import { IconBox, IconChevronRight } from "./icons";
import { getCurrentUser } from "./UserPicker";

/** What decides whether a host session may move into a Sandbox. */
export type MoveToSandboxSession = {
  id: string;
  mode?: string;
  repo?: string;
  automation?: string;
  automationId?: string;
  sandbox?: { provider: string } | null;
  runner?: object | null;
};

/** A code session on this machine, with a repo to clone and no automation
 * or Runner pinning it here. Once it carries a Sandbox the move is done. */
export function canMoveToSandbox(session: MoveToSandboxSession): boolean {
  return (
    session.mode === "code" &&
    !!session.repo &&
    !session.automation &&
    !session.automationId &&
    !session.runner &&
    (!session.sandbox?.provider || session.sandbox.provider === "local")
  );
}

/** The ⋯ menu entry that moves a session running on this machine into a
 * Sandbox. A rare, one-way choice, so it lives with the other session
 * actions rather than on its own header badge. Providers resolve when the
 * submenu opens; the move itself goes through the confirm dialog, because
 * from the next message on the agent runs somewhere else. */
export function MoveToSandboxMenu({
  session,
  running,
  confirm,
  onClose,
}: {
  session: MoveToSandboxSession;
  /** The agent is mid-turn; a move has to wait for it. */
  running: boolean;
  confirm: (request: ConfirmRequest) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        if (!cancelled) setProviders(readySandboxProviders(status));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function move(provider: string, confirmed: boolean) {
    await attachSandbox(session.id, provider, { confirm: confirmed })
      .then(async () => {
        toast(
          `Moving to ${sandboxProviderLabel(provider)}. The next message runs there.`,
        );
      })
      .catch(async (cause: unknown) => {
        // 428: work that exists only here would stay behind. Ask, then move.
        if (cause instanceof ApiError && cause.status === 428 && !confirmed) {
          confirm({
            title: `Move to ${sandboxProviderLabel(provider)} anyway?`,
            description: cause.message,
            confirmLabel: "Move",
            destructive: true,
            onConfirm: () => void move(provider, true),
          });
          return;
        }
        toast(errorMessage(cause, "Could not move to a Sandbox"));
      });
  }

  function pick(provider: string) {
    onClose();
    confirm({
      title: `Move to ${sandboxProviderLabel(provider)}?`,
      description:
        "The Sandbox starts now, clones this branch from origin, and takes over on the next message. Portals on this machine stop.",
      confirmLabel: "Move",
      onConfirm: () => void move(provider, false),
    });
  }

  return (
    <Menu.SubmenuRoot open={open} onOpenChange={setOpen}>
      <Menu.SubmenuTrigger
        disabled={running}
        title={
          running
            ? "Available once the agent finishes"
            : "Run this session in a Sandbox from the next message on"
        }
        data-testid="move-to-sandbox"
      >
        <IconBox size={20} className={MENU_ICON} />
        <span className="grow">Move to Sandbox</span>
        <IconChevronRight size={16} className="text-faint" />
      </Menu.SubmenuTrigger>
      <Menu.Popup className="min-w-[220px] max-w-[300px]">
        {providers === null ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            Checking Sandboxes…
          </div>
        ) : providers.length === 0 ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            No Sandbox is ready. Connect Daytona or Box in Workspace &gt;
            Sandboxes.
          </div>
        ) : (
          providers.map((provider) => (
            <Menu.Item
              key={provider}
              onClick={() => pick(provider)}
              title={`Move this session to ${sandboxProviderLabel(provider)}`}
            >
              <span className="grow">{sandboxProviderLabel(provider)}</span>
            </Menu.Item>
          ))
        )}
      </Menu.Popup>
    </Menu.SubmenuRoot>
  );
}
