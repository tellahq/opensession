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
  type KeychainAskDto,
  type KeychainCredentialDto,
  type KeychainGrantDto,
} from "../../lib/api";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Field, Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { SettingRow } from "./shared";

// ── Keychain: per-person credentials sessions can BORROW with your approval
// (src/server/keychain.ts). Registration lives here rather than in a tool
// because a secret pasted into a session prompt is a secret in the transcript.
//
// It renders as a section of Settings → Account rather than a page of its
// own: a credential you lend to a session is the same kind of thing as an
// account a session acts as, and it was one thin page in a nav that is already
// 22 entries deep. Old /settings/keychain links redirect there (App.tsx's
// LEGACY_SETTINGS_SECTIONS). ──
export function KeychainSection() {
  const [data, setData] = useState<{
    credentials: KeychainCredentialDto[];
    grants: KeychainGrantDto[];
    asks: KeychainAskDto[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"api" | "login" | null>(null);
  const serviceRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    fetchKeychain()
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(reload, [reload]);

  // The label, its action and the hint below the card are all static, so they
  // stay while the credentials are in flight — only the list is unknown, and
  // ghosting more than that is what makes the block change height when the
  // answer lands.
  const label = (
    <SettingsGroupLabel
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={!data}
            onClick={() => setAdding("login")}
          >
            Add login
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!data}
            onClick={() => setAdding("api")}
          >
            Add credential
          </Button>
        </>
      }
    >
      Keychain
    </SettingsGroupLabel>
  );
  const hint = (
    <SettingsHint>
      Any teammate's session can ask to borrow a credential. Its owner approves
      or declines here or in Slack. The secret is injected server-side, so the
      agent never sees it, and every grant expires. A login is different: the
      agent types its password into the sign-in page, so it can read it. Add
      only test accounts as logins.
    </SettingsHint>
  );

  if (!data)
    return (
      <>
        {label}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={2} label="Loading keychain" />
        )}
        {hint}
      </>
    );

  const byId = new Map(data.credentials.map((c) => [c.id, c]));
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
  ) =>
    answerKeychainAsk(id, decision)
      .then(reload)
      .catch((e) => setError(e.message));

  return (
    <>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {label}

      <Modal.Root
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
      >
        {/* The form is a child so Base UI's portal remounts it on every
				    open. That is what clears the typed secret when the dialog is
				    dismissed rather than saved: it used to be cleared only on a
				    successful submit, so cancelling left it sitting in a React
				    state a devtools user could read back. */}
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

      {data.credentials.length === 0 ? (
        <EmptyState placement="card">
          No credentials yet. Add one so sessions can request scoped access
          without putting a token in a prompt.
        </EmptyState>
      ) : (
        <SettingCard>
          {data.credentials.map((c) => (
            <SettingRow
              key={c.id}
              title={
                c.kind === "login"
                  ? `${c.service} · ${c.username ?? ""}`
                  : `${c.service} · ${c.host}`
              }
              desc={[
                c.kind === "login" ? `login on ${c.loginUrl ?? c.host}` : null,
                `owner ${c.owner}`,
                c.description,
                c.allowedMethods?.length
                  ? `methods ${c.allowedMethods.join("/")}`
                  : null,
                c.allowedPathPrefixes?.length
                  ? `paths ${c.allowedPathPrefixes.join(", ")}`
                  : null,
                c.statusOnly ? "status only" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                c.mine ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      deleteKeychainCredential(c.id)
                        .then(reload)
                        .catch((e) => setError(e.message))
                    }
                  >
                    Delete
                  </Button>
                ) : null
              }
            />
          ))}
        </SettingCard>
      )}
      {hint}

      {/* Teammates asking to borrow one of your credentials. Only the
			    owner can answer, here or in the Slack DM; never as a card in
			    the asking session, where anyone watching could click it. */}
      {toAnswer.length > 0 && (
        <>
          <SettingsGroupLabel>Requests for your credentials</SettingsGroupLabel>
          <SettingCard>
            {toAnswer.map((a) => (
              <SettingRow
                key={a.id}
                title={`${a.requestedBy} wants ${
                  a.run?.group
                    ? sameRun(a)
                        .map((o) => serviceOf(o.credentialId))
                        .join(" and ")
                    : serviceOf(a.credentialId)
                }`}
                desc={
                  a.requestedMode === "release"
                    ? `Wants the password, which the agent will see · ${a.purpose}`
                    : a.run?.group
                      ? `Scripted run with ${a.run.group.members
                          .map(
                            (m) =>
                              `${m.service} (owner ${m.owner}, up to ${m.maxCalls.toLocaleString()} calls)`,
                          )
                          .join(
                            ", ",
                          )}; starts once every owner allows it · ${a.run.command} · ${a.purpose}`
                      : a.run
                        ? `Scripted run, up to ${a.run.maxCalls.toLocaleString()} calls · ${a.run.command} · ${a.purpose}`
                        : `Asked for ${a.requestedMode === "once" ? "one call" : "7 days"} · ${a.purpose}`
                }
                controlClassName="flex flex-wrap justify-end gap-1"
                control={
                  a.requestedMode === "release" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => answer(a.id, "release")}
                      >
                        Release password
                      </Button>
                    </>
                  ) : a.run ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => answer(a.id, "run")}
                      >
                        Allow run
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => answer(a.id, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => answer(a.id, "standing")}
                      >
                        Allow 7 days
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => answer(a.id, "once")}
                      >
                        Allow once
                      </Button>
                    </>
                  )
                }
              />
            ))}
          </SettingCard>
          <SettingsHint>
            Allow once covers a single API call. Allow run covers one script, up
            to its call cap, while it runs. The session never sees those
            secrets, and you can revoke a grant below. Release password writes a
            login's password to a file the session reads once, deleted after 30
            minutes.
          </SettingsHint>
        </>
      )}

      {waiting.length > 0 && (
        <>
          <SettingsGroupLabel>Your pending requests</SettingsGroupLabel>
          <SettingCard>
            {waiting.map((a) => (
              <SettingRow
                key={a.id}
                title={`${byId.get(a.credentialId)?.service ?? a.credentialId} · waiting on ${a.owner}`}
                desc={`${a.requestedMode} · ${a.purpose}`}
                control={null}
              />
            ))}
          </SettingCard>
        </>
      )}

      {/* Only when there is one. As a page this group carried an empty
			    state; as a section it would be a second empty block under a
			    list most people never populate. */}
      {activeGrants.length > 0 && (
        <>
          <SettingsGroupLabel>Active grants</SettingsGroupLabel>
          <SettingCard>
            {activeGrants.map((g) => (
              <SettingRow
                key={g.id}
                title={`${byId.get(g.credentialId)?.service ?? g.credentialId} → ${g.requestedBy}`}
                desc={`${g.mode} · expires ${new Date(g.expiresAt).toLocaleString()} · ${g.purpose}`}
                control={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      revokeKeychainGrant(g.id)
                        .then(reload)
                        .catch((e) => setError(e.message))
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
    </>
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
        title="Add credential"
        description="A session can borrow it with your approval. The secret is injected server-side, so the agent never sees it."
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
          {/* The hint belongs to this zone, so it sits inside it rather
					    than floating between the fields and the actions. */}
          <p className="m-0 text-supporting leading-relaxed text-faint">
            Narrow the methods and paths where you can. A grant can only reach
            what the credential allows, so this is the ceiling on anything you
            approve later.
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
        description="A test account a session can sign in with. You approve each release, and the agent can read the password once it has it."
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
              placeholder="https://app.example.test/login"
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
