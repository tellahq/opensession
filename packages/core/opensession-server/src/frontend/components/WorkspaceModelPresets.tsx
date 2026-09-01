import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useState } from "react";
import type { Workspace } from "../lib/types";
import { randomUUID } from "../lib/random-uuid";
import {
  defaultWorkspaceModelSettings,
  fetchModels,
  updateWorkspaceApi,
  type ModelOption,
} from "../lib/api";
import { Button } from "../ui/button";
import { CardList } from "../ui/card";
import { cn } from "../ui/cn";
import { Modal } from "../ui/modal";
import { Select } from "../ui/select";
import { InlineAlert } from "../ui/state";
import {
  SettingCard,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsField,
  SettingsGroupLabel,
  rowMenuTriggerClasses,
  settingsInputClass,
  settingsTextareaClass,
} from "../ui/settings";
import { EFFORTS, shortModelLabel } from "./ModelEffortSelect";
import { IconChevronDown, IconPlus, IconTrash } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  textLeft: {
    textAlign: "left",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  block: {
    display: "block",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  flexCol: {
    flexDirection: "column",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  mb0: {
    marginBottom: "0",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsEnd: {
    alignItems: "flex-end",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  minW13rem: {
    minWidth: "13rem",
  },
  w32: {
    width: "calc(4px * 32)",
  },
  grid: {
    display: "grid",
  },
  gridColsMinmax01frAuto: {
    gridTemplateColumns: "minmax(0,1fr) auto",
  },
  desktopGridColsMinmax01fr10rem8remAuto: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "minmax(0,1fr) 10rem 8rem auto",
    },
  },
  colStart1: {
    gridColumnStart: "1",
  },
  rowStart1: {
    gridRowStart: "1",
  },
  colSpan2: {
    gridColumn: "span 2 / span 2",
  },
  desktopColSpan1: {
    "@media (min-width: 721px)": {
      gridColumn: "span 1 / span 1",
    },
  },
  desktopColStart3: {
    "@media (min-width: 721px)": {
      gridColumnStart: "3",
    },
  },
  desktopRowStart1: {
    "@media (min-width: 721px)": {
      gridRowStart: "1",
    },
  },
  wFit: {
    width: "fit-content",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  textRed: {
    color: "var(--red)",
  },
  hoverBgRedSoft: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--red-soft)",
      },
    },
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py6: {
    paddingBlock: "calc(4px * 6)",
  },
  textCenter: {
    textAlign: "center",
  },
});

type Settings = NonNullable<Workspace["modelSettings"]>;
type Preset = NonNullable<Settings["presets"]>[number];
type Supporting = NonNullable<Preset["supporting"]>[number];

const blankPreset = (): Preset => ({
  id: randomUUID().slice(0, 8),
  label: "New preset",
  instructions: "",
  lead: { model: "", effort: "high" },
  supporting: [],
});

/** The dialog's one select shape: a full-width field over the app's popup.
 *  Its four fields differ only in the list they offer. */
function ModelSelect({
  items,
  value,
  label,
  onChange,
  className,
}: {
  items: { value: string; label: string }[];
  value: string;
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select.Root
      items={items}
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      <Select.Trigger aria-label={label} className={className} />
      <Select.Popup>
        {items.map((item) => (
          <Select.Item key={item.value} value={item.value}>
            {item.label}
          </Select.Item>
        ))}
      </Select.Popup>
    </Select.Root>
  );
}

/**
 * One preset in the list: a row you can read at a glance, and its editor
 * underneath once you open it. Seven presets ship by default, so showing every
 * field at once turned this dialog into a wall of inputs with no way to see
 * what a preset actually is.
 */
