import { useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { BASE_PATH } from "../lib/base";
import { AGENT_NAME } from "../lib/brand";
import type { CredentialRequest } from "../lib/credential-registration-store";
import { useCredentialRegistration } from "../hooks/useCredentialRegistration";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** POST an answer. Outside the component so its throws stay out of React
 *  Compiler's way. The secret is only ever in this request body. */
async function answer(
  requestId: string,
  body: { sessionId: string; secret?: string },
  decline: boolean,
): Promise<void> {
  const res = await fetch(
    `${BASE_PATH}/api/keychain/registrations/${requestId}${decline ? "/decline" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Couldn't save the credential");
  }
}

type Changeable = NonNullable<CredentialRequest["changed"]>[number];

const FIELD_LABELS: Record<Changeable, string> = {
  host: "Host",
  description: "Description",
  loginUrl: "Sign-in page",
  username: "Username",
  injection: "Header",
  allowedMethods: "Methods",
  allowedPathPrefixes: "Paths",
  statusOnly: "Responses",
};

type FieldValues = NonNullable<CredentialRequest["previous"]>;

/** One field's value in `values` as the card shows it. */
function fieldValue(
  field: Changeable,
  values: FieldValues | undefined,
): string {
  switch (field) {
    case "injection": {
      const header = values?.injection?.header ?? "Authorization";
      const scheme = values?.injection?.scheme ?? "Bearer";
      return scheme ? `${header}: ${scheme}` : header;
    }
    case "statusOnly":
      return values?.statusOnly ? "Status only" : "Full response";
    case "allowedMethods":
    case "allowedPathPrefixes":
      return values?.[field]?.length ? values[field].join(", ") : "All";
    default:
      return values?.[field] || "None";
  }
}

function headline(request: CredentialRequest): string {
  const login = request.kind === "login";
  if (request.action === "delete")
    return `${AGENT_NAME} wants to delete a ${login ? "login" : "credential"} from the keychain`;
  if (request.action === "update")
    return request.changed?.length
      ? `${AGENT_NAME} wants to change a ${login ? "login" : "credential"} in the keychain`
      : `${AGENT_NAME} wants to replace a keychain ${login ? "password" : "secret"}`;
  return login
    ? `${AGENT_NAME} wants to add a login to the keychain`
    : `${AGENT_NAME} wants to add a credential to the keychain`;
}

/**
 * The agent asked the person driving this session to add a keychain
 * credential (opensession-keychain register_credential), or to replace or
 * delete one they own (update_credential, delete_credential). Every viewer
 * sees the card, but only the driver gets the field and buttons: the
 * credential is theirs. A secret goes straight to the keychain over HTTP,
 * never to the agent.
 */
export function CredentialRegistrationCard({
  sessionId,
}: {
  sessionId: string;
}) {
  const open = useCredentialRegistration(sessionId);
  if (!open) return null;
  return (
    <RequestCard
      key={open.request.id}
      sessionId={sessionId}
      request={open.request}
      canAnswer={open.canAnswer}
    />
  );
}

function RequestCard({
  sessionId,
  request,
  canAnswer,
}: {
  sessionId: string;
  request: CredentialRequest;
  canAnswer: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = request.kind === "login";
  const deleting = request.action === "delete";
  const updating = request.action === "update";
  const secretOptional = updating && !request.requireSecret;
  const word = login ? "password" : "secret";

  async function submit(decline: boolean) {
    if (!decline && !deleting && !secretOptional && !secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await answer(
        request.id,
        decline || deleting || !secret.trim()
          ? { sessionId }
          : { sessionId, secret },
        decline,
      );
      // The resolved broadcast closes the card for every viewer.
    } catch (caught) {
      setBusy(false);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't save the credential",
      );
    }
  }

  const changes = (request.changed ?? []).map((field) => ({
    field,
    from: fieldValue(field, request.previous),
    to: fieldValue(field, request),
  }));
  const limits = [
    request.allowedMethods?.length ? request.allowedMethods.join(", ") : null,
    request.allowedPathPrefixes?.length
      ? request.allowedPathPrefixes.join(", ")
      : null,
  ].filter(Boolean);

  return (
    <section
      className={ASK_CARD_SHELL}
      aria-label={
        deleting
          ? "Credential deletion"
          : updating
            ? "Credential update"
            : "Credential request"
      }
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={
            deleting
              ? "h-1.5 w-1.5 shrink-0 rounded-full bg-red shadow-[0_0_0_3px_var(--red-soft)]"
              : "h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
          }
        />
        <span className="text-label font-semibold text-dim">
          {headline(request)}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]">
          <span className="font-semibold">{request.service}</span>
          {login ? (
            <>
              : {request.username} on {request.loginUrl}
            </>
          ) : (
            <> for {request.host}</>
          )}
        </p>
        {request.description && (
          <p className="m-0 text-supporting text-dim [overflow-wrap:anywhere]">
            {request.description}
          </p>
        )}
        {changes.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {changes.map((change) => (
              <li
                key={change.field}
                className="text-meta text-dim [overflow-wrap:anywhere]"
              >
                {FIELD_LABELS[change.field]}:{" "}
                <span className="text-faint line-through">{change.from}</span> →{" "}
                <span className="text-fg">{change.to}</span>
              </li>
            ))}
          </ul>
        ) : (
          limits.length > 0 && (
            <p className="m-0 text-meta text-dim [overflow-wrap:anywhere]">
              Limited to {limits.join(" · ")}
            </p>
          )
        )}
        <p className="m-0 text-meta text-faint">
          {!canAnswer
            ? deleting
              ? `Waiting for ${request.owner} to confirm.`
              : updating
                ? `Waiting for ${request.owner} to confirm the change.`
                : `Waiting for ${request.owner} to add the ${word}.`
            : deleting
              ? "Its active grants are revoked, and any run using it stops."
              : updating
                ? request.changed?.includes("host") ||
                  request.changed?.includes("loginUrl")
                  ? `Its active grants are revoked: they were approved for the old ${login ? "sign-in page" : "host"}.`
                  : `Its active grants keep working. ${AGENT_NAME} never sees the ${word}.`
                : login
                  ? `Owned by you. Each time a session asks, you decide whether to release the password to it, and ${AGENT_NAME} can read it then. Use a test account.`
                  : `Owned by you. Teammates' sessions must ask you before using it. ${AGENT_NAME} never sees the secret.`}
        </p>
      </div>

      {canAnswer && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          {!deleting && (
            <Input
              type="password"
              size="lg"
              aria-label={login ? "Password" : "Secret"}
              placeholder={
                secretOptional
                  ? `Paste a new ${word}, or leave empty to keep it`
                  : updating
                    ? `Paste the new ${word}`
                    : `Paste the ${word}`
              }
              autoComplete="off"
              spellCheck={false}
              value={secret}
              disabled={busy}
              onChange={(event) => setSecret(event.target.value)}
              className="phone:min-h-11"
            />
          )}
          {error && (
            <p className="m-0 text-meta text-red" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="soft"
              size="lg"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {deleting ? "Keep it" : "Decline"}
            </Button>
            <Button
              type="submit"
              variant={deleting ? "danger-strong" : "primary"}
              size="lg"
              disabled={
                busy || (!deleting && !secretOptional && !secret.trim())
              }
            >
              {deleting ? "Delete" : updating ? "Save" : "Save to keychain"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
