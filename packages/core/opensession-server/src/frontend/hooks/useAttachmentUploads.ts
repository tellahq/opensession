import { useRef, useState } from "react";
import type { StagingCount } from "../lib/attachments";

interface PendingUpload {
  id: number;
  kind: "image" | "file";
  file: File;
  controller: AbortController;
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
    setStaging({
      images: pending.current.filter((item) => item.kind === "image").length,
      files: pending.current.filter((item) => item.kind === "file").length,
    });
  }

  function remove(id: number) {
    const next = pending.current.filter((item) => item.id !== id);
    if (next.length === pending.current.length) return;
    pending.current = next;
    publish();
  }

  async function upload<T>(
    picked: FileList | File[],
    uploadOne: (file: File, signal: AbortSignal) => Promise<T>,
  ): Promise<T[]> {
    const entries = Array.from(picked).map((file) => ({
      id: nextId.current++,
      kind: file.type.startsWith("image/")
        ? ("image" as const)
        : ("file" as const),
      file,
      controller: new AbortController(),
    }));
    pending.current = [...pending.current, ...entries];
    publish();

    const results = await Promise.all(
      entries.map((entry) =>
        uploadOne(entry.file, entry.controller.signal).then(
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
