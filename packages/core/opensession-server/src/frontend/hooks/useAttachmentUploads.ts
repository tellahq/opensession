import { useId, useSyncExternalStore } from "react";
import type { PendingFileProgress, StagingCount } from "../lib/attachments";
import type { UploadProgress } from "../lib/images";

interface PendingUpload {
  id: number;
  kind: "image" | "file";
  file: File;
  controller: AbortController;
  /** Whole percent the server has acknowledged. */
  percent: number;
}

interface Store {
  entries: PendingUpload[];
  snapshot: StagingCount;
  listeners: Set<() => void>;
}

const EMPTY: StagingCount = { images: 0, files: 0, fileProgress: [] };

/**
 * Pending uploads live here rather than in component state, keyed by the
 * draft they will land in. A session view is remounted when you switch away
 * and back, and the upload itself carries on regardless (it commits to the
 * draft store when it finishes), so the placeholder has to outlive the view
 * too: coming back mid-upload shows the same card at the same percentage.
 */
const stores = new Map<string, Store>();
let nextId = 0;

function storeFor(key: string): Store {
  let store = stores.get(key);
  if (!store) {
    store = { entries: [], snapshot: EMPTY, listeners: new Set() };
    stores.set(key, store);
  }
  return store;
}

function publish(key: string) {
  const store = storeFor(key);
  const files = store.entries.filter((item) => item.kind === "file");
  store.snapshot = {
    images: store.entries.length - files.length,
    files: files.length,
    fileProgress: files.map((item): PendingFileProgress => ({
      name: item.file.name,
      size: item.file.size,
      fraction: item.percent / 100,
    })),
  };
  for (const listener of store.listeners) listener();
  if (!store.entries.length && !store.listeners.size) stores.delete(key);
}

function remove(key: string, id: number) {
  const store = storeFor(key);
  const next = store.entries.filter((item) => item.id !== id);
  if (next.length === store.entries.length) return;
  store.entries = next;
  publish(key);
}

// Re-render on whole-percent steps only: a 4 GB upload reports hundreds of
// chunks, and the composer should not re-render for each one.
function progressFor(key: string, entry: PendingUpload): UploadProgress {
  return (fraction) => {
    const percent = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
    if (percent === entry.percent) return;
    entry.percent = percent;
    if (storeFor(key).entries.includes(entry)) publish(key);
  };
}

async function uploadInto<T>(
  key: string,
  picked: FileList | File[],
  uploadOne: (
    file: File,
    signal: AbortSignal,
    onProgress: UploadProgress,
  ) => Promise<T>,
): Promise<T[]> {
  const entries: PendingUpload[] = Array.from(picked).map((file) => ({
    id: nextId++,
    kind: file.type.startsWith("image/") ? "image" : "file",
    file,
    controller: new AbortController(),
    percent: 0,
  }));
  const store = storeFor(key);
  store.entries = [...store.entries, ...entries];
  publish(key);

  const results = await Promise.all(
    entries.map((entry) =>
      uploadOne(
        entry.file,
        entry.controller.signal,
        progressFor(key, entry),
      ).then(
        (value) => {
          remove(key, entry.id);
          return entry.controller.signal.aborted ? null : { value };
        },
        (error) => {
          remove(key, entry.id);
          throw error;
        },
      ),
    ),
  );
  return results.flatMap((result) => (result ? [result.value] : []));
}

function cancel(key: string, kind: PendingUpload["kind"], index: number) {
  const entry = storeFor(key).entries.filter((item) => item.kind === kind)[
    index
  ];
  if (!entry) return;
  entry.controller.abort();
  remove(key, entry.id);
}

/**
 * Tracks attachment uploads individually so a pending tile can cancel its own
 * request and disappear immediately. Uploads deliberately survive an unmount:
 * draft-backed composers still commit completed files to the draft store.
 * Pass the draft key so a remounted view finds its uploads still pending;
 * without one the uploads belong to this component instance.
 */
export function useAttachmentUploads(draftKey?: string) {
  const instance = useId();
  const key = draftKey ? `draft:${draftKey}` : `instance:${instance}`;
  const staging = useSyncExternalStore(
    (listener) => {
      const store = storeFor(key);
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
        if (!store.entries.length && !store.listeners.size) stores.delete(key);
      };
    },
    () => stores.get(key)?.snapshot ?? EMPTY,
    () => EMPTY,
  );

  return {
    staging,
    upload: <T>(
      picked: FileList | File[],
      uploadOne: (
        file: File,
        signal: AbortSignal,
        onProgress: UploadProgress,
      ) => Promise<T>,
    ) => uploadInto(key, picked, uploadOne),
    cancelPendingImage: (index: number) => cancel(key, "image", index),
    cancelPendingFile: (index: number) => cancel(key, "file", index),
  };
}
