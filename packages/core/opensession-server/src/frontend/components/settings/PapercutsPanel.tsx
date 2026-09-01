import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

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
      description="Small frictions agents log while working: retried tool calls, flaky commands, misleading errors."
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
            <SettingsGroupLabel>Repos</SettingsGroupLabel>
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

      <SettingsGroupLabel>Repos</SettingsGroupLabel>
      <SettingCard>
        {repos.map((r) => (
          <SettingRow
            key={r.repoId}
            title={r.repoId}
            desc={
              r.enabled
                ? "Sessions and automations in this repo get the log_papercut tool and the nudge to use it."
                : "Off. Runs in this repo don't log papercuts."
            }
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

      <SettingsGroupLabel
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.itemsCenter,
          sx.justifyBetween,
          sx.gap2,
        )}
      >
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
              {...mergeStylexProps(
                "last:border-b-0",
                sx.borderB,
                sx.borderLine,
                sx.px5,
                sx.py3,
              )}
            >
              <div
                {...stylex.props(sx.leadingRelaxed, sx.textFg, typography.body)}
              >
                {e.message}
              </div>
              <div {...stylex.props(sx.mt1, sx.textFaint, typography.meta)}>
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
