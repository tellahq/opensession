import React, { use, useRef, useState } from "react";
import {
  suggestedTaskLink,
  type SuggestedTask,
} from "@tellahq/opensession-protocol/tool-presentation";
import { NavigationContext } from "../hooks/useNavigation";
import { createSessionApi } from "../lib/api";
import { BASE_PATH } from "../lib/base";
import { TOOL_CODE_WELL, TOOL_PRE } from "../lib/tool-classes";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Disclosure } from "../ui/disclosure";
import { toast } from "../ui/toast";
import { IconPencil, IconPlay } from "./icons";
import { getCurrentUser } from "./UserPicker";

/**
 * A follow-up the agent proposed with `suggest_task`: work it judged worth
 * doing but out of scope for what it was asked. The agent proposes, the person
 * decides. Nothing has run until they act, and the split button offers the
 * two ways to: "Start session" creates a new session from the instructions as
 * written and opens it, so the new session is the person's own rather than a
 * worker the agent spawned; the pencil half opens the composer prefilled with
 * the same instructions, for anyone who wants to edit them first. The
 * instructions sit folded under the card for reading before either.
 *
 * The pencil is an anchor to the same `/new?prompt=` link the tool result
 * carries, so cmd-click, middle-click and copy-link keep their meaning; a
 * plain click opens the composer in place. Start is a real button: it does
 * not navigate anywhere a link could describe. Once it has created the
 * session, `onStarted` lets the owner close the card for good.
 */
export function SuggestedTaskCard({
  task,
  onStarted,
}: {
  task: SuggestedTask;
  /** The new session exists; the owner closes the card. */
  onStarted?: () => void;
}) {
  // Null outside the app shell (a card in a test).
  const navigation = use(NavigationContext);
  const [starting, setStarting] = useState(false);
  // One id per card, so a second press while the first is in flight, or a
  // retry after a network error, lands on the same session.
  const requestIdRef = useRef<string | null>(null);
  const href = `${BASE_PATH}${suggestedTaskLink(task)}`;
  const prefill = {
    prompt: task.instructions,
    repo: task.repo,
    branch: task.branch,
    mode: task.mode ?? "code",
  } as const;

  async function start() {
    if (!navigation || starting) return;
    setStarting(true);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const { id } = await createSessionApi({
        ...prefill,
        user: getCurrentUser(),
        requestId: requestIdRef.current,
      });
      onStarted?.();
      navigation.openSession(id);
      return;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
    setStarting(false);
  }

  function edit(e: React.MouseEvent<HTMLAnchorElement>) {
    // A modified click keeps the browser's meaning: cmd-click a tab, shift a
    // window. Only a plain primary click is taken in place.
    if (
      !navigation ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      e.button !== 0
    )
      return;
    e.preventDefault();
    navigation.openPrefilledSession(prefill);
  }

  return (
    <Card as="article" data-suggested-task className="px-3.5 py-3">
      <div className="flex items-start gap-3 phone:flex-col phone:items-stretch">
        <div className="min-w-0 flex-1">
          <div className="text-meta leading-4 text-faint">
            Suggested task
            {task.repo ? ` · ${task.repo}` : ""}
            {task.mode === "ask" ? " · read-only" : ""}
          </div>
          <div className="mt-0.5 text-label font-semibold leading-5 text-fg">
            {task.title}
          </div>
          {task.description && (
            <p className="m-0 mt-0.5 text-label leading-5 text-dim">
              {task.description}
            </p>
          )}
        </div>
        {/* Split button: one ink plate, two halves. The hairline between
            them is on-accent ink so it reads on the fill in both themes. */}
        <div className="flex shrink-0 items-stretch">
          <Button
            variant="primary"
            size="sm"
            className="flex-1 rounded-r-none"
            icon={<IconPlay />}
            disabled={!navigation || starting}
            onClick={start}
          >
            {starting ? "Starting" : "Start session"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="rounded-l-none border-l-on-accent/25 phone:min-h-11 phone:w-11"
            icon={<IconPencil />}
            aria-label="Edit before starting"
            title="Edit before starting"
            render={<a href={href} onClick={edit} />}
          />
        </div>
      </div>
      <Disclosure title="Instructions" className="mt-1.5">
        <pre className={cn(TOOL_PRE, TOOL_CODE_WELL)}>{task.instructions}</pre>
      </Disclosure>
    </Card>
  );
}
