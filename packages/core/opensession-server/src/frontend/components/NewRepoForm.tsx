import React, { useEffect, useState } from "react";
import { validNewRepoName } from "../../shared/repo-name";
import { fetchGithubOwnersApi, type GithubOwner } from "../lib/api/repos";
import { githubNewRepoUrl, validGithubOwner } from "../lib/new-repo";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

/** The location picker's value for a repository that lives only here. */
const SERVER_ONLY = "";

const OTHER_GITHUB_OWNER = "@github";

/** Shared by Settings and the Project picker. GitHub creation stays in the
 * person's browser; only the subsequent remote registration reaches us. */
export function NewRepoForm({
  inputRef,
  busy,
  onSubmit,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** A create is in flight: the fields and button wait for it. */
  busy: boolean;
  /** A GitHub owner to connect, or undefined to create on this server. */
  onSubmit: (name: string, owner: string | undefined) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [owners, setOwners] = useState<GithubOwner[] | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // null until the person picks: the default follows the App's installations
  // once they load, without overriding a choice already made.
  const [chosenOwner, setChosenOwner] = useState<string | null>(null);
  const [customOwner, setCustomOwner] = useState("");
  const [hasOpenedGithub, setHasOpenedGithub] = useState(false);

  useEffect(() => {
    let live = true;
    setOwners(null);
    setOwnersError(null);
    fetchGithubOwnersApi()
      .then((result) => {
        if (!live) return;
        setOwners(result.owners ?? []);
        if (result.appConfigured && result.owners === null) {
          setOwnersError(
            "Could not load GitHub owners. Retry or choose this server only.",
          );
        }
      })
      .catch(() => {
        if (!live) return;
        setOwners([]);
        setOwnersError(
          "Could not load GitHub owners. Retry or choose this server only.",
        );
      });
    return () => {
      live = false;
    };
  }, [loadAttempt]);

  const accounts = owners ?? [];
  const defaultOwner =
    accounts.find((account) => account.selected)?.login ??
    accounts[0]?.login ??
    SERVER_ONLY;
  const location = chosenOwner ?? defaultOwner;
  const owner = location === OTHER_GITHUB_OWNER ? customOwner.trim() : location;
  const onGithub = location !== SERVER_ONLY;
  const ownerOptions = [
    ...accounts.map((account) => ({
      value: account.login,
      label: `${account.login} on GitHub`,
    })),
    { value: OTHER_GITHUB_OWNER, label: "Another GitHub owner…" },
    { value: SERVER_ONLY, label: "This server only" },
  ];
  const trimmed = name.trim();
  const validName = validNewRepoName(trimmed);
  const valid = validName && (!onGithub || validGithubOwner(owner));
  const githubUrl = onGithub && valid ? githubNewRepoUrl(owner, trimmed) : null;
  // Keep Connect available when the person corrects a name changed on GitHub.
  const opened = githubUrl !== null && hasOpenedGithub;

  function submit() {
    if (!valid || busy || owners === null || (onGithub && !opened)) return;
    void onSubmit(trimmed, onGithub ? owner : undefined);
  }

  return (
    <>
      <div className="text-supporting leading-relaxed text-dim">
        {owners === null ? (
          "Loading GitHub owners…"
        ) : !onGithub ? (
          <>
            Starts an empty repository on this server with a first commit on{" "}
            <code>main</code>. Sessions get branches, diffs and local review,
            but no GitHub pull requests. Choose a GitHub owner for PR support.
          </>
        ) : (
          <>
            Create on GitHub in a new tab. Choose Private and enable Add README,
            then return here to connect it.
          </>
        )}
      </div>
      {owners !== null && (
        <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
          <span className="shrink-0 text-supporting text-dim">Owner</span>
          <Select.Root
            items={ownerOptions}
            value={location}
            onValueChange={(next) => {
              if (next !== null) setChosenOwner(next);
            }}
            disabled={busy}
          >
            <Select.Trigger
              className="min-w-0 flex-1 phone:min-h-11"
              size="sm"
              aria-label="Repository owner"
            />
            <Select.Popup>
              {ownerOptions.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="phone:min-h-11"
                >
                  {option.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </div>
      )}
      {ownersError && (
        <div role="status" className="mt-2.5 text-supporting text-dim">
          {ownersError}{" "}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {location === OTHER_GITHUB_OWNER && (
        <Input
          className="mt-2.5 w-full font-mono phone:min-h-11 phone:text-input-phone"
          value={customOwner}
          onChange={(event) => setCustomOwner(event.target.value)}
          placeholder="GitHub username or organization"
          aria-label="GitHub owner"
          disabled={busy}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      )}
      <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
        <Input
          ref={inputRef}
          className="min-w-0 flex-1 font-mono phone:min-h-11 phone:text-input-phone"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          aria-label="Repository name"
          disabled={busy}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        {!onGithub && (
          <Button
            variant="primary"
            disabled={!valid || busy || owners === null}
            onClick={submit}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        )}
      </div>
      {onGithub && (
        <>
          <div className="mt-2.5 flex flex-wrap gap-2 phone:flex-col phone:items-stretch">
            {githubUrl && !busy ? (
              <Button
                variant={opened ? "soft" : "primary"}
                render={
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
                onClick={() => setHasOpenedGithub(true)}
                onAuxClick={() => setHasOpenedGithub(true)}
              >
                Open GitHub
              </Button>
            ) : (
              <Button variant="primary" disabled>
                Open GitHub
              </Button>
            )}
            {opened && (
              <Button variant="primary" disabled={busy} onClick={submit}>
                {busy ? "Connecting…" : "Connect repository"}
              </Button>
            )}
          </div>
          {opened && (
            <div
              role="status"
              className="mt-2.5 text-supporting leading-relaxed text-dim"
            >
              If you changed the name or owner on GitHub, update them here.
              Grant the App access to the new repository before connecting.
            </div>
          )}
        </>
      )}
      {onGithub && owner && !validGithubOwner(owner) && (
        <div className="mt-1.5 text-meta text-faint">
          Enter a GitHub username or organization, not a URL.
        </div>
      )}
      {trimmed && !validName && (
        <div className="mt-1.5 text-meta text-faint">
          Letters, digits, dots, dashes and underscores, starting with a letter
          or digit.
        </div>
      )}
    </>
  );
}