function PresetRow({
  preset,
  models,
  open,
  onToggle,
  onPatch,
  onRemove,
}: {
  preset: Preset;
  models: ModelOption[];
  open: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Preset>) => void;
  onRemove: () => void;
}) {
  const supporting = preset.supporting || [];
  const effortsFor = (model: string) => {
    const supported =
      models.find((option) => option.id === model)?.efforts || [];
    return EFFORTS.filter((effort) => supported.includes(effort.id));
  };
  const leadEfforts = effortsFor(preset.lead.model);
  // The catalog's own label, so a row reads the same as the select under it.
  // shortModelLabel is the fallback for a model the catalog no longer lists.
  const labelFor = (model: string) =>
    models.find((option) => option.id === model)?.label ||
    shortModelLabel(model, models);
  const patchSupporting = (index: number, patch: Partial<Supporting>) =>
    onPatch({
      supporting: supporting.map((member, i) =>
        i === index ? { ...member, ...patch } : member,
      ),
    });
  // "" is a real choice ("not set yet"), so it stays an item in the list
  // rather than becoming the trigger's placeholder.
  const modelItems = (prompt: string) => [
    { value: "", label: prompt },
    ...models.map((model) => ({ value: model.id, label: model.label })),
  ];
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        {...stylex.props(
          sx.flex,
          sx.wFull,
          sx.itemsCenter,
          sx.gap3,
          sx.px5,
          sx.py3,
          sx.textLeft,
          sx.transitionColors,
          sx.hoverBgHover,
        )}
      >
        <span {...stylex.props(sx.minW0, sx.flex1)}>
          <span
            {...stylex.props(
              sx.block,
              sx.truncate,
              sx.fontMedium,
              sx.textFg,
              typography.itemTitle,
            )}
          >
            {preset.label.trim() || "Untitled preset"}
          </span>
          <span
            {...stylex.props(
              sx.mt05,
              sx.block,
              sx.truncate,
              sx.textDim,
              typography.supporting,
            )}
          >
            {preset.lead.model
              ? [
                  labelFor(preset.lead.model),
                  supporting.length === 1
                    ? "1 supporting model"
                    : supporting.length
                      ? `${supporting.length} supporting models`
                      : "no supporting models",
                ].join(" · ")
              : "No lead model yet"}
          </span>
        </span>
        <IconChevronDown
          size={18}
          className={cn(
            utilityClassName("shrink-0 text-faint transition-transform"),
            open && utilityClassName("rotate-180"),
          )}
        />
      </button>
      {open && (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap3, sx.px5, sx.pb4)}>
          <SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
            Name
            <input
              className={settingsInputClass}
              value={preset.label}
              onChange={(event) => onPatch({ label: event.target.value })}
              placeholder="Preset name"
            />
          </SettingsField>
          <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsEnd, sx.gap2)}>
            <SettingsField
              className={mergeStylexOverrideClassName(
                "",
                sx.mb0,
                sx.minW13rem,
                sx.flex1,
              )}
            >
              Lead model
              <ModelSelect
                items={modelItems("Choose a lead model")}
                value={preset.lead.model}
                label="Lead model"
                onChange={(model) =>
                  onPatch({ lead: { ...preset.lead, model } })
                }
              />
            </SettingsField>
            {leadEfforts.length > 0 && (
              <SettingsField
                className={mergeStylexOverrideClassName("", sx.mb0, sx.w32)}
              >
                Effort
                <ModelSelect
                  items={leadEfforts.map((effort) => ({
                    value: effort.id,
                    label: effort.label,
                  }))}
                  value={preset.lead.effort || ""}
                  label="Effort"
                  onChange={(effort) =>
                    onPatch({ lead: { ...preset.lead, effort } })
                  }
                />
              </SettingsField>
            )}
          </div>
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
            <span
              {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}
            >
              Supporting models
            </span>
            {supporting.map((member, index) => {
              const memberEfforts = effortsFor(member.model);
              return (
                // Four controls in one line only where they fit. A phone gets the
                // model and its remove button on the first line, then role and
                // effort under them, instead of four fields fighting over 200px.
                <div
                  key={index}
                  {...stylex.props(
                    sx.grid,
                    sx.gridColsMinmax01frAuto,
                    sx.itemsCenter,
                    sx.gap2,
                    sx.desktopGridColsMinmax01fr10rem8remAuto,
                  )}
                >
                  <ModelSelect
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.colStart1,
                      sx.rowStart1,
                    )}
                    items={modelItems("Choose a supporting model")}
                    value={member.model}
                    label="Supporting model"
                    onChange={(model) => patchSupporting(index, { model })}
                  />
                  <button
                    type="button"
                    className={cn(
                      rowMenuTriggerClasses,
                      utilityClassName(
                        "col-start-2 row-start-1 desktop:col-start-4",
                      ),
                    )}
                    aria-label="Remove supporting model"
                    onClick={() =>
                      onPatch({
                        supporting: supporting.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <IconTrash size={16} />
                  </button>
                  <input
                    className={cn(
                      settingsInputClass,
                      utilityClassName(
                        "col-span-2 desktop:col-span-1 desktop:col-start-2 desktop:row-start-1",
                      ),
                    )}
                    value={member.role || ""}
                    aria-label="What this model does"
                    placeholder="Role"
                    onChange={(event) =>
                      patchSupporting(index, { role: event.target.value })
                    }
                  />
                  {memberEfforts.length > 0 && (
                    <ModelSelect
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.colSpan2,
                        sx.desktopColSpan1,
                        sx.desktopColStart3,
                        sx.desktopRowStart1,
                      )}
                      items={memberEfforts.map((effort) => ({
                        value: effort.id,
                        label: effort.label,
                      }))}
                      value={member.effort || ""}
                      label="Supporting model effort"
                      onChange={(effort) => patchSupporting(index, { effort })}
                    />
                  )}
                </div>
              );
            })}
            <Button
              size="sm"
              icon={<IconPlus size={16} />}
              className={mergeStylexOverrideClassName("", sx.wFit)}
              onClick={() =>
                onPatch({ supporting: [...supporting, { model: "" }] })
              }
            >
              Add supporting model
            </Button>
          </div>
          <SettingsField className={mergeStylexOverrideClassName("", sx.mb0)}>
            Instructions
            <textarea
              className={cn(
                settingsTextareaClass,
                utilityClassName("min-h-18"),
              )}
              value={preset.instructions || ""}
              onChange={(event) =>
                onPatch({ instructions: event.target.value })
              }
              placeholder="When to use supporting models and how to integrate their work."
            />
          </SettingsField>
          <div {...stylex.props(sx.flex, sx.justifyEnd)}>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconTrash size={16} />}
              className={mergeStylexOverrideClassName(
                "",
                sx.textRed,
                sx.hoverBgRedSoft,
                sx.hoverTextRed,
              )}
              onClick={onRemove}
            >
              Remove preset
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkspaceModelPresets({
  workspace,
  open,
  onOpenChange,
  onSaved,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<Settings>(
    workspace.modelSettings || defaultWorkspaceModelSettings() || {},
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [openPreset, setOpenPreset] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      setSettings(
        workspace.modelSettings || defaultWorkspaceModelSettings() || {},
      ),
    [workspace],
  );
  useEffect(() => {
    if (!open) return;
    fetchModels(workspace.id)
      .then((catalog) =>
        setModels(
          catalog.models.filter(
            (model) => !model.id.startsWith("workspace-preset/"),
          ),
        ),
      )
      .catch(() => setModels([]));
  }, [open, workspace.id]);
  const presets = settings.presets || [];
  const patchPreset = (index: number, patch: Partial<Preset>) =>
    setSettings((current) => ({
      ...current,
      presets: (current.presets || []).map((preset, i) =>
        i === index ? { ...preset, ...patch } : preset,
      ),
    }));
  const addPreset = () => {
    const preset = blankPreset();
    setSettings((current) => ({
      ...current,
      presets: [...(current.presets || []), preset],
    }));
    setOpenPreset(preset.id);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    await (async () => {
      const clean = {
        ...settings,
        presets: presets
          .map((preset) => ({
            ...preset,
            id: preset.id.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64),
            label: preset.label.trim(),
            instructions: preset.instructions?.trim() || undefined,
            lead: { ...preset.lead, model: preset.lead.model.trim() },
            supporting: (preset.supporting || []).filter((member) =>
              member.model.trim(),
            ),
          }))
          .filter((preset) => preset.id && preset.label && preset.lead.model),
      };
      await updateWorkspaceApi(workspace.id, { modelSettings: clean });
      onSaved();
      onOpenChange(false);
    })()
      .catch(async (e) => {
        setError(
          e instanceof Error ? e.message : "Could not save model presets.",
        );
      })
      .finally(async () => {
        setSaving(false);
      });
  };
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName={utilityClassName("max-w-[42rem]")}>
        <Modal.Header
          title="Model presets"
          description="A lead model, the supporting models it can delegate to, and how to use them. Sessions in this workspace pick one from the model menu."
        />
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
          {presets.length > 0 ? (
            <CardList>
              {presets.map((preset, index) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  models={models}
                  open={openPreset === preset.id}
                  onToggle={() =>
                    setOpenPreset((current) =>
                      current === preset.id ? null : preset.id,
                    )
                  }
                  onPatch={(patch) => patchPreset(index, patch)}
                  onRemove={() =>
                    setSettings((current) => ({
                      ...current,
                      presets: (current.presets || []).filter(
                        (_, i) => i !== index,
                      ),
                    }))
                  }
                />
              ))}
            </CardList>
          ) : (
            <div
              {...stylex.props(
                sx.roundedXl,
                sx.bgPanel,
                sx.px4,
                sx.py6,
                sx.textCenter,
                sx.textDim,
                typography.supporting,
              )}
            >
              No presets yet.
            </div>
          )}
          <Button
            icon={<IconPlus size={16} />}
            className={mergeStylexOverrideClassName("", sx.wFit)}
            onClick={addPreset}
          >
            Add preset
          </Button>
        </div>
        {error && <InlineAlert>{error}</InlineAlert>}
        <Modal.Footer>
          <Modal.Close render={<Button variant="ghost">Cancel</Button>} />
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

/** Workspace-specific entry inside Settings → Providers. */
export function WorkspaceModelPresetSettings({
  workspace,
}: {
  workspace?: Workspace;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsGroupLabel>This workspace</SettingsGroupLabel>
      <SettingCard>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Model presets</SettingRowTitle>
            <SettingRowDescription>
              {workspace
                ? "Lead and supporting models that sessions here can pick."
                : "Open a workspace to set up its model presets."}
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Button disabled={!workspace} onClick={() => setOpen(true)}>
              Configure
            </Button>
          </SettingRowControl>
        </SettingRow>
      </SettingCard>
      {workspace && (
        <WorkspaceModelPresets
          workspace={workspace}
          open={open}
          onOpenChange={setOpen}
          onSaved={() =>
            window.dispatchEvent(new Event("opensession:workspaces-changed"))
          }
        />
      )}
    </>
  );
}
