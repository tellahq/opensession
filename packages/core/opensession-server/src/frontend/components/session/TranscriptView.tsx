import { utilityClassName } from "../../ui/cn";
import React from "react";
import { OpenAssetPathsProvider } from "../../lib/open-asset";
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
  onRender: React.ProfilerOnRenderCallback;
};

/** The virtualized transcript and live stream tail with their shared contexts. */
export function TranscriptView({
  openSettlePending,
  assetPaths,
  toolPathRoots,
  liveSubagents,
  openAsset,
  onRender,
  ...transcript
}: TranscriptViewProps) {
  return (
    <div
      className={cn(
        utilityClassName(
          "w-full shrink-0 motion-safe:transition-opacity motion-safe:duration-150",
        ),
        openSettlePending && utilityClassName("opacity-0"),
      )}
    >
      <OpenAssetPathsProvider value={assetPaths}>
        <React.Profiler id="transcript" onRender={onRender}>
          <ToolPathRootsProvider value={toolPathRoots}>
            <LiveSubagentsProvider value={liveSubagents}>
              <OpenAssetProvider value={openAsset}>
                <SessionTranscript {...transcript} />
              </OpenAssetProvider>
            </LiveSubagentsProvider>
          </ToolPathRootsProvider>
        </React.Profiler>
      </OpenAssetPathsProvider>
    </div>
  );
}
