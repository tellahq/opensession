import { AgentName } from "../AgentIdentity";
import { useEffect, useState } from "react";
import {
  deleteDeployApp,
  fetchDeploys,
  rollbackDeployTo,
  setDeployRunning,
  type DeployDto,
} from "../../lib/api";
import { Button } from "../../ui/button";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { SettingRow } from "./shared";

// ── Deploys: internal web apps agents published with opensession-publish.
// They outlive the session that made them, so this is where a human sees what
// is running and turns it off. ──
export function DeploysPanel() {
  const [deploys, setDeploys] = useState<DeployDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    fetchDeploys()
      .then((r) => setDeploys(r.deploys))
      .catch((e) => setError(e.message));
  };
  useEffect(reload, [reload]);

  const act = (p: Promise<unknown>) =>
    p.then(reload).catch((e) => setError(e.message));

  const header = (
    <SettingsHeader
      title="Deploys"
      description="Web apps published from sessions, served at /d/<name>/."
    />
  );

  if (!deploys)
    return (
      <SettingsPanel>
        {header}
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <SettingCardSkeleton rows={3} label="Loading deploys" />
        )}
      </SettingsPanel>
    );

  return (
    <SettingsPanel>
      {header}
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {deploys.length === 0 ? (
        <EmptyState placement="card">Nothing published yet.</EmptyState>
      ) : (
        <SettingCard>
          {deploys.map((d) => (
            <SettingRow
              key={d.id}
              title={`${d.name} · v${d.currentVersion} · ${d.state}`}
              desc={
                <>
                  {d.description ? `${d.description} · ` : ""}
                  owner {d.owner} · port {d.port}
                  {d.lastError ? ` · last error: ${d.lastError}` : ""}
                  <br />
                  <a
                    className="underline"
                    href={`/d/${d.name}/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    /d/{d.name}/
                  </a>
                  {d.sessionId ? (
                    <>
                      {" · "}
                      <a className="underline" href={`/session/${d.sessionId}`}>
                        <AgentName sessionId={d.sessionId} />
                      </a>
                    </>
                  ) : null}
                </>
              }
              control={
                <div className="flex items-center gap-1">
                  {d.currentVersion > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(rollbackDeployTo(d.name, d.currentVersion - 1))
                      }
                    >
                      Roll back
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      act(setDeployRunning(d.name, d.state !== "running"))
                    }
                  >
                    {d.state === "running" ? "Stop" : "Start"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(deleteDeployApp(d.name))}
                  >
                    Delete
                  </Button>
                </div>
              }
            />
          ))}
        </SettingCard>
      )}
      <SettingsHint>
        Deploys run unsandboxed on this server. Delete any you don&rsquo;t
        recognise.
      </SettingsHint>
    </SettingsPanel>
  );
}
