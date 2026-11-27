import { useEffect, useState } from "react";
import { relativeTime } from "../../lib/api";
import { BASE_PATH } from "../../lib/base";
import { errorMessage } from "../../lib/error-message";
import { cn } from "../../ui/cn";
import {
  diffLineTone,
  fetchMemoryCommit,
  fetchMemoryFile,
  fetchMemoryFiles,
  fetchMemoryHistory,
  fetchMemoryRepos,
  revertMemoryCommit,
  saveMemoryRemote,
  syncMemoryRemote,
  type MemoryCommitDto,
  type MemoryRemoteStatus,
  type MemoryRepoDto,
} from "../../lib/memory-repo";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/input";
import { OptionSelect } from "../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
  SettingsSection,
  StatusChip,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconChevronLeft, IconChevronRight } from "../icons";

// Memory repositories (git, Agent Memory Repo format) in Settings: the list on
// the Memories page, and one page per repository with its remote, recent
// changes (diff and revert) and files.

/** The list of repositories shown on the Memories page in repo mode. */
export function MemoryReposCard({
  onOpen,
}: {
  onOpen: (repo: string) => void;
}) {
  const [repos, setRepos] = useState<MemoryRepoDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMemoryRepos()
      .then((response) => setRepos(response.repos))
      .catch((fetchError) =>
        setError(
          errorMessage(fetchError, "Failed to load memory repositories"),
        ),
      );
  }, []);

  if (error) return <InlineAlert>{error}</InlineAlert>;
  if (!repos)
    return <SettingCardSkeleton rows={2} label="Loading memory repositories" />;
  if (!repos.length) return null;
  return (
    <div className="mb-3">
      <SettingsGroupLabel>Git repositories</SettingsGroupLabel>
      <SettingCard>
        {repos.map((repo) => (
          <Button
            key={repo.name}
            variant="ghost"
            className="group min-h-11 w-full justify-start gap-3 whitespace-normal rounded-2xl px-5 py-3.5 text-left"
            onClick={() => onOpen(repo.name)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-item-title font-medium text-fg">
                {repo.label}
              </span>
              <span className="mt-0.5 block truncate text-meta text-dim">
                {repo.name}
                {repo.remote.url ? ` · ${repo.remote.url}` : " · local only"}
              </span>
            </span>
            {repo.remote.url && <RemoteChip status={repo.remote} />}
            <IconChevronRight
              size={20}
              className="shrink-0 text-faint group-hover:text-dim"
            />
          </Button>
        ))}
      </SettingCard>
    </div>
  );
}

function RemoteChip({ status }: { status: MemoryRemoteStatus }) {
  if (status.conflict) return <StatusChip label="Conflict" dot="var(--red)" />;
  if (status.ok === false)
    return <StatusChip label="Sync failed" dot="var(--red)" />;
  if (status.ok) return <StatusChip label="Synced" dot="var(--green)" />;
  return <StatusChip label="Not synced yet" dot="var(--text-faint)" />;
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="m-0 max-h-96 overflow-auto rounded-xl bg-code-well p-3 font-mono text-meta leading-relaxed text-code-well-ink">
      {diff.split("\n").map((line, index) => {
        const tone = diffLineTone(line);
        return (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap break-words",
              tone === "add" && "text-green",
              tone === "remove" && "text-red",
              tone === "meta" && "text-dim",
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function CommitRow({
  repo,
  commit,
  onReverted,
}: {
  repo: string;
  commit: MemoryCommitDto;
  onReverted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || diff !== null) return;
    try {
      setDiff((await fetchMemoryCommit(repo, commit.sha)).diff);
    } catch (error) {
      setDiff("");
      toast(errorMessage(error, "Failed to load the change"), {
        variant: "error",
      });
    }
  }

  async function revert() {
    setBusy(true);
    try {
      await revertMemoryCommit(repo, commit.sha);
      toast("Change reverted", { variant: "success" });
      onReverted();
    } catch (error) {
      toast(errorMessage(error, "Failed to revert the change"), {
        variant: "error",
      });
    }
    setBusy(false);
  }

  const files = commit.files.length;
  return (
    <div className="border-b border-line px-5 py-3 last:border-b-0">
      <div className="flex items-start gap-3 phone:flex-col phone:items-stretch">
        <Button
          variant="ghost"
          aria-expanded={open}
          className="-mx-2 min-h-11 min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1 text-left font-normal"
          onClick={toggle}
        >
          <IconChevronRight
            size={20}
            className={cn(
              "mt-1 shrink-0 text-faint transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-item-title leading-snug text-fg">
              {commit.subject}
            </span>
            <span className="mt-0.5 block text-meta text-dim">
              {commit.author} · {relativeTime(commit.date)} · {files}{" "}
              {files === 1 ? "file" : "files"}
              {" · "}
              <span className="font-mono">{commit.sha.slice(0, 8)}</span>
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 items-center gap-2">
          {commit.sessionId && (
            <Button
              size="sm"
              variant="ghost"
              render={<a href={`${BASE_PATH}/session/${commit.sessionId}`} />}
            >
              Session
            </Button>
          )}
          <Button size="sm" variant="default" disabled={busy} onClick={revert}>
            Revert
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-3">
          {diff === null ? (
            <div className="text-meta text-dim">Loading the change…</div>
          ) : (
            <DiffView diff={diff} />
          )}
        </div>
      )}
    </div>
  );
}

function RemoteSection({
  repo,
  initial,
}: {
  repo: string;
  initial: MemoryRemoteStatus;
}) {
  const [status, setStatus] = useState(initial);
  const [url, setUrl] = useState(initial.url || "");
  const [busy, setBusy] = useState(false);

  async function run(
    action: () => Promise<{ remote: MemoryRemoteStatus }>,
    done: string,
  ) {
    setBusy(true);
    try {
      const response = await action();
      setStatus(response.remote);
      setUrl(response.remote.url || "");
      if (response.remote.ok === false)
        toast(response.remote.error || "Sync failed", { variant: "error" });
      else toast(done, { variant: "success" });
    } catch (error) {
      toast(errorMessage(error, "Failed to save the remote"), {
        variant: "error",
      });
    }
    setBusy(false);
  }

  return (
    <SettingsSection className="mb-3">
      <div className="text-item-title font-semibold text-fg">Remote</div>
      <p className="m-0 mt-1 text-supporting text-dim">
        Optional. Syncs this repository with a private git remote so other tools
        can use the same memory. GitHub repositories must be private.
      </p>
      <form
        className="mt-3 flex items-end gap-2 phone:flex-col phone:items-stretch"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () => saveMemoryRemote(repo, url.trim()),
            url.trim() ? "Remote saved" : "Remote removed",
          );
        }}
      >
        <Field label="Remote URL" className="min-w-0 flex-1">
          <Input
            value={url}
            placeholder="git@github.com:acme/memory-team.git"
            onChange={(event) => setUrl(event.target.value)}
            className="phone:text-[length:var(--text-input-phone)]"
          />
        </Field>
        <Button
          type="submit"
          disabled={busy || url.trim() === (status.url || "")}
        >
          Save
        </Button>
        {status.url && (
          <Button
            type="button"
            variant="default"
            disabled={busy}
            onClick={() => void run(() => syncMemoryRemote(repo), "Synced")}
          >
            Sync now
          </Button>
        )}
      </form>
      {status.url && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-meta text-dim">
          <RemoteChip status={status} />
          {status.lastSyncAt && (
            <span>Last sync {relativeTime(status.lastSyncAt)}</span>
          )}
        </div>
      )}
      {status.error && (
        <InlineAlert className="mt-3">{status.error}</InlineAlert>
      )}
      {status.conflict && (
        <div className="mt-2 text-meta text-dim">
          Conflicting files: {status.conflict.files.join(", ") || "unknown"}
        </div>
      )}
    </SettingsSection>
  );
}

