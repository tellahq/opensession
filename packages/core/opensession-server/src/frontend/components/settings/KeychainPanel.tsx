import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  addKeychainCredential,
  answerKeychainAsk,
  deleteKeychainCredential,
  fetchKeychain,
  revokeKeychainGrant,
  setKeychainCredentialScope,
  type KeychainAskDto,
  type KeychainCredentialDto,
  type KeychainGrantDto,
} from "../../lib/api";
import { Badge } from "../../ui/badge";
import { Menu } from "../../ui/menu";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { useConfirm } from "../../ui/confirm";
import { Field, Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
  rowMenuTriggerClasses,
} from "../../ui/settings";
import { IconTile } from "../BrandTile";
import {
  IconDotsHorizontal,
  IconKey,
  IconPeople,
  IconPlus,
  IconTrash,
  IconUser,
} from "../icons";
import { UserAvatar } from "../UserAvatar";
import { InlineAlert } from "../../ui/state";
import { SettingRow } from "./shared";

// ── Keychain: per-person credentials sessions can BORROW with your approval
// (src/server/keychain.ts). Registration lives here rather than in a tool
// because a secret pasted into a session prompt is a secret in the transcript.
// Old /settings/keychain links open this page again. ──

type KeychainData = {
  credentials: KeychainCredentialDto[];
  grants: KeychainGrantDto[];
  asks: KeychainAskDto[];
};

/** What a credential reaches, in one line: the login or the API host, and
 *  any ceiling on methods and paths. */
