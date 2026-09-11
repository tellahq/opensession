/**
 * The databases one session created or wrote to, on the session's info page
 * beside its reports. A session that filled a database should show it there
 * without the reader hunting through the Databases view; the row opens the
 * database in that view, which is where the rows themselves are.
 */
import React, { useEffect, useEffectEvent, useState } from "react";
import { fetchSessionDatabases } from "../lib/api";
import type { DatabaseMeta, WSServerMessage } from "../lib/types";
import { errorMessage } from "../lib/error-message";
import { shortTime } from "../lib/time";
import { IconChevronRight, IconDatabase } from "./icons";
import { Card } from "../ui/card";

export function useSessionDatabases(
  sessionId: string,
  addHandler: (handler: (message: WSServerMessage) => void) => () => void,
) {
  const [databases, setDatabases] = useState<DatabaseMeta[]>([]);
  const refresh = useEffectEvent(async () => {
    try {
      setDatabases(await fetchSessionDatabases(sessionId));
    } catch (error) {
      // An optional secondary panel, like reports: a failed refresh keeps
      // the current list rather than replacing it with an error.
      console.warn(errorMessage(error, "Failed to refresh session databases"));
    }
  });
  useEffect(() => {
    setDatabases([]);
    refresh();
  }, [sessionId]);
  useEffect(
    () =>
      addHandler((message) => {
        if (
          message.type === "databases_changed" &&
          message.sessionId === sessionId
        )
          refresh();
      }),
    [addHandler, sessionId],
  );
  return databases;
}

export function formatDatabaseSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function databaseDetail(meta: DatabaseMeta): string {
  return `${meta.tableCount} table${meta.tableCount === 1 ? "" : "s"} · ${formatDatabaseSize(meta.sizeBytes)}`;
}

export function SessionDatabasesPanel({
  databases,
  onOpen,
}: {
  databases: DatabaseMeta[];
  onOpen: (databaseId: string) => void;
}) {
  if (!databases.length) return null;
  // The same card the overview's other sections sit in (Review, Changes),
  // so a database reads as one more fact about the session, not a stray list.
  return (
    <Card className="px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-label text-dim">
        <IconDatabase size={16} dense />
        Databases
      </div>
      {databases.map((meta) => (
        <button
          key={meta.id}
          type="button"
          className="-mx-2 flex min-h-11 w-[calc(100%+16px)] cursor-pointer items-center gap-2 rounded-row border-0 bg-transparent px-2 py-1.5 text-left hover:bg-hover"
          onClick={() => onOpen(meta.id)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label font-medium text-fg">
              {meta.name}
            </span>
            <span className="block truncate text-meta text-faint">
              {databaseDetail(meta)} · updated {shortTime(meta.updatedAt)}
            </span>
          </span>
          <IconChevronRight size={16} className="shrink-0 text-faint" />
        </button>
      ))}
    </Card>
  );
}
