import { useRef, useState } from "react";
import type { StagingCount } from "../lib/attachments";
import type { UploadProgress } from "../lib/images";

interface PendingUpload {
  id: number;
  kind: "image" | "file";
  file: File;
  controller: AbortController;
  /** Whole percent reached, or null before the first progress report. */
  percent: number | null;
}

/**
 * Tracks attachment uploads individually so a pending tile can cancel its own
 * request and disappear immediately. Uploads deliberately survive an unmount:
 * draft-backed composers still commit completed files to the draft store.
 */
export function useAttachmentUploads() {
  const nextId = useRef(0);
  const pending = useRef<PendingUpload[]>([]);
  const [staging, setStaging] = useState<StagingCount>({ images: 0, files: 0 });

  function publish() {
    const files = pending.current.filter((item) => item.kind === "file");
    setStaging({
      images: pending.current.filter((item) => item.kind === "image").length,
      files: files.length,
      fileProgress: files.map((item) => ({
        name: item.file.name,
        fraction: item.percent === null ? null : item.percent / 100,
      })),
    });
  }

  // Re-render on whole-percent steps only: a 4 GB upload reports hundreds of
  // chunks, and the composer should not re-render for each one.
  function progressFor(entry: PendingUpload): UploadProgress {
    return (fraction) => {
      const percent = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
      if (percent === entry.percent) return;
      entry.percent = percent;
      if (pending.current.includes(entry)) publish();
    };
  }

  function remove(id: number) {
    const next = pending.current.filter((item) => item.id !== id);
    if (next.length === pending.current.length) return;
    pending.current = next;
    publish();
  }

  async function upload<T>(
    picked: FileList | File[],
    uploadOne: (
      file: File,
      signal: AbortSignal,
      onProgress: UploadProgress,
    ) => Promise<T>,
  ): Promise<T[]> {
    const entries = Array.from(picked).map((file) => ({
      id: nextId.current++,
      kind: file.type.startsWith("image/")
        ? ("image" as const)
        : ("file" as const),
      file,
      controller: new AbortController(),
      percent: null,
    }));
    pending.current = [...pending.current, ...entries];
    publish();

    const results = await Promise.all(
      entries.map((entry) =>
        uploadOne(entry.file, entry.controller.signal, progressFor(entry)).then(
          (value) => {
            remove(entry.id);
            return entry.controller.signal.aborted ? null : { value };
          },
          (error) => {
            remove(entry.id);
            throw error;
          },
        ),
      ),
    );
    return results.flatMap((result) => (result ? [result.value] : []));
  }

  function cancel(kind: PendingUpload["kind"], index: number) {
    const entry = pending.current.filter((item) => item.kind === kind)[index];
    if (!entry) return;
    entry.controller.abort();
    remove(entry.id);
  }

  return {
    staging,
    upload,
    cancelPendingImage: (index: number) => cancel("image", index),
    cancelPendingFile: (index: number) => cancel("file", index),
  };
}
