import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  bootstrapRunner,
  createRunnerPairing,
  fetchRunnerBootstrapTargets,
  fetchRunners,
  revokeRunner,
  updateRunner,
  type RunnerBootstrapTarget,
  type RunnerInfo,
} from "../../lib/api/runners";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Field, Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { OptionSelect } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { toast } from "../../ui/toast";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../../ui/settings";
import {
  markTileClass,
  markTileGradient,
  markTileInk,
  markTileShadow,
} from "../../lib/mark-tile";
import { IconServer } from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mx4: {
    marginInline: "calc(4px * 4)",
  },
  mb4: {
    marginBottom: "calc(4px * 4)",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  mt1: {
    marginTop: "4px",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  grid: {
    display: "grid",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  smGridCols3: {
    "@media (min-width: 40rem)": {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    },
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  flex: {
    display: "flex",
  },
  mb0: {
    marginBottom: "0",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py5: {
    paddingBlock: "calc(4px * 5)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  gridColsMinmax01fr575rem: {
    gridTemplateColumns: "minmax(0,1fr) 5.75rem",
  },
  gapX4: {
    columnGap: "calc(4px * 4)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  desktopGridColsMinmax01fr13rem: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "minmax(0,1fr) 13rem",
    },
  },
  colStart1: {
    gridColumnStart: "1",
  },
  rowStart1: {
    gridRowStart: "1",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  colStart2: {
    gridColumnStart: "2",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  selfStart: {
    alignSelf: "flex-start",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap5: {
    gap: "calc(4px * 5)",
  },
  minH9: {
    minHeight: "calc(4px * 9)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
});

const stateStyle: Record<RunnerInfo["state"], string> = {
  online: utilityClassName("bg-green-soft text-green"),
  busy: utilityClassName("bg-yellow-soft text-yellow"),
  offline: utilityClassName("bg-hover text-dim"),
  maintenance: utilityClassName("bg-hover text-dim"),
};

function resourceSummary(runner: RunnerInfo): string {
  const values = [
    runner.resources?.cpuCores
      ? `${runner.resources.cpuCores} cores`
      : undefined,
    runner.resources?.memoryGb ? `${runner.resources.memoryGb} GB` : undefined,
    runner.resources?.gpu?.model
      ? `${runner.resources.gpu.model}${runner.resources.gpu.vramGb ? ` · ${runner.resources.gpu.vramGb} GB VRAM` : ""}`
      : undefined,
  ].filter(Boolean);
  return values.join(" · ") || "No resource inventory yet";
}

function pairingCommand(code: string): string {
  return `opensession runner connect --server ${location.origin} --code ${code}`;
}

export function RunnersPanel() {
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [admin, setAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: number;
  } | null>(null);
  const [connectChoice, setConnectChoice] = useState<
    "choices" | "ssh" | "kubernetes" | null
  >(null);
  const [bootstrapTargets, setBootstrapTargets] = useState<{
    ssh: RunnerBootstrapTarget[];
    kubernetes: RunnerBootstrapTarget[];
  }>({ ssh: [], kubernetes: [] });
  const [bootstrapTargetId, setBootstrapTargetId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    await (async () => {
      const data = await fetchRunners();
      setRunners(data.runners);
      setAdmin(data.admin);
    })()
      .catch(async (error) => {
        toast(
          error instanceof Error ? error.message : "Failed to load Runners",
          { variant: "error" },
        );
      })
      .finally(async () => {
        setLoading(false);
      });
  };

  useEffect(() => {
    void load();
  }, []);

  const pair = async () => {
    await (async () => {
      setPairing(await createRunnerPairing());
      setConnectChoice(null);
    })().catch(async (error) => {
      toast(
        error instanceof Error ? error.message : "Could not create pairing",
        { variant: "error" },
      );
    });
  };
  const chooseBootstrap = async (kind: "ssh" | "kubernetes") => {
    await (async () => {
      const targets = await fetchRunnerBootstrapTargets();
      setBootstrapTargets(targets);
      setBootstrapTargetId(targets[kind][0]?.id || "");
      setConnectChoice(kind);
    })().catch(async (error) => {
      toast(
        error instanceof Error
          ? error.message
          : "Could not load Runner connection options",
        { variant: "error" },
      );
    });
  };
  const startBootstrap = async () => {
    if (!connectChoice || connectChoice === "choices" || !bootstrapTargetId)
      return;
    await (async () => {
      const result = await bootstrapRunner(connectChoice, bootstrapTargetId);
      setConnectChoice(null);
      toast(
        `${result.target} is connecting. It appears here when its Runner channel is online.`,
        { variant: "success" },
      );
      void load();
    })().catch(async (error) => {
      toast(
        error instanceof Error
          ? error.message
          : "Could not start Runner migration",
        { variant: "error" },
      );
    });
  };
  const copy = async () => {
    if (!pairing) return;
    await (async () => {
      await navigator.clipboard.writeText(pairingCommand(pairing.code));
      toast("Pairing command copied", { variant: "success" });
    })().catch(async () => {
      toast("Copy the command from this page", { variant: "error" });
    });
  };
  const change = async (
    runner: RunnerInfo,
    patch: Parameters<typeof updateRunner>[1],
  ) => {
    setBusyId(runner.id);
    setBusyId(runner.id);
    const updated = await updateRunner(runner.id, patch)
      .then((next) => {
        setRunners((items) =>
          items.map((item) => (item.id === next.id ? next : item)),
        );
        return true;
      })
      .catch((error: unknown) => {
        toast(
          error instanceof Error ? error.message : "Could not update Runner",
          { variant: "error" },
        );
        return false;
      })
      .finally(() => setBusyId(null));
    return updated;
  };
  const revoke = async (runner: RunnerInfo) => {
    if (
      !confirm(
        `Revoke ${runner.label || runner.name}? It disconnects immediately.`,
      )
    )
      return;
    setBusyId(runner.id);
    await (async () => {
      await revokeRunner(runner.id);
      setRunners((items) => items.filter((item) => item.id !== runner.id));
    })()
      .catch(async (error) => {
        toast(
          error instanceof Error ? error.message : "Could not revoke Runner",
          { variant: "error" },
        );
      })
      .finally(async () => {
        setBusyId(null);
      });
  };

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Runners"
        description="Computers your workspace explicitly trusts for work that needs their hardware or platform. They are not isolated Sandboxes."
        actions={
          admin ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setConnectChoice("choices")}
            >
              Add Runner
            </Button>
          ) : undefined
        }
      />
      {connectChoice === "choices" && (
        <div
          {...stylex.props(sx.mx4, sx.mb4, sx.roundedLg, sx.bgRaised, sx.p4)}
        >
          <div
            {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}
          >
            Connect a Runner
          </div>
          <p
            {...stylex.props(
              sx.mb3,
              sx.mt1,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            Choose the machine path first. Runners are trusted computers, not
            isolated Sandboxes.
          </p>
          <div {...stylex.props(sx.grid, sx.gap2, sx.smGridCols3)}>
            <Button size="sm" onClick={() => void pair()}>
              Connect on this machine
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void chooseBootstrap("ssh")}
            >
              Migrate SSH machine
            </Button>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void chooseBootstrap("kubernetes")}
            >
              Connect Kubernetes GPU
            </Button>
          </div>
          <Button
            className={mergeStylexOverrideClassName("", sx.mt3)}
            size="sm"
            variant="ghost"
            onClick={() => setConnectChoice(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {(connectChoice === "ssh" || connectChoice === "kubernetes") && (
        <div
          {...stylex.props(sx.mx4, sx.mb4, sx.roundedLg, sx.bgRaised, sx.p4)}
        >
          <div
            {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}
          >
            {connectChoice === "ssh"
              ? "Migrate an SSH machine"
              : "Connect a Kubernetes GPU Runner"}
          </div>
          <p
            {...stylex.props(
              sx.mb3,
              sx.mt1,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            Select a preconfigured operator target. The migration installs and
            starts only the Runner service, then the machine connects outbound.
          </p>
          {bootstrapTargets[connectChoice].length ? (
            <>
              <OptionSelect
                label="Operator target"
                value={bootstrapTargetId}
                options={bootstrapTargets[connectChoice].map((target) => ({
                  value: target.id,
                  label: `${target.label} · ${target.host ? `${target.user}@${target.host}:${target.port}` : `${target.context} / ${target.namespace} / ${target.workload}`}`,
                }))}
                onChange={setBootstrapTargetId}
              />
              <div {...stylex.props(sx.mt3, sx.flex, sx.gap2)}>
                <Button size="sm" onClick={() => void startBootstrap()}>
                  Connect
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConnectChoice("choices")}
                >
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <p {...stylex.props(sx.mb0, sx.textDim, typography.supporting)}>
                No configured {connectChoice === "ssh" ? "SSH" : "Kubernetes"}{" "}
                targets are available.
              </p>
              <Button
                className={mergeStylexOverrideClassName("", sx.mt3)}
                size="sm"
                variant="ghost"
                onClick={() => setConnectChoice("choices")}
              >
                Back
              </Button>
            </>
          )}
        </div>
      )}

      {pairing && (
        <div
          {...stylex.props(sx.mx4, sx.mb4, sx.roundedLg, sx.bgRaised, sx.p4)}
        >
          <div
            {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}
          >
            Connect on this machine
          </div>
          <p
            {...stylex.props(
              sx.mb3,
              sx.mt1,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            Run this once on the computer. It detects capabilities and opens a
            reconnecting Runner channel.
          </p>
          <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}>
            <Input
              readOnly
              value={pairingCommand(pairing.code)}
              className={mergeStylexOverrideClassName(
                "",
                sx.minW0,
                sx.flex1,
                sx.fontMono,
                sx.textXs,
              )}
            />
            <Button size="sm" onClick={() => void copy()}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
              Done
            </Button>
          </div>
          <p
            {...stylex.props(
              sx.mb0,
              sx.mt2,
              sx.textFaint,
              typography.supporting,
            )}
          >
            This one-time code expires at{" "}
            {new Date(pairing.expiresAt).toLocaleTimeString()}.
          </p>
          <p
            {...stylex.props(
              sx.mb0,
              sx.mt1,
              sx.textFaint,
              typography.supporting,
            )}
          >
            New machine? Install the command first: install.sh on macOS and
            Linux, install.ps1 on Windows.
          </p>
        </div>
      )}

      <SettingsGroupLabel
        actions={
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        Workspace inventory
      </SettingsGroupLabel>
      {loading ? (
        <SettingCardSkeleton rows={3} icon={40} label="Loading Runners" />
      ) : !runners.length ? (
        <SettingCard>
          <div {...stylex.props(sx.px5, sx.py5)}>
            <div
              {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}
            >
              No Runners connected
            </div>
            <p
              {...stylex.props(
                sx.mb0,
                sx.mt1,
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              Choose a computer, connect it with a pairing command, then choose
              its permissions.
            </p>
          </div>
        </SettingCard>
      ) : (
        <div {...stylex.props(sx.grid, sx.gap3)}>
          {runners.map((runner) => (
            <RunnerRow
              key={runner.id}
              runner={runner}
              admin={admin}
              busy={busyId === runner.id}
              onChange={change}
              onRevoke={revoke}
            />
          ))}
        </div>
      )}
      <SettingsHint>
        SSH and Kubernetes bootstrap remain operator-managed migration paths.
        They never give agents direct SSH or kubectl access.
      </SettingsHint>
    </SettingsPanel>
  );
}

type RunnerChange = (
  runner: RunnerInfo,
  patch: Parameters<typeof updateRunner>[1],
) => Promise<boolean>;

function RunnerIcon() {
  const size = 40;
  return (
    <span
      className={markTileClass(size)}
      style={{
        width: size,
        height: size,
        backgroundImage: markTileGradient("indigo"),
        color: "#fff",
        boxShadow: markTileShadow(markTileInk("indigo")),
      }}
    >
      <IconServer size={22} />
    </span>
  );
}

function RunnerRow({
  runner,
  admin,
  busy,
  onChange,
  onRevoke,
}: {
  runner: RunnerInfo;
  admin: boolean;
  busy: boolean;
  onChange: RunnerChange;
  onRevoke: (runner: RunnerInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Focus the first field rather than letting Base UI land on the ✕, which
  // opens the dialog with its close button ringed.
  const labelRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <SettingCard>
        <div
          {...stylex.props(
            sx.grid,
            sx.gridColsMinmax01fr575rem,
            sx.gapX4,
            sx.px5,
            sx.py4,
            sx.desktopGridColsMinmax01fr13rem,
          )}
        >
          <div
            {...stylex.props(
              sx.colStart1,
              sx.rowStart1,
              sx.flex,
              sx.minW0,
              sx.itemsStart,
              sx.gap3,
            )}
          >
            <RunnerIcon />
            <div {...stylex.props(sx.minW0, sx.flex1)}>
              <div
                {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}
              >
                <span
                  {...stylex.props(
                    sx.fontSemibold,
                    sx.textFg,
                    typography.itemTitle,
                  )}
                >
                  {runner.label || runner.name}
                </span>
                <span
                  className={cn(
                    utilityClassName(
                      "rounded-full px-2 py-0.5 text-meta font-medium capitalize",
                    ),
                    stateStyle[runner.state],
                  )}
                >
                  {runner.state}
                </span>
              </div>
              <div
                {...stylex.props(
                  sx.mt1,
                  sx.leadingRelaxed,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                {runner.platform} · {runner.arch} · {resourceSummary(runner)}
              </div>
              {runner.workload && (
                <div
                  {...stylex.props(sx.mt2, sx.textDim, typography.supporting)}
                >
                  Working:{" "}
                  {runner.workload.operation ||
                    runner.workload.sessionId ||
                    "session work"}
                </div>
              )}
              <div
                {...stylex.props(
                  sx.mt2,
                  sx.grid,
                  sx.gap05,
                  sx.textFaint,
                  typography.meta,
                )}
              >
                {runner.capabilities.toolchains.length > 0 && (
                  <div>{runner.capabilities.toolchains.join(" · ")}</div>
                )}
                {runner.resources?.localInference?.length ? (
                  <div>
                    Local inference:{" "}
                    {runner.resources.localInference
                      .map(
                        (runtime) =>
                          `${runtime.runtime}${runtime.models.length ? ` (${runtime.models.join(", ")})` : ""}`,
                      )
                      .join(" · ")}
                  </div>
                ) : null}
                {runner.migration?.kind === "kubernetes" && (
                  <div>
                    Kubernetes · {runner.migration.context} /{" "}
                    {runner.migration.namespace} / {runner.migration.workload}
                  </div>
                )}
              </div>
            </div>
          </div>
          {admin && (
            <div
              {...stylex.props(
                sx.colStart2,
                sx.rowStart1,
                sx.flex,
                sx.justifyEnd,
                sx.selfStart,
              )}
            >
              <Button size="sm" onClick={() => setEditing(true)}>
                Configure
              </Button>
            </div>
          )}
        </div>
      </SettingCard>
      {admin && (
        <Modal.Root open={editing} onOpenChange={setEditing}>
          {/* The form is a child so Base UI's portal remounts it on every open,
			    which re-reads the current runner instead of showing edits staged
			    against a Runner that has since reported new state. */}
          <Modal.Content initialFocus={labelRef}>
            <RunnerDetails
              runner={runner}
              busy={busy}
              labelRef={labelRef}
              onChange={onChange}
              onRevoke={onRevoke}
              onSaved={() => setEditing(false)}
            />
          </Modal.Content>
        </Modal.Root>
      )}
    </>
  );
}

function RunnerDetails({
  runner,
  busy,
  labelRef,
  onChange,
  onRevoke,
  onSaved,
}: {
  runner: RunnerInfo;
  busy: boolean;
  labelRef: RefObject<HTMLInputElement | null>;
  onChange: RunnerChange;
  onRevoke: (runner: RunnerInfo) => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(runner.label || "");
  const [tags, setTags] = useState(runner.capabilities.tags.join(", "));
  const [users, setUsers] = useState(runner.allowedUsers.join(", "));
  const [repos, setRepos] = useState(runner.allowedRepos.join(", "));
  const [maintenance, setMaintenance] = useState(Boolean(runner.maintenance));
  const [commands, setCommands] = useState(runner.permissions.commands);
  const [inferenceModels, setInferenceModels] = useState(
    runner.localInferencePolicy?.allowedModels.join(", ") || "",
  );
  const [inferenceEnabled, setInferenceEnabled] = useState(
    Boolean(runner.localInferencePolicy?.enabled),
  );
  const inference = Boolean(runner.resources?.localInference?.length);
  // Every field commits on Save, the switches included: a dialog with its own
  // Save button that also applies two of its controls the moment they move
  // leaves Cancel meaning different things in one form.
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await onChange(runner, {
      label: label.trim() || undefined,
      capabilities: { tags: list(tags) },
      allowedUsers: list(users),
      allowedRepos: list(repos),
      maintenance,
      permissions: { commands },
      ...(inference
        ? {
            localInferencePolicy: {
              enabled: inferenceEnabled,
              allowedUsers: list(users),
              allowedModels: list(inferenceModels),
              allowedTasks: ["chat", "embedding", "image", "video"],
            },
          }
        : {}),
    });
    if (saved) onSaved();
  };
  return (
    <>
      <Modal.Header
        title={runner.label || runner.name}
        description={
          <>
            <span
              className={utilityClassName(
                `capitalize ${stateStyle[runner.state]}`,
              )}
            >
              {runner.state}
            </span>{" "}
            · {runner.platform} · {runner.arch} · {resourceSummary(runner)}
          </>
        }
      />
      {/* Every field here is a comma-separated LIST, and a list clips in a
		    half-dialog column (the same reason SetupTeam runs its email and
		    alias full width). So none of them pair up, and the dialog keeps the
		    standard width rather than widening to fit a grid. */}
      {/* Below the title every line in this dialog is 13px, so hierarchy can
		    only come from grouping. The three zones are what the fields
		    actually are: what the Runner is called, who may use it, and what
		    it is doing. 20px between them against 12px inside. */}
      <form
        {...stylex.props(sx.flex, sx.flexCol, sx.gap5)}
        onSubmit={(event) => void save(event)}
      >
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}>
          <Field label="Label">
            <Input
              ref={labelRef}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={runner.name}
              spellCheck={false}
            />
          </Field>
          <Field label="Tags" title="Comma-separated.">
            <Input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="No tags"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap3)}>
          <Field
            label="Allowed people"
            title="Comma-separated. Blank means every workspace member."
          >
            <Input
              value={users}
              onChange={(event) => setUsers(event.target.value)}
              placeholder="All workspace members"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            label="Allowed repositories"
            title="Comma-separated. Blank means every repository."
          >
            <Input
              value={repos}
              onChange={(event) => setRepos(event.target.value)}
              placeholder="All repositories"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          {inference ? (
            <Field label="Allowed local models" title="Comma-separated.">
              <Input
                value={inferenceModels}
                onChange={(event) => setInferenceModels(event.target.value)}
                placeholder="Model names"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          ) : null}
        </div>
        {/* Label left, control right: the shape every toggle in settings
			    already has, so two of them read as a list rather than as pairs
			    floating in a row. */}
        <div {...stylex.props(sx.flex, sx.flexCol)}>
          <SwitchRow
            label="Maintenance"
            checked={maintenance}
            onChange={setMaintenance}
            disabled={busy}
          />
          <SwitchRow
            label="Commands"
            checked={commands}
            onChange={setCommands}
            disabled={busy}
          />
          {inference ? (
            <SwitchRow
              label="Local inference"
              checked={inferenceEnabled}
              onChange={setInferenceEnabled}
              disabled={busy}
            />
          ) : null}
        </div>
        <Modal.Footer>
          <Button
            variant="danger"
            onClick={() => onRevoke(runner)}
            disabled={busy}
          >
            Revoke
          </Button>
          <span {...stylex.props(sx.flex1)} />
          <Modal.Close
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button variant="primary" type="submit" disabled={busy}>
            Save
          </Button>
        </Modal.Footer>
      </form>
    </>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  // `text-dim`, matching Field's label: both name a control, so both are
  // chrome. Two label colours at one size in one dialog reads as arbitrary,
  // and it is the values (the typed text, the lit switch) that should carry.
  return (
    <label
      {...stylex.props(
        sx.flex,
        sx.minH9,
        sx.itemsCenter,
        sx.justifyBetween,
        sx.gap4,
        sx.fontMedium,
        sx.textDim,
        typography.label,
      )}
    >
      {label}
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </label>
  );
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