function credentialReach(c: KeychainCredentialDto): string {
  return [
    c.kind === "login" ? (c.username ?? "") : c.host,
    c.kind === "login" ? c.host : null,
    c.allowedMethods?.length ? `${c.allowedMethods.join(", ")} only` : null,
    c.allowedPathPrefixes?.length ? c.allowedPathPrefixes.join(", ") : null,
    c.statusOnly ? "Status codes only" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "in 3 days", "in 5 hours": when a grant runs out. */
function expiresIn(iso: string, now = Date.now()): string {
  const hours = Math.max(0, (new Date(iso).getTime() - now) / 3_600_000);
  if (hours < 1) return "Expires within the hour";
  if (hours < 48) return `Expires in ${Math.round(hours)} hours`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

export function KeychainPanel() {
  const [data, setData] = useState<KeychainData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"api" | "login" | null>(null);
  const serviceRef = useRef<HTMLInputElement>(null);
  const [confirm, confirmDialog] = useConfirm();

  const reload = () => {
    fetchKeychain()
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(reload, [reload]);
  const fail = (e: Error) => setError(e.message);

  const addMenu = (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button size="sm" icon={<IconPlus size={20} />} disabled={!data} />
        }
      >
        Add
      </Menu.Trigger>
      <Menu.Popup align="end" sideOffset={4} className="min-w-56">
        <Menu.Item onClick={() => setAdding("login")}>
          <IconUser size={20} className="text-dim" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>Login</span>
            <span className="text-meta text-faint">Username and password</span>
          </span>
        </Menu.Item>
        <Menu.Item onClick={() => setAdding("api")}>
          <IconKey size={20} className="text-dim" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>API key</span>
            <span className="text-meta text-faint">Sent with each call</span>
          </span>
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );

  const header = (
    <SettingsHeader
      title="Keychain"
      description="Sessions use these with your approval and never see the secret."
      actions={addMenu}
    />
  );

  if (!data)
    return (
      <SettingsPanel>
        {header}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={2} icon={32} label="Loading keychain" />
        )}
      </SettingsPanel>
    );

  const byId = new Map(data.credentials.map((c) => [c.id, c]));
  const mine = data.credentials.filter((c) => c.mine);
  const shared = data.credentials.filter((c) => !c.mine);
  const activeGrants = data.grants.filter((g) => g.status === "active");
  const pending = data.asks.filter((a) => a.status === "pending");
  const serviceOf = (id: string) => byId.get(id)?.service ?? id;
  // One owner's credentials in a multi-credential run are one answer.
  const sameRun = (a: KeychainAskDto) =>
    pending.filter(
      (o) =>
        o.canAnswer && !!a.run?.group && o.run?.group?.id === a.run.group.id,
    );
  const toAnswer = pending.filter(
    (a) => a.canAnswer && (!a.run?.group || sameRun(a)[0] === a),
  );
  const waiting = pending.filter((a) => !a.canAnswer);
  const answer = (
    id: string,
    decision: Parameters<typeof answerKeychainAsk>[1],
  ) => answerKeychainAsk(id, decision).then(reload).catch(fail);

  const setScope = (c: KeychainCredentialDto) => {
    const sharing = c.scope !== "workspace";
    confirm({
      title: sharing
        ? `Share ${c.service} with everyone?`
        : `Make ${c.service} personal?`,
      description: sharing
        ? c.kind === "login"
          ? "Any session can get its password without asking you. Each release is audited."
          : "Any session can call it without asking you, within its limits. Calls are audited."
        : "Sessions will have to ask you again, and access they got without asking ends now.",
      confirmLabel: sharing ? "Share" : "Make personal",
      onConfirm: () =>
        void setKeychainCredentialScope(
          c.id,
          sharing ? "workspace" : "personal",
        )
          .then(reload)
          .catch(fail),
    });
  };
  const remove = (c: KeychainCredentialDto) =>
    confirm({
      title: `Delete ${c.service}?`,
      description: "Sessions lose access to it right away.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () =>
        void deleteKeychainCredential(c.id).then(reload).catch(fail),
    });

  const credentialRow = (c: KeychainCredentialDto) => (
    <SettingRow
      key={c.id}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <IconTile name={c.service} size={32} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate">{c.service}</span>
              {c.scope === "workspace" && <Badge>Shared</Badge>}
            </span>
            <span className="mt-0.5 block truncate text-supporting font-normal text-dim">
              {c.mine ? credentialReach(c) : `From ${c.owner}`}
            </span>
          </span>
        </span>
      }
      control={
        c.mine ? (
          <Menu.Root>
            <Menu.Trigger
              className={rowMenuTriggerClasses}
              aria-label={`Manage ${c.service}`}
            >
              <IconDotsHorizontal size={20} />
            </Menu.Trigger>
            <Menu.Popup align="end" sideOffset={4}>
              <Menu.Item onClick={() => setScope(c)}>
                <IconPeople size={20} className="text-dim" />
                {c.scope === "workspace"
                  ? "Make personal"
                  : "Share with everyone"}
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item
                className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
                onClick={() => remove(c)}
              >
                <IconTrash size={20} />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : null
      }
    />
  );

  return (
    <SettingsPanel>
      {header}
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {confirmDialog}

      <Modal.Root
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
      >
        {/* The form is a child so Base UI's portal remounts it on every
            open, which clears a typed secret when the dialog is dismissed. */}
        <Modal.Content initialFocus={serviceRef}>
          {adding === "login" ? (
            <AddLoginForm
              serviceRef={serviceRef}
              onAdded={() => {
                setAdding(null);
                reload();
              }}
              onError={setError}
            />
          ) : (
            <AddCredentialForm
              serviceRef={serviceRef}
              onAdded={() => {
                setAdding(null);
                reload();
              }}
              onError={setError}
            />
          )}
        </Modal.Content>
      </Modal.Root>

      {/* Teammates asking to borrow one of your credentials come first: they
          are waiting on you. Only the owner can answer, here or in Slack;
          never in the asking session, where anyone watching could click. */}
      {toAnswer.length > 0 && (
        <>
          <SettingsGroupLabel>Requests</SettingsGroupLabel>
          <SettingCard>
            {toAnswer.map((a) => (
              <SettingRow
                key={a.id}
                title={
                  <span className="flex min-w-0 items-start gap-3">
                    <UserAvatar name={a.requestedBy} size={32} />
                    <span className="min-w-0">
                      <span className="block">
                        {a.requestedBy} wants{" "}
                        {a.run?.group
                          ? sameRun(a)
                              .map((o) => serviceOf(o.credentialId))
                              .join(" and ")
                          : serviceOf(a.credentialId)}
                      </span>
                      <span className="mt-0.5 block text-supporting font-normal text-dim">
                        {a.requestedMode === "release"
                          ? "The password, which the agent will see"
                          : a.run
                            ? `A script, up to ${(a.run.group ? a.run.group.members.reduce((n, m) => n + m.maxCalls, 0) : a.run.maxCalls).toLocaleString()} calls`
                            : a.requestedMode === "once"
                              ? "One call"
                              : "Access for 7 days"}
                        {" · "}
                        {a.purpose}
                      </span>
                      {a.run && (
                        <code className="mt-1.5 block truncate text-meta text-faint">
                          {a.run.command}
                        </code>
                      )}
                    </span>
                  </span>
                }
                controlClassName="flex flex-wrap justify-end gap-1"
                control={
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => answer(a.id, "decline")}
                    >
                      Decline
                    </Button>
                    {a.requestedMode === "release" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => answer(a.id, "release")}
                      >
                        Release
                      </Button>
                    ) : a.run ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => answer(a.id, "run")}
                      >
                        Allow run
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          onClick={() => answer(a.id, "standing")}
                        >
                          7 days
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => answer(a.id, "once")}
                        >
                          Allow once
                        </Button>
                      </>
                    )}
                  </>
                }
              />
            ))}
          </SettingCard>
        </>
      )}

      {data.credentials.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-raised text-dim">
            <IconKey size={24} />
          </span>
          <div className="text-item-title font-semibold text-fg">
            No credentials yet
          </div>
          <p className="m-0 max-w-sm text-supporting text-dim">
            Add a test login or an API key that sessions can borrow.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => setAdding("login")}>
              Add login
            </Button>
            <Button size="sm" onClick={() => setAdding("api")}>
              Add API key
            </Button>
          </div>
        </div>
      ) : (
        <>
          {mine.length > 0 && (
            <>
              <SettingsGroupLabel>Yours</SettingsGroupLabel>
              <SettingCard>{mine.map(credentialRow)}</SettingCard>
            </>
          )}
          {shared.length > 0 && (
            <>
              <SettingsGroupLabel>From teammates</SettingsGroupLabel>
              <SettingCard>{shared.map(credentialRow)}</SettingCard>
            </>
          )}
        </>
      )}

      {activeGrants.length > 0 && (
        <>
          <SettingsGroupLabel>Access</SettingsGroupLabel>
          <SettingCard>
            {activeGrants.map((g) => (
              <SettingRow
                key={g.id}
                title={
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar name={g.requestedBy} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {g.requestedBy} · {serviceOf(g.credentialId)}
                      </span>
                      <span className="mt-0.5 block truncate text-supporting font-normal text-dim">
                        {expiresIn(g.expiresAt)} · {g.purpose}
                      </span>
                    </span>
                  </span>
                }
                control={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void revokeKeychainGrant(g.id).then(reload).catch(fail)
                    }
                  >
                    Revoke
                  </Button>
                }
              />
            ))}
          </SettingCard>
        </>
      )}

      {waiting.length > 0 && (
        <>
          <SettingsGroupLabel>Waiting on others</SettingsGroupLabel>
          <SettingCard>
            {waiting.map((a) => (
              <SettingRow
                key={a.id}
                title={`${serviceOf(a.credentialId)} · ${a.owner}`}
                desc={a.purpose}
                control={null}
              />
            ))}
          </SettingCard>
        </>
      )}

      {data.credentials.length > 0 && (
        <SettingsHint>Add only test logins.</SettingsHint>
      )}
    </SettingsPanel>
  );
}

