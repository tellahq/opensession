import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { displayName } from "../brand-logos";
import {
  fetchSessionsSnapshot,
  fetchToolAccounts,
  knownToolAccounts,
  type OpenPr,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { IconTile } from "./BrandTile";
import { SessionSearch, type CommandPaletteAction } from "./SessionSearch";

export interface CommandMenuHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

interface Props {
  sessions: UnifiedSession[];
  actions: CommandPaletteAction[];
  onSelectSession: (id: string) => void;
  onSelectPr: (pr: OpenPr) => void;
  onOpenWithMcp: (server: string) => void;
}

/**
 * The app's own rows first, since the live poll keeps them freshest, then
 * every other live session the unscoped list knows about.
 */
export function mergeSessionPools(
  own: UnifiedSession[],
  everyone: UnifiedSession[],
): UnifiedSession[] {
  if (everyone.length === 0) return own;
  const seen = new Set(own.map((session) => session.id));
  return [...own, ...everyone.filter((session) => !seen.has(session.id))];
}

export const CommandMenuHost = React.forwardRef<CommandMenuHandle, Props>(
  function CommandMenuHost(
    { sessions, actions, onSelectSession, onSelectPr, onOpenWithMcp },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [mcpServers, setMcpServers] = useState<string[]>(() =>
      (knownToolAccounts() || []).map((server) => server.name),
    );

    // The app's list is the sidebar's scope (by default, only your own
    // sessions), but the palette searches every live workspace and session.
    // The unscoped live list is a server-cached snapshot; revalidate it by
    // ETag each time the palette opens.
    const [everyone, setEveryone] = useState<UnifiedSession[]>([]);
    const everyoneEtag = useRef<string | null>(null);

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((current) => !current),
      isOpen: () => open,
    }));

    useEffect(() => {
      if (!open) return;
      let live = true;
      fetchToolAccounts()
        .then(({ servers }) => {
          if (live) setMcpServers(servers.map((server) => server.name));
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const ctrl = new AbortController();
      fetchSessionsSnapshot({
        etag: everyoneEtag.current,
        signal: ctrl.signal,
        query: "?archived=exclude",
      })
        .then((snapshot) => {
          if (snapshot.notModified || snapshot.text === null) return;
          everyoneEtag.current = snapshot.etag;
          setEveryone(JSON.parse(snapshot.text));
        })
        .catch(() => {});
      return () => ctrl.abort();
    }, [open]);

    if (!open) return null;
    const mcpActions: CommandPaletteAction[] = mcpServers
      .slice()
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .map((server) => {
        const name = displayName(server);
        return {
          id: `new-session-with-${server}`,
          label: `New session with ${name}`,
          description: `Start a session with only ${name} connected`,
          category: "Tools",
          keywords: [server, name, "tool", "service", "connected"],
          icon: <IconTile name={server} size={18} />,
          run: () => onOpenWithMcp(server),
        };
      });

    return (
      <SessionSearch
        sessions={mergeSessionPools(sessions, everyone)}
        actions={[...actions, ...mcpActions]}
        onSelectSession={onSelectSession}
        onSelectPr={onSelectPr}
        onClose={() => setOpen(false)}
      />
    );
  },
);
