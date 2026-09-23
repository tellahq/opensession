import { useEffect, useRef, useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { BASE_PATH } from "../lib/base";
import { AGENT_NAME } from "../lib/brand";
import { MAX_FILE_UPLOAD_BYTES, uploadFile } from "../lib/images";
import type { WSServerMessage } from "../lib/types";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";

type FileRequest = NonNullable<
  Extract<WSServerMessage, { type: "local_files_request" }>["fileRequest"]
>;

type Picked = { name: string; size: number; fraction: number };

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

/** Upload the picked files, then answer the request with their staged paths.
 *  Outside the component so its throws stay out of React Compiler's way. */
async function uploadAndAnswer(
  picked: File[],
  options: {
    sessionId: string;
    requestId: string;
    signal: AbortSignal;
    onProgress: (index: number) => (fraction: number) => void;
    onSending: () => void;
  },
): Promise<void> {
  // One file at a time: each large file already sends several chunks in
  // parallel, which is what fills the connection.
  const uploaded: { name: string; path: string }[] = [];
  for (const [index, file] of picked.entries()) {
    uploaded.push(
      await uploadFile(file, options.signal, options.onProgress(index)),
    );
    options.onProgress(index)(1);
  }
  options.onSending();
  const res = await fetch(`${BASE_PATH}/api/local-files/${options.requestId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: options.sessionId, files: uploaded }),
    signal: options.signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || "Couldn't send the files");
  }
}

/**
 * The agent asked for files from this person's computer
 * (opensession-local-files). The card stays up until someone answers, the
 * request expires, or the agent's call ends; any viewer of the session can
 * answer. Files go up through the same chunked, resumable upload the composer
 * uses, so a multi-gigabyte video is fine.
 */
export function LocalFilesRequestCard({ sessionId }: { sessionId: string }) {
  const { addHandler } = useSessionSocket();
  const [request, setRequest] = useState<FileRequest | null>(null);

  useEffect(() => {
    let live = true;
    // The broadcast only reaches viewers who were here when it went out; a
    // viewer arriving later asks.
    fetch(
      `${BASE_PATH}/api/local-files?sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body) setRequest(body.request ?? null);
      })
      .catch(() => {});
    const off = addHandler((message) => {
      if (message.type === "local_files_request") {
        if (message.sessionId === sessionId) setRequest(message.fileRequest);
      } else if (
        message.type === "local_files_request_resolved" &&
        message.sessionId === sessionId
      ) {
        setRequest((current) =>
          current?.id === message.requestId ? null : current,
        );
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, addHandler]);

  if (!request) return null;
  return (
    <RequestCard key={request.id} sessionId={sessionId} request={request} />
  );
}

function RequestCard({
  sessionId,
  request,
}: {
  sessionId: string;
  request: FileRequest;
}) {
  const [phase, setPhase] = useState<"idle" | "uploading" | "sending">("idle");
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // The request closing (answered elsewhere, expired) unmounts the card, and
  // an upload for it has nowhere to go.
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function send(picked: File[]) {
    if (!picked.length) return;
    const tooBig = picked.find((file) => file.size > MAX_FILE_UPLOAD_BYTES);
    if (tooBig) {
      setError(
        `${tooBig.name} is too large (max ${formatBytes(MAX_FILE_UPLOAD_BYTES)}).`,
      );
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setPhase("uploading");
    setFiles(
      picked.map((file) => ({ name: file.name, size: file.size, fraction: 0 })),
    );
    const progress = (index: number) => (fraction: number) =>
      setFiles((current) =>
        current.map((file, i) =>
          i === index ? { ...file, fraction: Math.min(1, fraction) } : file,
        ),
      );
    try {
      await uploadAndAnswer(picked, {
        sessionId,
        requestId: request.id,
        signal: controller.signal,
        onProgress: progress,
        onSending: () => setPhase("sending"),
      });
      // The resolved broadcast closes the card for every viewer.
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPhase("idle");
      setFiles([]);
      setError(
        caught instanceof Error ? caught.message : "Couldn't send the files",
      );
    }
  }

  function cancel() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase("idle");
    setFiles([]);
  }

  async function decline() {
    const res = await fetch(
      `${BASE_PATH}/api/local-files/${request.id}/decline`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      },
    ).catch(() => null);
    if (!res?.ok) setError("Couldn't decline. Try again.");
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const done = files.reduce((sum, file) => sum + file.size * file.fraction, 0);
  const percent = total ? Math.floor((done / total) * 100) : 0;

  return (
    <section className={ASK_CARD_SHELL} aria-label="File request">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {AGENT_NAME} is asking for {request.multiple ? "files" : "a file"}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]">
          {request.purpose}
        </p>
        {request.hint && (
          <p className="m-0 text-supporting text-dim [overflow-wrap:anywhere]">
            {request.hint}
          </p>
        )}
      </div>

      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {files.map((file, index) => (
              <li
                key={index}
                className="flex min-w-0 items-baseline gap-2 text-meta text-dim"
              >
                <span className="min-w-0 flex-1 truncate text-fg">
                  {file.name}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatBytes(file.size)}
                </span>
              </li>
            ))}
          </ul>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-fg/8"
          >
            <div
              className="h-full rounded-full bg-fg transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-meta text-faint tabular-nums">
            {phase === "sending"
              ? "Sending to the session…"
              : `${formatBytes(done)} of ${formatBytes(total)} · ${percent}%`}
          </span>
        </div>
      )}

      {error && (
        <p className="m-0 text-meta text-red" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {phase === "idle" ? (
          <>
            <Button variant="soft" size="lg" onClick={() => void decline()}>
              Decline
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={() => inputRef.current?.click()}
            >
              {request.multiple ? "Choose files…" : "Choose a file…"}
            </Button>
          </>
        ) : (
          <Button
            variant="soft"
            size="lg"
            onClick={cancel}
            disabled={phase === "sending"}
          >
            Cancel upload
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple={request.multiple}
        hidden
        onChange={(event) => {
          const picked = Array.from(event.target.files || []);
          event.target.value = "";
          void send(picked);
        }}
      />
    </section>
  );
}
