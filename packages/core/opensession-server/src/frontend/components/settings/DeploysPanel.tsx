import { useEffect, useState } from "react";
import {
  deleteDeployApp,
  fetchDeploys,
  rollbackDeployTo,
  setDeployRunning,
  type DeployDto,
} from "../../lib/api";
import { PRODUCT_NAME } from "../../lib/brand";
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
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  underline: {
    textDecorationLine: "underline",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap1: {
    gap: "4px",
  },
});

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
      description={`Web apps published from sessions, served at /d/<name>/ behind the same sign-in as ${PRODUCT_NAME}. They keep running after the session ends. Only $DATA_DIR survives a redeploy.`}
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
        <EmptyState placement="card">
          Nothing published yet. Ask a session to build a small internal tool
          and publish it.
        </EmptyState>
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
                    {...stylex.props(sx.underline)}
                    href={`/d/${d.name}/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    /d/{d.name}/
                  </a>
                  {d.sessionId ? (
                    <>
                      {" · "}
                      <a
                        {...stylex.props(sx.underline)}
                        href={`/session/${d.sessionId}`}
                      >
                        published from this session
                      </a>
                    </>
                  ) : null}
                </>
              }
              control={
                <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap1)}>
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
        A deploy is agent-authored code running unsandboxed on this box for as
        long as it is started. Delete anything you don't recognise.
      </SettingsHint>
    </SettingsPanel>
  );
}
