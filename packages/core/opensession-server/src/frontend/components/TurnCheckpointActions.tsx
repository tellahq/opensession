import React, { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ResponsiveDialog } from "../ui/sheet";
import { useIsPhone } from "../hooks/useIsPhone";
import { CodeHighlight } from "./LazyCode";
import * as TurnCheckpointRuntime from "../lib/turn-checkpoint-runtime";

export function TurnCheckpointActions({
  sessionId,
  turnId,
}: {
  sessionId: string;
  turnId: string;
}) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [state, setState] = useState<TurnCheckpointRuntime.TurnCheckpointState>(
    { loading: false, busy: false, error: null, preview: null, undo: false },
  );
  const runtime = useRef<ReturnType<
    typeof TurnCheckpointRuntime.makeTurnCheckpointRuntime
  > | null>(null);
  useEffect(() => {
    const active = TurnCheckpointRuntime.makeTurnCheckpointRuntime({
      changed: setState,
      completed: () => setOpen(false),
    });
    runtime.current = active;
    return () => {
      active.stop();
      runtime.current = null;
    };
  }, []);
  const show = (confirm: boolean) => {
    setConfirming(confirm);
    setDiscarding(false);
    setOpen(true);
    runtime.current?.load(sessionId, turnId);
  };
  const preview = state.preview;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="phone:min-h-11 text-faint"
        onClick={() => show(false)}
      >
        Changes in this turn
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="phone:min-h-11 text-faint"
        aria-label="Revert to before this turn"
        onClick={() => show(true)}
      >
        Revert…
      </Button>
      <ResponsiveDialog
        open={open}
        onClose={() => {
          if (!state.busy) setOpen(false);
        }}
        phone={phone}
        label={
          state.undo ? "Undo workspace revert" : "Revert to before this turn"
        }
        modalClassName="w-full max-w-3xl"
        sheetClassName="max-h-[90dvh]"
      >
        <div className="flex max-h-[85dvh] flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">
              {discarding
                ? "Discard interrupted revert"
                : state.undo
                  ? "Undo workspace revert"
                  : confirming
                    ? "Revert to before this turn"
                    : "Changes in this turn"}
            </h2>
            <Button
              className="phone:min-h-11"
              variant="ghost"
              disabled={state.busy}
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
          {state.loading && (
            <p role="status" className="text-sm text-dim">
              Loading workspace checkpoint…
            </p>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-dim">
              {state.error}
            </p>
          )}
          {preview?.reason && (
            <p role="status" className="text-sm text-dim">
              {preview.reason}
            </p>
          )}
          {discarding ? (
            <p className="text-sm text-dim">
              Keep the current files and conversation, and unblock this session.
              No files will be restored. Check the workspace before continuing.
            </p>
          ) : confirming && preview?.canRestore ? (
            <>
              <p className="text-sm text-dim">
                {state.undo
                  ? "Restore the files and conversation from before the last revert."
                  : "Restore the files and rewind the conversation to before this turn. This turn and later turns will be marked reverted. Commits and staged files will not change."}
              </p>
              <p className="text-sm text-dim">
                {preview.files.length
                  ? `${preview.files.length} files will change:`
                  : "No files will change. The conversation will still rewind."}
              </p>
              {!!preview.files.length && (
                <ul className="max-h-40 overflow-auto text-sm text-fg">
                  {preview.files.map((file) => (
                    <li key={file} className="break-all font-mono">
                      {file}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
          {!discarding && preview && (
            <div className="min-h-0 overflow-auto rounded-lg bg-panel">
              {(confirming ? preview.restorePatch : preview.patch) ? (
                <CodeHighlight
                  code={confirming ? preview.restorePatch : preview.patch}
                  lang="diff"
                />
              ) : (
                <p className="p-4 text-sm text-dim">
                  No recorded file changes.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {preview?.canUndo && !state.undo && !discarding && (
              <Button
                className="phone:min-h-11"
                disabled={state.busy || state.loading}
                onClick={() => {
                  setConfirming(true);
                  runtime.current?.load(sessionId, turnId, true);
                }}
              >
                Undo revert…
              </Button>
            )}
            {preview?.interrupted && !discarding && (
              <Button
                className="phone:min-h-11"
                disabled={state.busy}
                onClick={() => setDiscarding(true)}
              >
                Discard interrupted revert…
              </Button>
            )}
            {discarding ? (
              <Button
                className="phone:min-h-11"
                variant="danger"
                disabled={state.busy}
                onClick={() =>
                  runtime.current?.act(sessionId, turnId, "discard")
                }
              >
                {state.busy ? "Discarding…" : "Keep files and unblock session"}
              </Button>
            ) : (
              preview?.canRestore && (
                <Button
                  className="phone:min-h-11"
                  variant={confirming ? "danger" : "default"}
                  disabled={state.busy || state.loading}
                  onClick={() => {
                    if (!confirming) {
                      setConfirming(true);
                      return;
                    }
                    runtime.current?.act(
                      sessionId,
                      turnId,
                      state.undo ? "undo" : "revert",
                      preview.currentTree,
                    );
                  }}
                >
                  {state.busy
                    ? "Restoring…"
                    : confirming
                      ? state.undo
                        ? "Undo revert"
                        : "Revert files and conversation"
                      : "Revert to before this turn…"}
                </Button>
              )
            )}
            {!!state.error && (
              <Button
                className="phone:min-h-11"
                disabled={state.busy}
                onClick={() =>
                  runtime.current?.load(sessionId, turnId, state.undo)
                }
              >
                Refresh preview
              </Button>
            )}
          </div>
        </div>
      </ResponsiveDialog>
    </>
  );
}
