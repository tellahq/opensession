import { useState } from "react";
import { parseYouShouldKnowTitle } from "@tellahq/opensession-protocol/notices";
import { addYouShouldKnowTopic, saveYouShouldKnow } from "../lib/api";
import { errorMessage } from "../lib/error-message";
import { msgBody, msgSystemRow } from "../lib/msg-classes";
import type { TranscriptEntry } from "../lib/types";
import {
  requestYouShouldKnowChat,
  youShouldKnowChatText,
} from "../lib/you-should-know";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { toast } from "../ui/toast";
import {
  getYouShouldKnowUse,
  saveYouShouldKnowUse,
  youShouldKnowUseKey,
  type YouShouldKnowUse,
} from "../lib/you-should-know-used";
import {
  IconCheck,
  IconChevronDown,
  IconDotsHorizontal,
  IconLightbulb,
} from "./icons";
import { ClampedBody } from "./MessageBubble";
import { getCurrentUser } from "./UserPicker";

/**
 * A You should know note (server/you-should-know.ts) with the plugin's
 * answers: Learn more opens the explanation, Ask about this quotes the note
 * into the composer (with the cursor there) so the main agent can answer,
 * I knew this tells later checks to skip the topic, and Turn off (in the
 * card's ⋯ menu, so opening the menu is the confirmation the plugin's second
 * press used to be) switches the side agent off for this person. Once asked about or known, the card folds into
 * one muted line (remembered per device) that opens again on click; the
 * topic itself is remembered on the server.
 */
export function YouShouldKnowNotice({
  entry,
  sessionId,
}: {
  entry: TranscriptEntry;
  sessionId?: string;
}) {
  const notice = entry.notice!;
  const { tag, line } = parseYouShouldKnowTitle(notice.title);
  const explanation = notice.body ? entry.content : "";
  const useKey = youShouldKnowUseKey(sessionId, entry.id);
  const [use, setUseState] = useState<YouShouldKnowUse | undefined>(() =>
    getYouShouldKnowUse(useKey),
  );
  const [unfolded, setUnfolded] = useState(false);
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState(use !== undefined);
  const [off, setOff] = useState(false);

  function markUsed(next: YouShouldKnowUse | undefined) {
    setUseState(next);
    setUnfolded(false);
    setOpen(false);
    saveYouShouldKnowUse(useKey, next);
  }

  async function remember(quiet = false) {
    setKnown(true);
    if (!quiet) markUsed("known");
    try {
      await addYouShouldKnowTopic(getCurrentUser(), line);
    } catch (error) {
      setKnown(false);
      if (quiet) return;
      markUsed(undefined);
      toast(errorMessage(error, "Failed to save"), { variant: "error" });
    }
  }

  // As in the plugin, asking about a note also counts as having seen it, so
  // the same topic is not offered again.
  function ask() {
    if (!sessionId) return;
    requestYouShouldKnowChat(
      sessionId,
      youShouldKnowChatText(tag, line, explanation),
    );
    markUsed(use ?? "asked");
    if (!known) void remember(true);
  }

  async function turnOff() {
    try {
      await saveYouShouldKnow(getCurrentUser(), false);
      setOff(true);
      toast("You should know is off. Turn it back on in Settings.");
    } catch (error) {
      toast(errorMessage(error, "Failed to turn off You should know"), {
        variant: "error",
      });
    }
  }

  if (use && !unfolded) {
    return (
      <div className={msgSystemRow} data-eid={entry.id}>
        <Button
          size="sm"
          variant="ghost"
          className="flex w-full max-w-card justify-start self-start font-normal text-faint"
          icon={<IconCheck />}
          trailing={use === "asked" ? "Asked" : "Known"}
          onClick={() => setUnfolded(true)}
        >
          <span className="min-w-0 flex-1 truncate py-0.5 text-start">
            {tag} · {line}
          </span>
        </Button>
      </div>
    );
  }

  // Left-aligned with the agent's replies: the note is the side agent
  // talking, so it starts where the chat's text starts rather than floating
  // centered in the column like a system pill.
  return (
    <div className={msgSystemRow} data-eid={entry.id}>
      <div
        className="w-full max-w-card self-start rounded-2xl bg-panel px-4 pt-3 pb-3.5 text-left"
        role="group"
        aria-label={tag}
      >
        <div className="flex items-center gap-1.5 text-meta font-medium text-faint">
          <IconLightbulb size={20} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{tag}</span>
          {!off && (
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconDotsHorizontal size={20} />}
                    aria-label={`${tag} options`}
                    className="-my-1 -me-2 rounded-full text-faint"
                  />
                }
              />
              <Menu.Popup align="end">
                <Menu.Item onClick={() => void turnOff()}>
                  Turn off You should know
                </Menu.Item>
              </Menu.Popup>
            </Menu.Root>
          )}
        </div>
        <p className="mt-1.5 text-sm leading-5.5 text-fg">{line}</p>
        {open && explanation && (
          <ClampedBody
            className={cn(msgBody, "markdown mt-2")}
            content={explanation}
            entry={entry}
            sessionId={sessionId}
          />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 phone:gap-0.5">
          {sessionId && (
            <Button
              size="sm"
              variant="soft"
              className="rounded-full"
              onClick={ask}
            >
              Ask about this
            </Button>
          )}
          {explanation && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full phone:px-2"
              aria-expanded={open}
              trailing={
                <IconChevronDown
                  size={20}
                  className={cn(
                    "opacity-60 transition-transform motion-reduce:transition-none",
                    open && "rotate-180",
                  )}
                />
              }
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Hide" : "Learn more"}
            </Button>
          )}
          {!known && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full phone:px-2"
              onClick={() => void remember()}
            >
              I knew this
            </Button>
          )}
          {use && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full phone:px-2"
              onClick={() => setUnfolded(false)}
            >
              Fold
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
