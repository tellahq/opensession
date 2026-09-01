import type {
  CodeDisplaySettingsState,
  CodeOrganizationSettingsState,
} from "../hooks/useCodeDisplaySettings";
import { Menu } from "../ui/menu";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingRow, SwitchRow, ValueRow } from "../ui/setting-row";
import { IconArrowDown, IconArrowUp } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap3: {
    gap: "12px",
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
});

export function DiffSourceSetting({
  value,
  onValueChange,
}: {
  value: "pull-request" | "worktree";
  onValueChange: (next: "pull-request" | "worktree") => void;
}) {
  return (
    <SettingRow label="Source">
      <Segmented
        label="Diff source"
        size="sm"
        value={value}
        onValueChange={(next) =>
          onValueChange(next as "pull-request" | "worktree")
        }
      >
        <SegmentedOption value="pull-request">Pull request</SegmentedOption>
        <SegmentedOption value="worktree">Worktree</SegmentedOption>
      </Segmented>
    </SettingRow>
  );
}

/** File navigation and ordering shared by pull request and worktree diffs. */
export function CodeOrganizationSettings({
  settings,
  reviewedFilesAvailable,
  defaultOrderLabel,
  showFileListSetting = true,
}: {
  settings: CodeOrganizationSettingsState;
  reviewedFilesAvailable: boolean;
  defaultOrderLabel: string;
  showFileListSetting?: boolean;
}) {
  const {
    grouping,
    changeGrouping,
    fileListMode,
    changeFileListMode,
    fileOrder,
    changeFileOrder,
    sortDirection,
    changeSortDirection,
    hideReviewed,
    changeHideReviewed,
  } = settings;

  return (
    <>
      {showFileListSetting && (
        <SettingRow label="File list">
          <Segmented
            label="File list"
            size="sm"
            value={fileListMode}
            onValueChange={(next) =>
              changeFileListMode(next as "flat" | "tree" | "hidden")
            }
          >
            <SegmentedOption value="flat">Flat</SegmentedOption>
            <SegmentedOption value="tree">Tree</SegmentedOption>
            <SegmentedOption value="hidden">Hidden</SegmentedOption>
          </Segmented>
        </SettingRow>
      )}
      <SwitchRow
        label="Hide reviewed"
        checked={hideReviewed && reviewedFilesAvailable}
        disabled={!reviewedFilesAvailable}
        onCheckedChange={changeHideReviewed}
      />
      <ValueRow
        label="Group by"
        value={grouping}
        options={[
          { value: "none", label: "No grouping" },
          { value: "ai", label: "Purpose" },
        ]}
        onSelect={(next) => changeGrouping(next as "none" | "ai")}
      />
      <ValueRow
        label="Sort by"
        value={fileOrder}
        options={[
          { value: "path", label: "Path" },
          { value: "changes", label: "Changed lines" },
          { value: "pull-request", label: defaultOrderLabel },
        ]}
        onSelect={(next) =>
          changeFileOrder(next as "path" | "changes" | "pull-request")
        }
        trailing={
          sortDirection === "asc" ? (
            <IconArrowUp
              size={15}
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textDim,
              )}
            />
          ) : (
            <IconArrowDown
              size={15}
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textDim,
              )}
            />
          )
        }
        footer={
          <Menu.RadioGroup
            value={sortDirection}
            onValueChange={(next) =>
              changeSortDirection(String(next) as "asc" | "desc")
            }
          >
            {(
              [
                ["asc", "Ascending"],
                ["desc", "Descending"],
              ] as const
            ).map(([value, label]) => (
              <Menu.RadioItem
                key={value}
                value={value}
                closeOnClick
                className={mergeStylexOverrideClassName(
                  "",
                  sx.justifyBetween,
                  sx.gap3,
                )}
              >
                <span {...stylex.props(sx.minW0, sx.truncate)}>{label}</span>
                <Menu.Check on={sortDirection === value} />
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        }
      />
    </>
  );
}

/** The diff-rendering section shared by Review and sidebar Changes. */
export function CodeDisplaySettings({
  diffStyle,
  changeDiffStyle,
  wrapLines,
  changeWrapLines,
  structuralHighlighting,
  changeStructuralHighlighting,
  showFileStats,
  changeShowFileStats,
  codeTheme,
  changeCodeTheme,
}: CodeDisplaySettingsState) {
  return (
    <>
      <SettingRow label="Layout">
        <Segmented
          label="Diff layout"
          size="sm"
          value={diffStyle}
          onValueChange={(next) => changeDiffStyle(next as "unified" | "split")}
        >
          <SegmentedOption value="split">Split</SegmentedOption>
          <SegmentedOption value="unified">Unified</SegmentedOption>
        </Segmented>
      </SettingRow>
      <SwitchRow
        label="Wrap lines"
        checked={wrapLines}
        onCheckedChange={changeWrapLines}
      />
      <SwitchRow
        label="Highlight edits"
        checked={structuralHighlighting}
        onCheckedChange={changeStructuralHighlighting}
      />
      <SwitchRow
        label="Line counts"
        checked={showFileStats}
        onCheckedChange={changeShowFileStats}
      />
      <SettingRow label="Theme">
        <Segmented
          label="Code theme"
          size="sm"
          value={codeTheme}
          onValueChange={(next) =>
            changeCodeTheme(next as "system" | "light" | "dark")
          }
        >
          <SegmentedOption value="system">Match app</SegmentedOption>
          <SegmentedOption value="light">Light</SegmentedOption>
          <SegmentedOption value="dark">Dark</SegmentedOption>
        </Segmented>
      </SettingRow>
    </>
  );
}
