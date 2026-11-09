import { useEffect, useRef, useState } from "react";
import type { HuddleMember } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Modal } from "../../ui/modal";
import { OverlayAction } from "../../ui/overlay-action";
import { IconExpand } from "../icons";

/** A live stream in a muted, inline video element. */
function StreamVideo({
  stream,
  className,
  label,
}: {
  stream: MediaStream;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      aria-label={label}
      className={cn("bg-black object-contain", className)}
    />
  );
}

/**
 * Whatever is being shared in the huddle: a preview in the dock that opens
 * large, and a picker when more than one person shares. Your own share shows
 * as a small preview so you know what everyone sees.
 */
export function HuddleScreen({
  sharers,
  screens,
  ownScreen,
}: {
  sharers: HuddleMember[];
  screens: Record<string, MediaStream>;
  ownScreen: MediaStream | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const visible = sharers.filter((m) => screens[m.peerId]);
  const shown =
    visible.find((m) => m.peerId === picked) ?? visible.at(-1) ?? null;
  const stream = shown ? screens[shown.peerId] : undefined;

  if (!shown || !stream)
    return ownScreen ? (
      <div className="flex items-center gap-2 px-0.5">
        <StreamVideo
          stream={ownScreen}
          label="Your shared screen"
          className="aspect-video w-24 shrink-0 rounded-md"
        />
        <p className="m-0 text-meta text-dim">
          You're sharing your screen with everyone in the huddle.
        </p>
      </div>
    ) : null;

  const title = `${shown.user}'s screen`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="group/overlay-action relative">
        <StreamVideo
          stream={stream}
          label={title}
          className="aspect-video w-full rounded-md"
        />
        <OverlayAction
          aria-label={`Open ${title} large`}
          icon={<IconExpand size={18} />}
          className="top-1.5 right-1.5 phone:size-11"
          onClick={() => setExpanded(true)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 px-0.5 text-meta text-dim">
        {visible.length > 1 ? (
          visible.map((m) => (
            <Button
              key={m.peerId}
              size="sm"
              variant={m.peerId === shown.peerId ? "soft" : "ghost"}
              aria-pressed={m.peerId === shown.peerId}
              onClick={() => setPicked(m.peerId)}
            >
              {m.user}
            </Button>
          ))
        ) : (
          <span className="truncate">{title}</span>
        )}
      </div>
      <Modal.Root open={expanded} onOpenChange={setExpanded}>
        <Modal.Content widthClassName="max-w-[min(1600px,96vw)]">
          <Modal.Header title={title} />
          <StreamVideo
            stream={stream}
            label={title}
            className="max-h-[78vh] w-full rounded-md"
          />
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
