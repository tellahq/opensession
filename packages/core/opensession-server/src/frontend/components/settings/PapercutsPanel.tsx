import { useEffect, useState } from "react";
import {
  fetchPapercuts,
  setPapercutsRepoEnabled,
  type PapercutDto,
  type PapercutsRepoConfig,
} from "../../lib/api";
import { warmAgo } from "../../lib/time";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { Select, SettingRow } from "./shared";

// ── Papercuts: the cross-session friction log agents append via the
// opensession-papercuts tools — per-repo toggles + the recent entries. ──
export function PapercutsPanel() {
  const [repos, setRepos] = useState<PapercutsRepoConfig[] | null>(null);
  const [entries, setEntries] = useState<PapercutDto[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPapercuts({ repo: repoFilter || undefined, days: 30 })
      .then((r) => {
        if (!alive) return;
        setRepos(r.repos);
        setEntries(r.entries);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repoFilter]);

  const header = (
    <SettingsHeader
      title="Papercuts"
      description="Friction agents hit while working."
    />
  );

  if (!repos)
    return (
      <SettingsPanel>
        {header}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <>
            <SettingsGroupLabel>Repositories</SettingsGroupLabel>
            <SettingCardSkeleton rows={3} label="Loading papercuts" />
          </>
        )}
      </SettingsPanel>
    );

  return (
    <SettingsPanel>
      {header}

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      <SettingsGroupLabel>Repositories</SettingsGroupLabel>
      <SettingCard>
        {repos.map((r) => (
          <SettingRow
            key={r.repoId}
            title={r.repoId}
            desc={r.enabled ? "Agents here log the friction they hit." : "Off."}
            control={
              <Switch
                aria-label={`Papercuts for ${r.repoId}`}
                checked={r.enabled}
                onCheckedChange={(v) =>
                  setPapercutsRepoEnabled(r.repoId, v)
                    .then((res) => setRepos(res.repos))
                    .catch((e) => setError(e.message))
                }
              />
            }
          />
        ))}
      </SettingCard>

      <SettingsGroupLabel className="flex items-center justify-between gap-2">
        Last 30 days · {entries.length} logged
        <Select
          label="Filter papercuts by repo"
          value={repoFilter}
          options={[
            { value: "", label: "All repos" },
            ...repos.map((r) => ({ value: r.repoId, label: r.repoId })),
          ]}
          onChange={setRepoFilter}
        />
      </SettingsGroupLabel>
      {entries.length === 0 ? (
        <EmptyState placement="card">
          Nothing logged yet. Papercuts appear here as agents hit friction.
        </EmptyState>
      ) : (
        <SettingCard>
          {entries.map((e, i) => (
            <div
              key={`${e.ts}-${i}`}
              className="border-b border-line px-5 py-3 last:border-b-0"
            >
              <div className="text-body leading-relaxed text-fg">
                {e.message}
              </div>
              <div className="mt-1 text-meta text-faint">
                {[
                  e.repo,
                  e.by,
                  e.runKind && e.runKind !== "prompt" ? e.runKind : null,
                  warmAgo(e.ts),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          ))}
        </SettingCard>
      )}
    </SettingsPanel>
  );
}