/**
 * Registering a credential. Every field used to be placeholder-only with an
 * `aria-label`, so the moment you typed, the one thing telling you what the
 * box was for disappeared — and seven of those stacked in a card pushed the
 * credentials list off the page. Real labels now, and the placeholders say
 * what leaving a field blank does instead of restating the label.
 *
 * Two zones: what the credential IS, then the ceiling on how it may be used.
 */
function AddCredentialForm({
  serviceRef,
  onAdded,
  onError,
}: {
  serviceRef: RefObject<HTMLInputElement | null>;
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const [service, setService] = useState("");
  const [host, setHost] = useState("");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [header, setHeader] = useState("");
  const [methods, setMethods] = useState("");
  const [prefixes, setPrefixes] = useState("");
  const [statusOnly, setStatusOnly] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = Boolean(service.trim() && host.trim() && secret);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const credential: Parameters<typeof addKeychainCredential>[0] = {
      service: service.trim(),
      host: host.trim(),
      secret,
    };
    if (description.trim()) credential.description = description.trim();
    if (header.trim()) credential.injection = { header: header.trim() };
    if (methods.trim()) credential.allowedMethods = list(methods);
    if (prefixes.trim()) credential.allowedPathPrefixes = list(prefixes);
    if (statusOnly) credential.statusOnly = true;
    if (workspace) credential.scope = "workspace";
    addKeychainCredential(credential)
      .then(() => {
        // Clear the secret first and always — it must not survive a
        // failed reload in a React state a devtools user can read back.
        setSecret("");
        onAdded();
      })
      .catch((e) => onError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Modal.Header
        title="Add API key"
        description="Sent with each call a session makes. The agent never sees it."
      />
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex flex-col gap-3">
          <Field label="Service">
            <Input
              ref={serviceRef}
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="vercel"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="API host">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="api.vercel.com"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Secret">
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Never shown again"
              autoComplete="off"
            />
          </Field>
          <Field label="Description" title="Optional.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What it is for"
            />
          </Field>
        </div>
        <div className="flex flex-col gap-3">
          <Field label="Injection header">
            <Input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="Authorization: Bearer"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Allowed methods" title="Comma-separated.">
            <Input
              value={methods}
              onChange={(e) => setMethods(e.target.value)}
              placeholder="Any method"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Allowed path prefixes" title="Comma-separated.">
            <Input
              value={prefixes}
              onChange={(e) => setPrefixes(e.target.value)}
              placeholder="Any path"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-label">
            <Checkbox
              checked={statusOnly}
              onCheckedChange={(v) => setStatusOnly(v === true)}
            />
            Return only the status code, never the response
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-label">
            <Checkbox
              checked={workspace}
              onCheckedChange={(v) => setWorkspace(v === true)}
            />
            Share with everyone: any session can use it without asking
          </label>
          {/* The hint belongs to this zone, so it sits inside it rather
					    than floating between the fields and the actions. */}
          <p className="m-0 text-supporting leading-relaxed text-faint">
            Limits here cap anything you approve later.
          </p>
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={busy || !ready}>
            {busy ? "Saving…" : "Add credential"}
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

/**
 * Registering a login: a test account a session signs in with. Unlike an
 * API credential, its password reaches the agent when the owner releases
 * it, so the form says so where the password is typed.
 */
function AddLoginForm({
  serviceRef,
  onAdded,
  onError,
}: {
  serviceRef: RefObject<HTMLInputElement | null>;
  onAdded: () => void;
  onError: (message: string) => void;
}) {
  const [service, setService] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = Boolean(
    service.trim() && loginUrl.trim() && username.trim() && password,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const login: Parameters<typeof addKeychainCredential>[0] = {
      service: service.trim(),
      kind: "login",
      loginUrl: loginUrl.trim(),
      username: username.trim(),
      secret: password,
    };
    if (description.trim()) login.description = description.trim();
    addKeychainCredential(login)
      .then(() => {
        setPassword("");
        onAdded();
      })
      .catch((e) => onError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Modal.Header
        title="Add login"
        description="A test account sessions can sign in with. You approve each use."
      />
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex flex-col gap-3">
          <Field label="Service">
            <Input
              ref={serviceRef}
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="acme-staging"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Sign-in page">
            <Input
              value={loginUrl}
              onChange={(e) => setLoginUrl(e.target.value)}
              placeholder="https://app.example.test/login or vnc://host"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Username">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="qa@example.test"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Never shown again here"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Description" title="Optional.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What it is for"
            />
          </Field>
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={busy || !ready}>
            {busy ? "Saving…" : "Add login"}
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
