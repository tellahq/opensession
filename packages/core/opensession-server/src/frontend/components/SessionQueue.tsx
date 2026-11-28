import * as stylex from "@stylexjs/stylex";
import { isGitHubAttribution } from "@tellahq/opensession-protocol/notices";
import { pastedTextLineLabel } from "@tellahq/opensession-protocol/pasted-text";
import { Reorder } from "motion/react";
import type { TranscriptEntry } from "../lib/types";
import {
  queueAttribution,
  classifyQueuedContent,
} from "../lib/transcript-state";
import type { OptimisticPendingPrompt } from "../lib/pending-reconcile";
import type { PromptOutboxItem } from "../lib/prompt-outbox";
import { queueDeleteLabel, type QueueReceipt } from "../lib/session-queue";
import { personKey } from "../lib/review-queue";
import {
  composerQueue,
  composerQueueBody,
  composerQueueBodyTone,
  composerQueueContent,
  composerQueueFrom,
  composerQueuePasted,
  composerQueueImage,
  composerQueueImageCount,
  composerQueueImageThumb,
  composerQueueItem,
  composerQueueItemDraggable,
  composerQueueItemSeparated,
  composerQueueList,
  composerQueueSendingShimmer,
  composerQueueSendingStatus,
} from "../lib/composer-classes";
import { Button } from "../ui/button";
import { section } from "../ui/section";
import { media, space } from "../ui/tokens.stylex";
import { cn } from "../ui/cn";
import { TextShimmer } from "../ui/text-shimmer";
import { Tooltip } from "../ui/tooltip";
import { IconArrowUp, IconPencil, IconPullRequest, IconTrash } from "./icons";

const styles = stylex.create({
  /** A row's controls, at its trailing edge (written first, painted last).
   *  The negative block margins keep the cluster from setting the height of
   *  a one-line row. */
  actions: {
    order: 1,
    zIndex: 1,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    marginBlock: {
      default: `calc(-1 * ${space.s4})`,
      [media.phone]: `calc(-1 * ${space.s12})`,
    },
  },
});

interface Props {
  currentUser: string;
  queueTitle: string;
  shownQueued: QueueReceipt[];
  queuedClassified: TranscriptEntry[];
  pendingQueue: OptimisticPendingPrompt[];
  durableOutbox: PromptOutboxItem[];
  settingUpWorkspace: boolean;
  onReorder: (items: QueueReceipt[]) => void;
  onReorderStart: () => void;
  onReorderEnd: () => void;
  onEditQueued: (item: QueueReceipt) => void;
  onDeleteQueued: (queueId: string | undefined, queueIndex: number) => void;
  onSteerQueued: (queueId: string | undefined, queueIndex: number) => void;
  onRetryOutbox: (clientId: string) => void;
  onEditOutbox: (item: PromptOutboxItem) => void;
  onDiscardOutbox: (item: PromptOutboxItem) => void;
}

interface QueueContentProps {
  item: Pick<QueueReceipt, "content" | "user" | "images" | "pastedTexts">;
  classified: TranscriptEntry;
  currentUser: string;
  github?: boolean;
  tone?: keyof typeof composerQueueBodyTone;
}

