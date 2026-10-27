import { useEffect, useState } from "react";
import { fetchSandboxStatus } from "../lib/api/automations";
import { ApiError } from "../lib/api/request";
import { attachSandbox, detachSandbox } from "../lib/api/sandboxes";
import { errorMessage } from "../lib/error-message";
import {
  readySandboxProviders,
  sandboxMachineChoices,
  sandboxProviderLabel,
  splitSandboxChoice,
} from "../lib/ready-sandbox-providers";
import { Menu, MENU_ICON } from "../ui/menu";
import type { ConfirmRequest } from "../ui/confirm";
import { toast } from "../ui/toast";
import { IconBox, IconChevronRight } from "./icons";
import { getCurrentUser } from "./UserPicker";

/** What decides whether a session may move between machines. */
export type MoveToSandboxSession = {
  id: string;
  mode?: string;
  repo?: string;
  automation?: string;
  automationId?: string;
  sandbox?: { provider: string; sandboxId?: string } | null;
  /** The GPU its Modal Sandbox carries, if any. */
  sandboxGpu?: string;
  runner?: object | null;
};

/** The Sandbox provider a session runs on, or null on this machine. */
export function currentSandboxProvider(
  session: MoveToSandboxSession,
): string | null {
  const provider = session.sandbox?.provider;
  return provider && provider !== "local" ? provider : null;
}

/** A code session with a repo and no automation or Runner pinning it. It may
 * move from this machine into a Sandbox, from a Sandbox to another provider,
 * or from a Sandbox back to this machine. */
export function canMoveToSandbox(session: MoveToSandboxSession): boolean {
  return (
    session.mode === "code" &&
    !!session.repo &&
    !session.automation &&
    !session.automationId &&
    !session.runner
  );
}

/** The ⋯ menu entry that moves a session to another machine. Providers
 * resolve when the submenu opens; the move itself goes through the confirm
 * dialog, because from the next message on the agent runs somewhere else.
 * Work travels along as a checkpoint on origin wherever the repository can
 * hold one; the server asks before leaving anything behind. */
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
  const current = currentSandboxProvider(session);

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

  /** `choice` is a Machine-menu entry: a provider, or Modal with a GPU
   *  (`modal:T4`). */
  async function moveToSandbox(choice: string, confirmed: boolean) {
    const { provider, gpu } = splitSandboxChoice(choice);
    await attachSandbox(session.id, provider, { confirm: confirmed, gpu })
      .then(async () => {
        toast(
          `Moving to ${sandboxProviderLabel(choice)}. The next message runs there.`,
        );
      })
      .catch(async (cause: unknown) => {
        // 428: work that exists only here would stay behind. Ask, then move.
        if (cause instanceof ApiError && cause.status === 428 && !confirmed) {
          confirm({
            title: `Move to ${sandboxProviderLabel(choice)} anyway?`,
            description: cause.message,
            confirmLabel: "Move",
            destructive: true,
            onConfirm: () => void moveToSandbox(choice, true),
          });
          return;
        }
        toast(errorMessage(cause, "Could not move to a Sandbox"));
      });
  }

  const movedToHost = () =>
    toast("Moved to this machine. The next message runs here.");
  const hostMoveFailed = (cause: unknown) =>
    toast(errorMessage(cause, "Could not move to this machine"));

  async function moveToHost() {
    await detachSandbox(session.id)
      .then(movedToHost)
      .catch((cause: unknown) => {
        // 428: no checkpoint could be taken; the move would start from the
        // branch as origin has it. Ask, then move.
        if (cause instanceof ApiError && cause.status === 428) {
          confirm({
            title: "Move to this machine anyway?",
            description: cause.message,
            confirmLabel: "Move",
            destructive: true,
            onConfirm: () =>
              void detachSandbox(session.id, { confirm: true })
                .then(movedToHost)
                .catch(hostMoveFailed),
          });
          return;
        }
        hostMoveFailed(cause);
      });
  }

  function pickSandbox(provider: string) {
    onClose();
    confirm({
      title: `Move to ${sandboxProviderLabel(provider)}?`,
      description: current
        ? `The current Sandbox's files are checkpointed and restored on ${sandboxProviderLabel(provider)}, then the old Sandbox is released. Portals restart there.`
        : "The Sandbox starts now with this branch and its uncommitted changes, and takes over on the next message. Portals on this machine stop.",
      confirmLabel: "Move",
      onConfirm: () => void moveToSandbox(provider, false),
    });
  }

  function pickHost() {
    onClose();
    confirm({
      title: "Move to this machine?",
      description:
        "The Sandbox's files are checkpointed and restored into a worktree on this server, then the Sandbox is released. Its Portals stop.",
      confirmLabel: "Move",
      onConfirm: () => void moveToHost(),
    });
  }

  // Modal offers one entry per GPU; the machine the session is on now is
  // left out.
  const here = current
    ? session.sandboxGpu
      ? `${current}:${session.sandboxGpu}`
      : current
    : null;
  const destinations = sandboxMachineChoices(providers || []).filter(
    (choice) => choice !== here,
  );

  return (
    <Menu.SubmenuRoot open={open} onOpenChange={setOpen}>
      <Menu.SubmenuTrigger
        disabled={running}
        title={
          running
            ? "Available once the agent finishes"
            : current
              ? "Run this session on another machine from the next message on"
              : "Run this session in a Sandbox from the next message on"
        }
        data-testid="move-to-sandbox"
      >
        <IconBox size={20} className={MENU_ICON} />
        <span className="grow">
          {current ? "Move session" : "Move to Sandbox"}
        </span>
        <IconChevronRight size={16} className="text-faint" />
      </Menu.SubmenuTrigger>
      <Menu.Popup className="min-w-[220px] max-w-[300px]">
        {current && (
          <Menu.Item
            onClick={pickHost}
            title="Move this session back to a worktree on this server"
          >
            <span className="grow">This machine</span>
          </Menu.Item>
        )}
        {providers === null ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            Checking Sandboxes…
          </div>
        ) : destinations.length === 0 ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            {current
              ? "No other Sandbox provider is ready."
              : "No Sandbox is ready. Connect Daytona or Boat in Workspace > Sandboxes."}
          </div>
        ) : (
          destinations.map((provider) => (
            <Menu.Item
              key={provider}
              onClick={() => pickSandbox(provider)}
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
