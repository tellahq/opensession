import * as stylex from "@stylexjs/stylex";
import { popup } from "../ui/popup-styles";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { BASE_PATH } from "../lib/base";
import { errorMessage } from "../lib/error-message";
import { composerQueue } from "../lib/composer-classes";
import {
  connectLocalFolder,
  disconnectLocalFolder,
  localFolderProvider,
  localFolderDeviceId,
  localFolderState,
  reauthorizeLocalFolder,
  setLocalFolderReadOnly,
  subscribeLocalFolders,
} from "../lib/local-folders/bridge";
import type { WSServerMessage } from "../lib/types";
import { useSessionSocket } from "../hooks/useSessionSocket";
import type { FolderGrant } from "../lib/local-folders/provider";

import { Button } from "../ui/button";
import { Menu, MENU_ICON, MenuLabel } from "../ui/menu";
import { ComposerPressButton } from "./composer/ComposerControls";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import { getCurrentUser } from "./UserPicker";
import { IconFolder, IconFolderPlus, IconX } from "./icons";

export type SessionLocalFolder = Extract<
  WSServerMessage,
  { type: "local_folders" }
>["folders"][number];

/** Folders connected to a session, live. */
export function useSessionLocalFolders(
  sessionId: string,
): SessionLocalFolder[] {
  const { addHandler } = useSessionSocket();
  const [folders, setFolders] = useState<SessionLocalFolder[]>([]);
  useEffect(() => {
    let live = true;
    setFolders([]);
    fetch(
      `${BASE_PATH}/api/local-folders?sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && Array.isArray(body?.folders)) setFolders(body.folders);
      })
      .catch(() => {});
    const off = addHandler((message) => {
      if (message.type === "local_folders" && message.sessionId === sessionId)
        setFolders(message.folders);
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, addHandler]);
  return folders;
}

export function useLocalFolderBridge() {
  return useSyncExternalStore(
    subscribeLocalFolders,
    localFolderState,
    localFolderState,
  );
}

function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    void localFolderDeviceId().then(setId, () => setId(null));
  }, []);
  return id;
}

async function disconnectRemote(sessionId: string, key: string) {
  const res = await fetch(`${BASE_PATH}/api/local-folders/disconnect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, key, user: getCurrentUser() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || "Couldn't disconnect the folder");
  }
}

function report<Rejected>(error: Rejected) {
  toast(errorMessage(error, "Something went wrong with the folder"), {
    variant: "error",
  });
}

const chip =
  "focus-ring inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-control px-2 text-label font-medium text-fg hover:bg-hover phone:min-h-11";

/**
 * The folders on people's own computers that this session can reach, as a
 * flap above the composer. Each chip opens a small menu: allow or stop edits
 * (on the device holding the folder) and disconnect (for the person who
 * connected it, from any device). A browser that lost its permission after a
 * restart shows a chip that asks again on click.
 */
/** The flap for a session, or null when nothing is connected, so the phone
 *  composer can still rest as a pill. */
export function useLocalFoldersFlap(sessionId: string): ReactNode {
  const folders = useSessionLocalFolders(sessionId);
  const bridge = useLocalFolderBridge();
  const waiting = bridge.grants.filter(
    (grant) => !grant.usable && grant.sessionIds.includes(sessionId),
  );
  if (!folders.length && !waiting.length) return null;
  return (
    <LocalFoldersFlap
      sessionId={sessionId}
      folders={folders}
      grants={bridge.grants}
      waiting={waiting}
    />
  );
}

interface FlapProps {
  sessionId: string;
  folders: SessionLocalFolder[];
  grants: FolderGrant[];
  waiting: FolderGrant[];
}

function LocalFoldersFlap({ sessionId, folders, grants, waiting }: FlapProps) {
  const deviceId = useDeviceId();
  return (
    <div className={composerQueue}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 -mx-1.5">
        {waiting.map((grant) => (
          <Button
            key={grant.id}
            variant="ghost"
            size="sm"
            icon={<IconFolder size={20} aria-hidden />}
            onClick={() =>
              void reauthorizeLocalFolder(grant.id).then((ok) => {
                if (!ok)
                  toast("The browser did not allow access", {
                    variant: "error",
                  });
              }, report)
            }
          >
            {grant.name} · Allow access again
          </Button>
        ))}
        {folders.map((folder) => {
          const here = !!deviceId && folder.deviceId === deviceId;
          const grant = here
            ? grants.find((g) => g.id === folder.id)
            : undefined;
          return (
            <Menu.Root key={folder.key}>
              <Menu.Trigger
                className={chip}
                aria-label={`${folder.name} on ${folder.deviceLabel}`}
              >
                <IconFolder
                  size={20}
                  className={cn(
                    "shrink-0",
                    folder.online ? "text-dim" : "text-faint",
                  )}
                  aria-hidden
                />
                <span className={cn("truncate", !folder.online && "text-dim")}>
                  {folder.name}
                </span>
                <span className="shrink-0 text-faint">
                  {folder.online
                    ? folder.readOnly
                      ? "Read only"
                      : here
                        ? null
                        : folder.deviceLabel
                    : `${folder.deviceLabel} is offline`}
                </span>
              </Menu.Trigger>
              <Menu.Popup side="top" align="start">
                <Menu.Group>
                  <Menu.GroupLabel>
                    {folder.displayPath || folder.name} on {folder.deviceLabel}
                  </Menu.GroupLabel>
                  {grant && (
                    <Menu.CheckboxItem
                      checked={!grant.readOnly}
                      onCheckedChange={(allow) =>
                        void setLocalFolderReadOnly(grant.id, !allow).catch(
                          report,
                        )
                      }
                    >
                      <MenuLabel>Allow edits</MenuLabel>
                      <Menu.Check on={!grant.readOnly} />
                    </Menu.CheckboxItem>
                  )}
                  <Menu.Item
                    onClick={() =>
                      void (
                        grant
                          ? disconnectLocalFolder(grant.id, sessionId)
                          : disconnectRemote(sessionId, folder.key)
                      ).catch(report)
                    }
                  >
                    <IconX size={20} className={MENU_ICON} aria-hidden />
                    Disconnect
                  </Menu.Item>
                </Menu.Group>
              </Menu.Popup>
            </Menu.Root>
          );
        })}
      </div>
    </div>
  );
}

/** The composer "+" row that picks a folder and connects it to the session.
 *  Absent where this client cannot hold a folder. */
export function ConnectFolderMenuItem({
  sessionId,
  close,
}: {
  sessionId: string;
  close: () => void;
}) {
  if (!localFolderProvider()) return null;
  return (
    <ComposerPressButton
      type="button"
      {...stylex.props(popup.item, popup.plainItem)}
      title="Let this session read and edit a folder on this computer while the app is open"
      onPress={() => {
        close();
        connectLocalFolder(sessionId).then((grant) => {
          if (grant) toast(`Connected ${grant.name}`);
        }, report);
      }}
    >
      <span {...stylex.props(popup.itemGlyph)}>
        <IconFolderPlus size={20} />
      </span>
      <MenuLabel>Connect a folder…</MenuLabel>
    </ComposerPressButton>
  );
}
