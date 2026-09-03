import React, { useCallback, useEffect, useRef, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { githubLoginFromInput } from "../lib/github-login";
import { errorMessage } from "../lib/error-message";
import { refreshPeople } from "../lib/people";
import { copyToClipboard } from "../lib/share-link";
import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { Field, FieldGrid, Input } from "../ui/input";
import { MENU_ICON, Menu } from "../ui/menu";
import { Modal } from "../ui/modal";
import { EmptyState, InlineAlert } from "../ui/state";
import {
  rowMenuTriggerClasses,
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHint,
} from "../ui/settings";
import { toast } from "../ui/toast";
import {
  IconCheck,
  IconDotsHorizontal,
  IconLink,
  IconPencil,
  IconPlus,
  IconTrash,
} from "./icons";
import { setupRequest, type TeamMember } from "./setup-shared";
import { UserAvatar } from "./UserAvatar";
import { useAuthStatus } from "./UserPicker";

// Settings → Setup → Team: the manageable roster. The identity table drives
// commit attribution, `allowedUsers` MCP scoping, and GitHub sign-in, so each
// member row stays concise while every identifier remains available in the
// edit dialog. Add/edit go through a small dialog; remove is confirmed.

type TeamMemberUpdate = Partial<{
  name: string;
  email: string | null;
  github: string | null;
  slackId: string | null;
  aliases: string[] | null;
}>;

export function TeamSection({
  onChanged,
  title,
  addLabel = "Add member",
  onboarding = false,
  syncGithubOrganization = false,
  compact = false,
  showCount = false,
}: {
  onChanged: () => void | Promise<void>;
  /** Optional label above the roster. Defaults to the roster name and count. */
  title?: React.ReactNode;
  /** Action copy for the add flow. */
  addLabel?: string;
  /** Use the roomier, quiet action treatment in first-run onboarding. */
  onboarding?: boolean;
  /** Import an organization roster before showing the editable identity table. */
  syncGithubOrganization?: boolean;
  compact?: boolean;
  /** Append the loaded roster size to an explicit title. */
  showCount?: boolean;
}) {
  const auth = useAuthStatus();
  const githubAuth = auth?.required === true;
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [githubOrganization, setGithubOrganization] = useState<string | null>(
    null,
  );
  const [githubSyncError, setGithubSyncError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await setupRequest<{ members: TeamMember[] }>(
        "/api/setup/team",
      );
      setMembers(body.members);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  const syncGithubMembers = useCallback(async () => {
    setGithubSyncError(null);
    try {
      const body = await setupRequest<{
        organization: string | null;
        synced: boolean;
        added: number;
        members: TeamMember[];
        error?: string;
      }>("/api/setup/team/sync-github", { method: "POST" });
      setMembers(body.members);
      setLoadFailed(false);
      setGithubOrganization(body.synced ? body.organization : null);
      setGithubSyncError(body.error ?? null);
    } catch {
      await load();
      setGithubSyncError("GitHub members weren’t added. Add them manually.");
    }
  }, [load]);

  useEffect(() => {
    if (syncGithubOrganization) void syncGithubMembers();
    else void load();
  }, [syncGithubOrganization, load, syncGithubMembers]);

  async function handleMutated() {
    await load();
    await refreshPeople();
    await onChanged();
  }

  function copyInviteLink() {
    copyToClipboard(`${window.location.origin}${BASE_PATH}/`, () => {
      setInviteCopied(true);
      toast("Invite link copied", { variant: "success" });
      window.setTimeout(() => setInviteCopied(false), 2000);
    });
  }

  return (
    <>
      <SettingsGroupLabel
        className={title ? undefined : "mt-0"}
        actions={
          githubAuth ? (
            <Button
              size="sm"
              variant="default"
              className="phone:min-h-11"
              icon={
                inviteCopied ? <IconCheck size={16} /> : <IconLink size={16} />
              }
              onClick={copyInviteLink}
            >
              {inviteCopied ? "Invite link copied" : "Copy invite link"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              className={onboarding ? "phone:min-h-11" : undefined}
              icon={<IconPlus size={16} />}
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              {addLabel}
            </Button>
          )
        }
      >
        {showCount && members
          ? `${members.length} ${members.length === 1 ? "member" : "members"}`
          : (title ?? "Team members")}
        {members && !showCount && !title ? ` · ${members.length}` : ""}
      </SettingsGroupLabel>
      {githubSyncError && (
        <InlineAlert
          variant="warn"
          onDismiss={() => setGithubSyncError(null)}
          onRetry={() => void syncGithubMembers()}
        >
          {githubSyncError}
        </InlineAlert>
      )}
      {!members && !loadFailed ? (
        // The card itself is the ghost, so the roster lands in the block it
        // was already occupying. Rendering the real card around a loading
        // label instead gave the group a one-line height that trebled the
        // moment the members arrived.
        <SettingCardSkeleton rows={3} icon={28} label="Loading team" />
      ) : (
        <SettingCard>
          {!members ? (
            <EmptyState placement="row">
              Couldn&rsquo;t load the team roster.
            </EmptyState>
          ) : members.length === 0 ? (
            <EmptyState placement="row">
              {githubAuth
                ? "No teammates yet. Share the invite link so they can sign in with GitHub."
                : "No teammates yet. Add everyone who uses this instance so commits and sessions attribute to real people."}
            </EmptyState>
          ) : (
            members.map((m) => (
              <MemberRow
                key={m.name}
                member={m}
                compact={compact}
                onEdit={() => {
                  setEditing(m);
                  setDialogOpen(true);
                }}
                onRemoved={handleMutated}
              />
            ))
          )}
        </SettingCard>
      )}
      <SettingsHint>
        {githubAuth
          ? "Share the invite link. Teammates are added when they sign in with GitHub."
          : githubOrganization
            ? `Members were imported from the ${githubOrganization} GitHub organization. Only a name is required when you add someone manually.`
            : "Only a name is required. Add a GitHub login or other identities when sign-in and attribution should resolve to this member."}
      </SettingsHint>
      <MemberDialog
        open={dialogOpen}
        member={editing}
        addLabel={addLabel}
        onOpenChange={setDialogOpen}
        onSaved={async () => {
          setDialogOpen(false);
          await handleMutated();
        }}
      />
    </>
  );
}

function MemberRow({
  member,
  compact,
  onEdit,
  onRemoved,
}: {
  member: TeamMember;
  compact: boolean;
  onEdit: () => void;
  onRemoved: () => void | Promise<void>;
}) {
  const details = [member.email, member.github && `@${member.github}`].filter(
    Boolean,
  );
  return (
    <SettingRow>
      <UserAvatar
        name={member.name}
        login={member.github}
        size={28}
        glow={compact}
      />
      <SettingRowText>
        <SettingRowTitle>{member.name}</SettingRowTitle>
        {!compact && details.length > 0 && (
          <SettingRowDescription className="truncate">
            {details.join(" · ")}
          </SettingRowDescription>
        )}
      </SettingRowText>
      <SettingRowControl>
        <MemberActions member={member} onEdit={onEdit} onRemoved={onRemoved} />
      </SettingRowControl>
    </SettingRow>
  );
}

function MemberActions({
  member,
  onEdit,
  onRemoved,
}: {
  member: TeamMember;
  onEdit: () => void;
  onRemoved: () => void | Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function remove() {
    setBusy(true);
    try {
      await setupRequest(
        `/api/setup/team/${encodeURIComponent(member.name)}/remove`,
        {
          method: "POST",
        },
      );
      toast(`${member.name} removed`);
      await onRemoved();
    } catch (error) {
      toast(errorMessage(error, "Could not remove member"), {
        variant: "error",
      });
      setBusy(false);
    }
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className={rowMenuTriggerClasses}
          aria-label={`Manage ${member.name}`}
        >
          <IconDotsHorizontal size={18} />
        </Menu.Trigger>
        <Menu.Popup align="end" sideOffset={4}>
          <Menu.Item onClick={onEdit}>
            <IconPencil size={16} className={MENU_ICON} />
            Edit member
          </Menu.Item>
          <Menu.Item
            className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
            onClick={() => setConfirmOpen(true)}
          >
            <IconTrash size={16} />
            Remove member
          </Menu.Item>
        </Menu.Popup>
      </Menu.Root>
      <Modal.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) setConfirmOpen(open);
        }}
        disablePointerDismissal={busy}
      >
        <Modal.Content initialFocus={cancelRef}>
          <Modal.Header
            title={`Remove ${member.name}?`}
            description="This removes their identity mapping from Open Session."
          />
          <Modal.Footer>
            <Button
              ref={cancelRef}
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="danger-strong" onClick={remove} disabled={busy}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

export function GithubMemberDialog({
  open,
  onOpenChange,
  onSaved,
  inviteUrl,
  title = "Add member",
  actionLabel = "Add member",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (github: string) => void | Promise<void>;
  inviteUrl?: string;
  title?: string;
  actionLabel?: string;
}) {
  const [github, setGithub] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubRef = useRef<HTMLInputElement>(null);
  const inviteCopy = useCopy();

  useEffect(() => {
    if (!open) return;
    setGithub("");
    setError(null);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const login = githubLoginFromInput(github);
    if (saving) return;
    if (!login) {
      setError("Enter a GitHub username or profile link.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setupRequest("/api/setup/team", {
        method: "POST",
        json: { name: login, github: login },
      });
      toast(`@${login} added`);
      await onSaved(login);
    } catch (error) {
      setError(errorMessage(error, "Could not add member"));
    }
    setSaving(false);
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      disablePointerDismissal={saving}
    >
      <Modal.Content initialFocus={githubRef}>
        <Modal.Header
          title={title}
          description={
            inviteUrl
              ? "Add their GitHub account or share the invite link."
              : "They can sign in with this GitHub account."
          }
        />
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="GitHub username or profile link">
            <Input
              ref={githubRef}
              value={github}
              onChange={(event) => setGithub(event.target.value)}
              placeholder="monalisa or github.com/monalisa"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          {error && <InlineAlert>{error}</InlineAlert>}
          <Button
            variant="primary"
            type="submit"
            className="w-full phone:min-h-11"
            disabled={!github.trim() || saving}
          >
            {saving ? "Adding…" : actionLabel}
          </Button>
          {inviteUrl && (
            <>
              <div className="text-center text-supporting text-faint">Or</div>
              <Button
                variant="primary"
                type="button"
                className="w-full phone:min-h-11"
                icon={
                  <CopyCheck
                    copied={inviteCopy.copied}
                    idle={<IconLink size={16} />}
                    size={16}
                    checkClassName="text-on-accent"
                  />
                }
                onClick={() =>
                  inviteCopy.copy(inviteUrl, { toast: "Invite link copied" })
                }
              >
                {inviteCopy.copied ? "Invite link copied" : "Copy invite link"}
              </Button>
            </>
          )}
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

function MemberDialog({
  open,
  member,
  addLabel,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** null → add; a member → edit that member. */
  member: TeamMember | null;
  addLabel: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [github, setGithub] = useState("");
  const [slackId, setSlackId] = useState("");
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(member?.name ?? "");
    setEmail(member?.email ?? "");
    setGithub(member?.github ?? "");
    setSlackId(member?.slackId ?? "");
    setAlias(member?.aliases?.join(", ") ?? "");
  }, [open, member]);

  const parsedAliases = alias
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (!member) {
        const body = {
          name: trimmed,
          email: email.trim() || undefined,
          github: github.trim() || undefined,
          slackId: slackId.trim() || undefined,
          aliases: parsedAliases.length ? parsedAliases : undefined,
        };
        await setupRequest("/api/setup/team", { method: "POST", json: body });
        toast(`${trimmed} added`);
      } else {
        // Partial update: only changed fields ride; an emptied field that was
        // set is deleted with null; a changed name renames.
        const patch: TeamMemberUpdate = {};
        if (trimmed !== member.name) patch.name = trimmed;
        const diffField = (
          key: "email" | "github" | "slackId",
          next: string,
          prev: string | undefined,
        ) => {
          const v = next.trim();
          if (v) {
            if (v !== (prev ?? "")) patch[key] = v;
          } else if (prev) {
            patch[key] = null;
          }
        };
        diffField("email", email, member.email);
        diffField("github", github, member.github);
        diffField("slackId", slackId, member.slackId);
        const prevAliases = member.aliases ?? [];
        if (JSON.stringify(parsedAliases) !== JSON.stringify(prevAliases)) {
          patch.aliases = parsedAliases.length ? parsedAliases : null;
        }
        if (Object.keys(patch).length > 0) {
          await setupRequest(
            `/api/setup/team/${encodeURIComponent(member.name)}`,
            {
              method: "PUT",
              json: patch,
            },
          );
        }
        toast(`${trimmed} saved`);
      }
      setSaving(false);
      await onSaved();
    } catch (error) {
      setError(errorMessage(error, "Could not save member"));
      setSaving(false);
    }
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      disablePointerDismissal={saving}
    >
      <Modal.Content initialFocus={nameRef}>
        <Modal.Header
          title={member ? `Edit ${member.name}` : addLabel}
          description="Commits, sessions, and access grants resolve through this person."
        />
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label="Full name">
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
              spellCheck={false}
            />
          </Field>
          {/* Email and Alias run full width: an address clips in a
					    half-dialog column, and an alias list grows. Only the two
					    short identifiers share a row. */}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              spellCheck={false}
            />
          </Field>
          <FieldGrid>
            <Field label="GitHub login">
              <Input
                value={github}
                onChange={(e) => setGithub(e.target.value)}
                placeholder="adalovelace"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field label="Slack member id">
              <Input
                className="font-mono"
                value={slackId}
                onChange={(e) => setSlackId(e.target.value)}
                placeholder="U01ABCDEF"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          </FieldGrid>
          <Field label="Alias">
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="ada"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          {error && <InlineAlert>{error}</InlineAlert>}
          <Modal.Footer>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!name.trim() || saving}
            >
              {saving ? "Saving…" : member ? "Save changes" : addLabel}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
