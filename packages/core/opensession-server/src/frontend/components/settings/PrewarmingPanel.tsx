import { useEffect, useState } from "react";
import {
  fetchWarmTemplates,
  refreshWarmTemplateNow,
  updateWarmTemplate,
  type WarmTemplateEntry,
} from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import { warmAgo } from "../../lib/time";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { Select, SettingRow } from "./shared";

// ── Warm previews (per-repo prebuilt template worktrees) ────────────────────

const WARM_INTERVAL_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "Every hour" },
  { value: "3", label: "Every 3 hours" },
  { value: "6", label: "Every 6 hours" },
  { value: "12", label: "Every 12 hours" },
  { value: "24", label: "Daily" },
];

function WarmPreviewsPanel() {
  const [repos, setRepos] = useState<WarmTemplateEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchWarmTemplates()
      .then((r) => alive && setRepos(r.repos))
      .catch(
        (cause: unknown) =>
          alive &&
          setError(errorMessage(cause, "Failed to load dependency caches")),
      );
    return () => {
      alive = false;
    };
  }, []);

  // Poll while a refresh runs so the status line flips to "Warm at <sha>"
  // on its own.
  useEffect(() => {
    if (!repos?.some((e) => e.refreshing)) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchWarmTemplates()
        .then((r) => alive && setRepos(r.repos))
        .catch(() => {
          // The last repo statuses remain valid and visible, so a failed
          // background refresh poll leaves that stale status in place.
        });
    }, 5000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [repos]);

  function apply(p: Promise<{ repos: WarmTemplateEntry[] }>) {
    p.then((r) => setRepos(r.repos)).catch((cause: unknown) =>
      setError(errorMessage(cause, "Failed to update dependency cache")),
    );
  }

  const label = (
    <SettingsGroupLabel className="mt-0">
      Host dependency cache
    </SettingsGroupLabel>
  );

  if (!repos)
    return (
      <>
        {label}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={3} label="Loading repos" />
        )}
      </>
    );

  return (
    <>
      {label}

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      <SettingCard>
        {repos.map((entry) => {
          const s = entry.state;
          const status = entry.refreshing
            ? "Refreshing now, updating the dependency cache…"
            : !entry.enabled
              ? "Off. Fresh worktrees install cold."
              : s?.ok
                ? `Cached at ${s.sha} · refreshed ${warmAgo(s.refreshedAt)} · ${
                    entry.spares
                  } spare${entry.spares === 1 ? "" : "s"} ready`
                : s?.lastError
                  ? `Last refresh failed: ${s.lastError}`
                  : "Enabled. First refresh runs shortly.";
          return (
            <SettingRow
              key={entry.repoId}
              title={entry.repoId}
              desc={status}
              control={
                <div className="flex items-center gap-2">
                  {entry.enabled && (
                    <>
                      <Button
                        size="sm"
                        disabled={entry.refreshing}
                        onClick={() =>
                          apply(refreshWarmTemplateNow(entry.repoId))
                        }
                      >
                        {entry.refreshing ? "Building…" : "Run now"}
                      </Button>
                      <Select
                        label={`Refresh interval for ${entry.repoId}`}
                        value={String(entry.intervalHours)}
                        options={WARM_INTERVAL_OPTIONS}
                        onChange={(v) =>
                          apply(
                            updateWarmTemplate(entry.repoId, {
                              intervalHours: parseInt(v, 10),
                            }),
                          )
                        }
                      />
                    </>
                  )}
                  <Switch
                    aria-label={`Warm deps for ${entry.repoId}`}
                    checked={entry.enabled}
                    onCheckedChange={(v) =>
                      apply(updateWarmTemplate(entry.repoId, { enabled: v }))
                    }
                  />
                </div>
              }
            />
          );
        })}
      </SettingCard>
      <SettingsHint>
        Keeps a host-side worktree per repo with node_modules installed,
        refreshed from its default branch on a schedule. Host sessions adopt a
        ready copy instead of paying a cold install.
      </SettingsHint>
    </>
  );
}

/** Session acceleration keeps only credential-free dependency trees on disk.
 * Live app services are started on demand as Portals. */
export function PrewarmingPanel() {
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Session acceleration"
        description="Host dependency caches make local sessions start quickly. Prepared remote projects live in Sandboxes."
      />
      <WarmPreviewsPanel />
    </SettingsPanel>
  );
}