function FilesSection({ repo }: { repo: string }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [path, setPath] = useState("MEMORY.md");
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    fetchMemoryFiles(repo)
      .then((response) => setFiles(response.files))
      .catch(() => setFiles([]));
  }, [repo]);

  useEffect(() => {
    setContent(null);
    fetchMemoryFile(repo, path)
      .then((response) => setContent(response.content))
      .catch((error) =>
        setContent(errorMessage(error, "Failed to load the file")),
      );
  }, [repo, path]);

  const options = (files || ["MEMORY.md"]).map((file) => ({
    value: file,
    label: file,
  }));
  return (
    <SettingsSection className="mb-3">
      <div className="flex items-center justify-between gap-3 phone:flex-col phone:items-stretch">
        <div className="text-item-title font-semibold text-fg">Files</div>
        <OptionSelect
          label="File"
          value={path}
          options={options}
          onChange={setPath}
        />
      </div>
      <pre className="m-0 mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-code-well p-3 font-mono text-meta leading-relaxed text-code-well-ink">
        {content ?? "Loading…"}
      </pre>
    </SettingsSection>
  );
}

/** One memory repository: remote, recent changes, files. */
export function MemoryRepoPage({
  repo,
  onBack,
}: {
  repo: string;
  onBack: () => void;
}) {
  const [info, setInfo] = useState<MemoryRepoDto | null>(null);
  const [commits, setCommits] = useState<MemoryCommitDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    fetchMemoryRepos()
      .then((response) =>
        setInfo(response.repos.find((item) => item.name === repo) || null),
      )
      .catch((fetchError) =>
        setError(errorMessage(fetchError, "Failed to load the repository")),
      );
  }, [repo]);

  useEffect(() => {
    fetchMemoryHistory(repo, { limit: 40 })
      .then((response) => setCommits(response.commits))
      .catch((fetchError) =>
        setError(errorMessage(fetchError, "Failed to load memory history")),
      );
  }, [repo, version]);

  return (
    <SettingsPanel>
      <SettingsHeader
        title={info?.label ? `${info.label} memory` : "Memory repository"}
        description={`Git repository ${repo}. Sessions clone it, edit it and push; every change below can be reverted.`}
      />
      <div className="mb-3 px-5">
        <Button
          size="sm"
          variant="ghost"
          icon={<IconChevronLeft size={20} />}
          onClick={onBack}
        >
          Back
        </Button>
      </div>
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {info && <RemoteSection key={repo} repo={repo} initial={info.remote} />}
      <SettingsGroupLabel>Recent changes</SettingsGroupLabel>
      <SettingCard className="mb-3">
        {commits === null ? (
          <SettingRow>
            <SettingRowText>
              <SettingRowTitle>Loading changes…</SettingRowTitle>
              <SettingRowDescription>
                Reading the repository history.
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl />
          </SettingRow>
        ) : commits.length ? (
          commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              repo={repo}
              commit={commit}
              onReverted={() => setVersion((value) => value + 1)}
            />
          ))
        ) : (
          <EmptyState placement="card" title="No changes yet">
            Changes appear here once a session saves memory.
          </EmptyState>
        )}
      </SettingCard>
      <FilesSection repo={repo} />
    </SettingsPanel>
  );
}
