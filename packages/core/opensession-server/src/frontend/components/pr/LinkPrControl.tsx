import { useState } from "react";
import { IconLink } from "../icons";
import { linkPrApi } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/input";
import { Popover } from "../../ui/popover";
import { toast } from "../../ui/toast";
import type { LinkedPrEntry } from "../PrPanel";

/**
 * Opens the link flow in an anchored modal instead of replacing the action row.
 * Linking accepts any PR in a registered repo.
 */
export function LinkPrControl({
  sessionId,
  variant,
  onLinked,
}: {
  sessionId: string;
  variant: "tab" | "action";
  onLinked: (all: LinkedPrEntry[], linked: LinkedPrEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const url = val.trim();
    if (!url || busy) return;
    setBusy(true);
    await (async () => {
      const res = await linkPrApi(sessionId, url);
      onLinked(res.all, res.linked);
      toast(
        `Linked ${res.linked.repo}${res.linked.number ? ` #${res.linked.number}` : ""}`,
      );
      setVal("");
      setOpen(false);
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Couldn't link that PR"));
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  const tab = variant === "tab";

  return (
    <Popover.Root
      open={open}
      onOpenChange={setOpen}
      modal="trap-focus"
      exclusive={false}
    >
      <Popover.Trigger
        render={
          <Button
            variant={tab ? "ghost" : "soft"}
            size="sm"
            className={tab ? "px-2.5 text-xs text-faint" : ""}
            icon={tab ? undefined : <IconLink size={20} />}
            title="Link another PR to this session"
          >
            {tab ? "+" : "Link PR…"}
          </Button>
        }
      />
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className="w-[min(380px,calc(100vw-16px))] p-4"
      >
        <form
          className="flex flex-col gap-4"
          aria-label="Link pull request"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <div className="text-label font-semibold text-fg">
              Link pull request
            </div>
            <div className="mt-1 text-meta text-dim">
              Paste a GitHub pull request URL.
            </div>
          </div>
          <Field label="Pull request URL">
            <Input
              autoFocus
              className="phone:min-h-11 phone:text-input-phone"
              placeholder="https://github.com/org/repo/pull/123"
              value={val}
              onChange={(event) => setVal(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2.5">
            <Popover.Close
              render={
                <Button variant="soft" disabled={busy}>
                  Cancel
                </Button>
              }
            />
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !val.trim()}
            >
              {busy ? "Linking…" : "Link PR"}
            </Button>
          </div>
        </form>
      </Popover.Popup>
    </Popover.Root>
  );
}
