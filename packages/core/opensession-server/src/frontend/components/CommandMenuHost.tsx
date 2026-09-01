import React, { useEffect, useImperativeHandle, useState } from "react";
import { displayName } from "../brand-logos";
import { fetchToolAccounts, knownToolAccounts, type OpenPr } from "../lib/api";
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

export const CommandMenuHost = React.forwardRef<CommandMenuHandle, Props>(
  function CommandMenuHost(
    { sessions, actions, onSelectSession, onSelectPr, onOpenWithMcp },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [mcpServers, setMcpServers] = useState<string[]>(() =>
      (knownToolAccounts() || []).map((server) => server.name),
    );

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
        sessions={sessions}
        actions={[...actions, ...mcpActions]}
        onSelectSession={onSelectSession}
        onSelectPr={onSelectPr}
        onClose={() => setOpen(false)}
      />
    );
  },
);
