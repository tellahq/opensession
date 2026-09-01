import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React from "react";
import type { TeamMember } from "../TeamPresence";
import { TeamLensMenu } from "../TeamPresence";
import { IconEyeOff } from "../icons";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL_GAP,
} from "../../lib/sidebar-classes";
import type { SidebarToolId } from "../../lib/sidebar-tools";
import type { SupportSurface } from "../../lib/support-surface";
import { cn } from "../../ui/cn";
import { ContextMenu, MENU_ICON } from "../../ui/menu";
import { SidebarToolRows, type SidebarMenuTool } from "./SidebarToolsMenu";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  mlAuto: {
    marginLeft: "auto",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  px7px: {
    paddingInline: "7px",
  },
  pyPx: {
    paddingBlock: "1px",
  },
  leading15: {
    lineHeight: "1.5",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  relative: {
    position: "relative",
  },
  absolute: {
    position: "absolute",
  },
  right2: {
    right: "calc(4px * 2)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  phonePy25: {
    "@media (max-width: 720px)": {
      paddingBlock: "calc(4px * 2.5)",
    },
  },
});

export interface SidebarToolsNavItem {
  id: SidebarToolId;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
  count?: number;
}

export function SidebarToolsNav({
  connected,
  isPhone,
  tools,
  menuTools,
  team,
  personLensValue,
  personLensName,
  onOpenSettings,
  onSetToolVisible,
  onSetSupportSurface,
  onPickPerson,
}: {
  connected: boolean;
  isPhone: boolean;
  tools: SidebarToolsNavItem[];
  menuTools: SidebarMenuTool[];
  team: TeamMember[];
  personLensValue: string;
  personLensName: string;
  onOpenSettings: () => void;
  onSetToolVisible: (id: SidebarToolId, shown: boolean) => void;
  onSetSupportSurface: (surface: SupportSurface) => void;
  onPickPerson: (person: string) => void;
}) {
  return (
    <nav
      className={cn(
        // `--sidebar-nav-x` is the sidebar's own (SIDEBAR_NAV_X); the strip
        // reads it rather than setting one, so the tools sit on the same
        // edges as the lists under them.
        //
        // One vertical list at every width. Phones used to get a
        // horizontally-scrolling line of Slack-home style tap cards, which
        // put the tools in a different language from everything under
        // them: the sidebar is a column of rows, and the cards were a
        // sideways shelf that kept its own tail off the right edge. A list
        // reads the same on both clients, shows every tool at once without
        // a gesture, and takes a quarter of the height per tool.
        //
        // The organization row leads this rail on desktop now that the old
        // heading is gone. Pull it slightly closer to the fixed top bar there;
        // phones keep the original spacing because their first row is a tool.
        utilityClassName(
          "flex flex-col gap-0.5 px-[var(--sidebar-nav-x)] pt-2 pb-1.5 desktop:pt-0.5",
        ),
      )}
    >
      <div {...stylex.props(sx.phoneHidden)}>
        <OrganizationSwitcher
          connected={connected}
          onOpenSettings={onOpenSettings}
        />
      </div>
      {tools.map((tool) => {
        const rowClass = cn(
          // One look at both widths. Only the box changes, and only
          // because a phone row is pressed rather than read.
          utilityClassName(
            "group flex items-center text-left transition-colors",
          ),
          // Rows use control-label type, with glyphs matching the
          // sidebar's standard 22px leading rail.
          // `--sidebar-tool-pad` is 5px for a 32px box: the tools are a
          // short utility strip above the work lists, and at the session
          // rows' 36px the four of them took more of the rail than what
          // they lead to. The glyph and the label's left rail are
          // untouched, so they still line up with the rows below; only
          // the air around them is tighter.
          // Don't take it below 30. At 28 (`py-[3px]`, the pre-ffd11ffc
          // value) the 22px glyph has 3px of margin and the hover pill
          // stops reading as a row; the compact density's 4px stops at
          // 30, level with the rows under it rather than below them.
          // Phones override it to the 13px the session rows take
          // (SIDEBAR_ROW, lib/sidebar-classes.ts) for a 48px box: 32px is
          // a reading height, not a tap target.
          utilityClassName(
            `w-full ${SIDEBAR_RAIL_GAP} rounded-row bg-transparent px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] py-[var(--sidebar-tool-pad)] phone:py-[13px] text-body font-medium text-dim desktop:text-item-title hover:text-fg`,
          ),
          SIDEBAR_HOVER_LAYER,
          tool.active && utilityClassName("bg-selected text-fg"),
        );
        const rowBody = (
          <>
            <span
              className={cn(
                utilityClassName("inline-flex text-faint [&_svg]:size-[22px]"),
                tool.active
                  ? utilityClassName("text-dim")
                  : "group-hover:text-dim",
              )}
            >
              {tool.icon}
            </span>
            {tool.label}
            {!!tool.count && (
              // `rounded-full`, not `rounded-[999px]`: this pill never
              // carried a corner-shape, and rounded-full is the one
              // radius spelling base.css does NOT squircle.
              <span
                {...stylex.props(
                  sx.mlAuto,
                  sx.roundedFull,
                  sx.bgAccent,
                  sx.px7px,
                  sx.pyPx,
                  sx.leading15,
                  sx.fontSemibold,
                  sx.textOnAccent,
                  typography.meta,
                )}
              >
                {tool.count}
              </span>
            )}
          </>
        );
        // Right-click drops this tool from the strip, the same gesture
        // the feed headers use to hide themselves, and opens the chooser
        // that puts any of them back. Desktop only: phones have no
        // right-click, and the chooser is itself desktop-only, so a
        // stray long-press there would only be recoverable from
        // Settings.
        const row = isPhone ? (
          <button
            key={tool.id}
            className={rowClass}
            onClick={() => tool.onClick()}
            title={tool.title}
          >
            {rowBody}
          </button>
        ) : (
          <ContextMenu.Root key={tool.id}>
            <ContextMenu.Trigger
              render={
                <button
                  className={rowClass}
                  onClick={() => tool.onClick()}
                  title={tool.title}
                />
              }
            >
              {rowBody}
            </ContextMenu.Trigger>
            {/* This menu is now the only place that chooses which tools
                show, since the band heading that held the menu is gone.
                "Remove from toolbar" leads, about the row you opened the
                menu on: the list under it can do the same thing by
                unticking that row, but the command names the tool you
                already aimed at, which is the common case and the one
                worth a click rather than a read. "Hide tools from sidebar"
                used to close the menu, and it went: it was the same decision
                as unticking every row, a step further than anyone reaches
                for by accident. */}
            <ContextMenu.Popup>
              <ContextMenu.Item
                onClick={() => onSetToolVisible(tool.id, false)}
              >
                <IconEyeOff size={20} className={MENU_ICON} />
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                  Remove from toolbar
                </span>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Group>
                <ContextMenu.GroupLabel>Show in toolbar</ContextMenu.GroupLabel>
                {/* The same SidebarToolRows the sidebar's own right-click
                    menu lists, so the two menus cannot drift: each wears the
                    mark it wears in the sidebar, the tick sits at the trailing
                    edge, and Support stays a submenu of surfaces rather than a
                    tick. */}
                <SidebarToolRows
                  tools={menuTools}
                  onToggleTool={onSetToolVisible}
                  onSetSupport={onSetSupportSurface}
                />
              </ContextMenu.Group>
            </ContextMenu.Popup>
          </ContextMenu.Root>
        );
        // Feed carries the team at its right edge, with every face shown
        // neutrally, and lets you pick up someone's sidebar without
        // leaving the row you're on. The pile opens the same lens menu
        // the Feed page's own chips write, so the row is both a way in
        // and the shortcut past it. It has to be a sibling of the row,
        // not a child: a button can't nest one. Phones carry it too,
        // now that the tools are rows there rather than cards: the row
        // has the width for a pile at its right edge, and the pile is
        // its own target laid over it rather than a hover reveal, so a
        // tap on a face opens the lens and a tap anywhere else opens
        // Feed.
        if (tool.id !== "feed" || team.length === 0) return row;
        return (
          <div
            key={tool.id}
            {...mergeStylexProps("group/team-lens", sx.relative)}
          >
            {row}
            <TeamLensMenu
              members={team}
              size={20}
              max={4}
              // The ring is opaque so the face behind cannot bleed into
              // the gap. Match whichever sidebar surface the trigger is
              // currently painted on.
              ring="var(--team-face-ring)"
              compact
              side="right"
              align="start"
              value={personLensValue}
              label={personLensName}
              onPick={onPickPerson}
              // Phones pad the trigger out to the row's own height so
              // the faces are a thumb-sized target rather than a 24px
              // one. It stays a pill either way, so the padding is only
              // reach: nothing about it reads larger at rest.
              className={mergeStylexOverrideClassName(
                "[--team-face-ring:var(--sidebar-bg)] group-hover/team-lens:[--team-face-ring:var(--row-chip)] data-[popup-open]:[--team-face-ring:var(--row-chip)]",
                sx.absolute,
                sx.right2,
                sx.top12,
                sx.TranslateY12,
                sx.phonePy25,
              )}
            />
          </div>
        );
      })}
    </nav>
  );
}