function QueueContent({
  item,
  classified,
  currentUser,
  github = false,
  tone = "default",
}: QueueContentProps) {
  const firstImage = item.images?.[0];
  const extraImages = Math.max(0, (item.images?.length ?? 0) - 1);
  // A paste rides beside the text, so a queued row names it rather than
  // reading as if the message lost it.
  const pasted = item.pastedTexts?.length ? item.pastedTexts : undefined;
  const pastedLabel = pasted
    ? pasted.length === 1
      ? `Pasted text ${pastedTextLineLabel(pasted[0]!)}`
      : `${pasted.length} pasted texts`
    : null;
  const isReview = classified.notice?.kind === "review-handoff";
  const from = isReview ? null : queueAttribution(classified, currentUser);
  const body = isReview
    ? `${classified.notice!.title} · Runs after this turn`
    : classified.content;

  return (
    <div className={composerQueueContent}>
      {isReview && (
        <IconPullRequest size={20} className="flex-none text-faint" />
      )}
      {firstImage && (
        <div className={composerQueueImage}>
          <img className={composerQueueImageThumb} src={firstImage} alt="" />
          {extraImages > 0 && (
            <span className={composerQueueImageCount}>+{extraImages}</span>
          )}
        </div>
      )}
      <div className={cn(composerQueueBody, composerQueueBodyTone[tone])}>
        {from && <span className={composerQueueFrom}>{from}</span>}
        {github && !isReview && (
          <span className={composerQueueFrom}>GitHub</span>
        )}
        {body}
        {pastedLabel && (
          <span className={composerQueuePasted}>
            {" · "}
            {pastedLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export function SessionQueue({
  currentUser,
  queueTitle,
  shownQueued,
  queuedClassified,
  pendingQueue,
  durableOutbox,
  settingUpWorkspace,
  onReorder,
  onReorderStart,
  onReorderEnd,
  onEditQueued,
  onDeleteQueued,
  onSteerQueued,
  onRetryOutbox,
  onEditOutbox,
  onDiscardOutbox,
}: Props) {
  return (
    <div className={composerQueue} aria-label="Queued messages">
      <div {...stylex.props(section.label)}>{queueTitle}</div>
      <Reorder.Group
        as="div"
        axis="y"
        values={shownQueued}
        onReorder={onReorder}
        className={composerQueueList}
      >
        {shownQueued.map((item, index) => {
          const classified = queuedClassified[index]!;
          const github = isGitHubAttribution(item.user);
          const delegated =
            classified.notice?.kind === "worker-report" ||
            classified.notice?.kind === "session-notice";
          const canSteer =
            !github &&
            !(Array.isArray(item.files) && item.files.length > 0) &&
            !item.contextSessions?.length;
          const canEdit =
            !github &&
            !delegated &&
            item.editable === true &&
            personKey(item.user || "") === personKey(currentUser);
          const canReorder = shownQueued.length > 1 && !github && !delegated;
          const label = queueDeleteLabel(classified);
          return (
            <Reorder.Item
              as="div"
              key={item.id || `queued-${index}`}
              value={item}
              dragListener={canReorder}
              onDragStart={onReorderStart}
              onDragEnd={onReorderEnd}
              whileDrag={{ scale: 1.01, zIndex: 2 }}
              className={cn(
                composerQueueItem,
                index > 0 && composerQueueItemSeparated,
                canReorder && composerQueueItemDraggable,
              )}
            >
              <div {...stylex.props(styles.actions)}>
                {canEdit && (
                  <Tooltip label="Edit in composer">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconPencil />}
                      aria-label="Edit in composer"
                      onClick={() => onEditQueued(item)}
                    />
                  </Tooltip>
                )}
                <Tooltip label={label}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash />}
                    aria-label={label}
                    onClick={() => onDeleteQueued(item.id, index)}
                  />
                </Tooltip>
                {!github && (
                  <Tooltip
                    label={
                      canSteer
                        ? "Send now: add to the conversation and deliver after the current step"
                        : "Messages with files must remain queued"
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconArrowUp />}
                      aria-label="Send now"
                      disabled={!canSteer}
                      onClick={() => onSteerQueued(item.id, index)}
                    />
                  </Tooltip>
                )}
              </div>
              <QueueContent
                item={item}
                classified={classified}
                currentUser={currentUser}
                github={github}
                tone={
                  github ? "github" : classified.senderVia ? "human" : "default"
                }
              />
            </Reorder.Item>
          );
        })}
      </Reorder.Group>

      {pendingQueue.map((item, index) => (
        <div
          key={item.id}
          className={cn(
            composerQueueItem,
            index > 0 && composerQueueItemSeparated,
          )}
        >
          <div {...stylex.props(styles.actions)}>
            <span className={composerQueueSendingStatus} role="status">
              {settingUpWorkspace ? (
                "Queued"
              ) : (
                <TextShimmer className={composerQueueSendingShimmer}>
                  Queueing
                </TextShimmer>
              )}
            </span>
          </div>
          <QueueContent
            item={item}
            classified={classifyQueuedContent(item.content, item.user)}
            currentUser={currentUser}
            tone="sending"
          />
        </div>
      ))}

      {durableOutbox.map((item, index) => (
        <div
          key={item.clientId}
          className={cn(
            composerQueueItem,
            item.state === "failed" && "flex-col items-stretch gap-1.5",
            (index > 0 || pendingQueue.length > 0) &&
              composerQueueItemSeparated,
          )}
        >
          {item.state !== "failed" && (
            <div {...stylex.props(styles.actions)}>
              <span className={composerQueueSendingStatus} role="status">
                <TextShimmer className={composerQueueSendingShimmer}>
                  {item.state === "sending" ? "Sending" : "Waiting to send"}
                </TextShimmer>
              </span>
            </div>
          )}
          <QueueContent
            item={item}
            classified={classifyQueuedContent(item.content, item.user)}
            currentUser={currentUser}
            tone="sending"
          />
          {item.state === "failed" && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-meta text-red" role="alert">
                {item.error || "This message could not be delivered."}
              </span>
              <Button
                variant="soft"
                size="sm"
                onClick={() => onRetryOutbox(item.clientId)}
              >
                Retry
              </Button>
              <Button
                variant="soft"
                size="sm"
                onClick={() => onEditOutbox(item)}
              >
                Edit
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDiscardOutbox(item)}
              >
                Discard
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
