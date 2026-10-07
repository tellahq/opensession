import { useState } from "react";
import { errorMessage } from "../lib/error-message";
import {
  attachLocalFolders,
  forgetUnusedLocalFolder,
  localFolderProvider,
  pickLocalFolder,
} from "../lib/local-folders/bridge";
import type { FolderGrant } from "../lib/local-folders/provider";
import { AnimatePresence } from "motion/react";
import { Menu } from "../ui/menu";
import { toast } from "../ui/toast";
import { ComposerContextChip } from "./ComposerContextChip";
import { IconFolder, IconFolderPlus } from "./icons";

/**
 * Folders picked in the New-session box. The session does not exist yet, so
 * they wait here and are connected to its id just before the create is sent
 * (`attachTo`), which lets the opening turn already know about them.
 */
export function useNewSessionFolders() {
  const [folders, setFolders] = useState<FolderGrant[]>([]);
  const available = !!localFolderProvider();

  function add() {
    pickLocalFolder().then(
      (grant) => {
        if (!grant) return;
        setFolders((current) =>
          current.some((f) => f.id === grant.id)
            ? current
            : [...current, grant],
        );
      },
      (error) =>
        toast(errorMessage(error, "Couldn't connect the folder"), {
          variant: "error",
        }),
    );
  }

  function remove(id: string) {
    setFolders((current) => current.filter((f) => f.id !== id));
    void forgetUnusedLocalFolder(id).catch(() => {});
  }

  /** Connect the picked folders to the new session. Never throws: a failure
   *  is reported and the session is still created. */
  async function attachTo(sessionId: string) {
    if (!folders.length) return;
    const ids = folders.map((f) => f.id);
    setFolders([]);
    await attachLocalFolders(ids, sessionId).catch((error) =>
      toast(errorMessage(error, "Couldn't connect the folder"), {
        variant: "error",
      }),
    );
  }

  return { folders, available, add, remove, attachTo };
}

export type NewSessionFolders = ReturnType<typeof useNewSessionFolders>;

/** The "More options" row that opens the folder picker. */
export function NewSessionFolderMenuItem({
  folders,
}: {
  folders: NewSessionFolders;
}) {
  if (!folders.available) return null;
  return (
    <Menu.Item onClick={folders.add}>
      <IconFolderPlus className="shrink-0 text-dim" size={20} />
      <span className="min-w-0 truncate">Connect a folder…</span>
    </Menu.Item>
  );
}

/** Picked folders as chips above the prompt, each removable. */
export function NewSessionFolderChips({
  folders,
  disabled,
}: {
  folders: NewSessionFolders;
  disabled?: boolean;
}) {
  return (
    <AnimatePresence initial={false}>
      {folders.folders.map((folder) => (
        <ComposerContextChip
          key={folder.id}
          icon={<IconFolder size={15} />}
          label={folder.name}
          meta={folder.readOnly ? "Read only" : undefined}
          title={`${folder.displayPath || folder.name} will be connected to this session. It can read and edit it while this app is open.`}
          onRemove={() => folders.remove(folder.id)}
          removeLabel={`Don't connect ${folder.name}`}
          disabled={disabled}
        />
      ))}
    </AnimatePresence>
  );
}
