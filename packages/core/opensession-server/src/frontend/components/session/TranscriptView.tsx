import React from "react";
import { OpenAssetPathsProvider } from "../../lib/open-asset";
import { MessageLinkProvider } from "../../lib/message-link";
import { cn } from "../../ui/cn";
import { SessionTranscript } from "../SessionTranscript";
import {
  LiveSubagentsProvider,
  OpenAssetProvider,
  ToolPathRootsProvider,
} from "../ToolCallBlock";

type SessionTranscriptProps = React.ComponentProps<typeof SessionTranscript>;

type TranscriptViewProps = SessionTranscriptProps & {
  openSettlePending: boolean;
  assetPaths: readonly string[];
  toolPathRoots: React.ComponentProps<typeof ToolPathRootsProvider>["value"];
  liveSubagents: React.ComponentProps<typeof LiveSubagentsProvider>["value"];
  openAsset: (path: string) => void;
  /** Builds a link to one message; null offers no "Copy link". */
  messageLink: ((entryId: string) => string) | null;
  onRender: React.ProfilerOnRenderCallback;
};

/** The virtualized transcript and live stream tail with their shared contexts. */
export function TranscriptView({
  openSettlePending,
  assetPaths,
  toolPathRoots,
  liveSubagents,
  openAsset,
  messageLink,
  onRender,
  ...transcript
}: TranscriptViewProps) {
  return (
    <div
      className={cn(
        "w-full shrink-0 motion-safe:transition-opacity motion-safe:duration-150",
        openSettlePending && "opacity-0",
      )}
    >
      <OpenAssetPathsProvider value={assetPaths}>
        <React.Profiler id="transcript" onRender={onRender}>
          <ToolPathRootsProvider value={toolPathRoots}>
            <LiveSubagentsProvider value={liveSubagents}>
              <OpenAssetProvider value={openAsset}>
                <MessageLinkProvider value={messageLink}>
                  <SessionTranscript {...transcript} />
                </MessageLinkProvider>
              </OpenAssetProvider>
            </LiveSubagentsProvider>
          </ToolPathRootsProvider>
        </React.Profiler>
      </OpenAssetPathsProvider>
    </div>
  );
}
