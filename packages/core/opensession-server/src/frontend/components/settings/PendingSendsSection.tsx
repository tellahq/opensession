import { useCallback, useEffect, useState } from "react";
import {
  localCommandScope,
  wsCommandOutboxForScope,
  type WsCommandOutbox,
} from "../../lib/ws-command-outbox";
import { Button } from "../../ui/button";
import { useConfirm } from "../../ui/confirm";
import {
  SettingCard,
  SettingGroup,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { SettingRow } from "./shared";

type PendingSend = {
  requestId: string;
  type: string;
  outbox: WsCommandOutbox;
};

function activeCommandScope(): string {
  try {
    return (
      localStorage.getItem("opensession-command-scope") || localCommandScope()
    );
  } catch {
    return localCommandScope();
  }
}

function readPendingSends(): PendingSend[] {
  const byId = new Map<string, PendingSend>();
  const outboxes = new Set([
    wsCommandOutboxForScope(activeCommandScope()),
    wsCommandOutboxForScope(localCommandScope()),
  ]);
  for (const outbox of outboxes)
    for (const command of outbox.pending())
      byId.set(command.requestId, {
        requestId: command.requestId,
        type: command.type,
        outbox,
      });
  return [...byId.values()];
}

/** Commands saved in local storage for replay after a reconnect. They block
 * new sends once their byte budget is spent, so this is the way out. */
export function PendingSendsSection() {
  const [sends, setSends] = useState<PendingSend[]>(readPendingSends);
  const [confirm, confirmDialog] = useConfirm();
  const refresh = useCallback(() => setSends(readPendingSends()), []);
  useEffect(() => {
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [refresh]);
  if (sends.length === 0) return null;
  const forget = (targets: PendingSend[]) => {
    for (const send of targets) send.outbox.forget(send.requestId);
    refresh();
  };
  return (
    <>
      <SettingsGroupLabel>Pending sends</SettingsGroupLabel>
      <SettingCard>
        <SettingGroup>
          {sends.map((send) => (
            <SettingRow
              key={send.requestId}
              title={send.type}
              desc={send.requestId}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() =>
                      window.dispatchEvent(
                        new Event("opensession-command-outbox-retry"),
                      )
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      confirm({
                        title: "Forget this pending send?",
                        description: "It may already have reached the server.",
                        confirmLabel: "Forget",
                        destructive: true,
                        onConfirm: () => forget([send]),
                      })
                    }
                  >
                    Forget
                  </Button>
                </div>
              }
            />
          ))}
        </SettingGroup>
      </SettingCard>
      <SettingsHint>
        Saved for replay after a reconnect.{" "}
        {sends.length > 1 && (
          <button
            type="button"
            className="text-fg underline underline-offset-2"
            onClick={() =>
              confirm({
                title: `Forget all ${sends.length} pending sends?`,
                description: "Some may already have reached the server.",
                confirmLabel: "Forget all",
                destructive: true,
                onConfirm: () => forget(sends),
              })
            }
          >
            Forget all
          </button>
        )}
      </SettingsHint>
      {confirmDialog}
    </>
  );
}
