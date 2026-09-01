import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { Reorder } from "motion/react";
import { useIsPhone } from "../../hooks/useIsPhone";
import type { SidebarToolId } from "../../lib/sidebar-tools";
import { Modal } from "../../ui/modal";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { IconGripVertical, IconX } from "../icons";
import { RepoTile, repoLabel } from "../RepoTile";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  Mx2: {
    marginInline: "calc(4px * -2)",
  },
  m0: {
    margin: "0",
  },
  mb15: {
    marginBottom: "calc(4px * 1.5)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  phoneBgSettingsPlate: {
    "@media (max-width: 720px)": {
      backgroundColor: "var(--settings-plate)",
    },
  },
  p05: {
    padding: "calc(4px * 0.5)",
  },
  flex: {
    display: "flex",
  },
  minH9: {
    minHeight: "calc(4px * 9)",
  },
  cursorGrab: {
    cursor: "grab",
  },
  selectNone: {
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textFg: {
    color: "var(--text)",
  },
  activeCursorGrabbing: {
    ":active": {
      cursor: "grabbing",
    },
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  size5: {
    width: "calc(4px * 5)",
    height: "calc(4px * 5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  textDim: {
    color: "var(--text-dim)",
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
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  phoneAfterAbsolute: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        position: "absolute",
      },
    },
  },
  phoneAfterInsetX0: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        insetInline: "0",
      },
    },
  },
  phoneAfterInsetY3: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        insetBlock: "calc(4px * -3)",
      },
    },
  },
  phoneAfterContent: {
    "@media (max-width: 720px)": {
      "::after": {
        content: "''",
      },
    },
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  pt05: {
    paddingTop: "calc(4px * 0.5)",
  },
  leadingTight: {
    lineHeight: "var(--leading-tight)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap5: {
    gap: "calc(4px * 5)",
  },
  pb6: {
    paddingBottom: "calc(4px * 6)",
  },
  maxH80dvh: {
    maxHeight: "80dvh",
  },
});

type OrderItem<T extends string> = {
  id: T;
  label: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
};

function OrderSection<T extends string>({
  label,
  items,
  onCommit,
}: {
  label: string;
  items: OrderItem<T>[];
  onCommit: (order: T[]) => void;
}) {
  const signature = items.map((item) => item.id).join("\u0000");
  const [order, setOrder] = useState<T[]>(() => items.map((item) => item.id));
  const orderRef = useRef(order);
  const committedRef = useRef(signature);
  const [announcement, setAnnouncement] = useState("");

  const resyncFromItems = useEffectEvent(() => {
    const next = items.map((item) => item.id);
    setOrder(next);
    orderRef.current = next;
    committedRef.current = signature;
  });
  useEffect(() => {
    resyncFromItems();
  }, [signature]);

  const byId = new Map(items.map((item) => [item.id, item]));

  function setDraft(next: T[]) {
    orderRef.current = next;
    setOrder(next);
  }

  function commit() {
    const next = orderRef.current;
    const nextSignature = next.join("\u0000");
    if (nextSignature === committedRef.current) return;
    committedRef.current = nextSignature;
    onCommit(next);
  }

  function move(id: T, offset: number) {
    const next = [...orderRef.current];
    const from = next.indexOf(id);
    const to = Math.max(0, Math.min(next.length - 1, from + offset));
    if (from < 0 || from === to) return;
    next.splice(from, 1);
    next.splice(to, 0, id);
    setDraft(next);
    committedRef.current = next.join("\u0000");
    onCommit(next);
    setAnnouncement(`${byId.get(id)?.label ?? id} moved to position ${to + 1}`);
  }

  return (
    <section
      {...stylex.props(sx.Mx2)}
      aria-labelledby={`sidebar-order-${label.toLowerCase()}`}
    >
      <h3
        id={`sidebar-order-${label.toLowerCase()}`}
        {...stylex.props(
          sx.m0,
          sx.mb15,
          sx.px2,
          sx.fontSemibold,
          sx.textFaint,
          typography.label,
        )}
      >
        {label}
      </h3>
      {order.length === 0 ? (
        // Left-aligned like the rows it stands in for.
        <p
          {...stylex.props(
            sx.m0,
            sx.roundedLg,
            sx.bgPanel,
            sx.px2,
            sx.py4,
            sx.textFaint,
            sx.phoneBgSettingsPlate,
            typography.label,
          )}
        >
          No {label.toLowerCase()} available.
        </p>
      ) : (
        <Reorder.Group
          as="div"
          axis="y"
          values={order}
          onReorder={setDraft}
          className={mergeStylexOverrideClassName(
            "",
            sx.roundedLg,
            sx.bgPanel,
            sx.p05,
            sx.phoneBgSettingsPlate,
          )}
          role="list"
        >
          {order.map((id, index) => {
            const item = byId.get(id);
            if (!item) return null;
            return (
              <Reorder.Item
                as="div"
                key={id}
                value={id}
                onDragEnd={commit}
                whileDrag={{ scale: 1.015, zIndex: 2 }}
                className={mergeStylexOverrideClassName(
                  "focus-ring group",
                  sx.flex,
                  sx.minH9,
                  sx.cursorGrab,
                  sx.selectNone,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.roundedControl,
                  sx.bgPanel,
                  sx.px15,
                  sx.py15,
                  sx.textFg,
                  sx.activeCursorGrabbing,
                  sx.hoverBgHover,
                  sx.phoneMinH11,
                  sx.phoneBgSettingsPlate,
                  typography.itemTitle,
                )}
                role="listitem"
                tabIndex={0}
                aria-label={`${item.label}, position ${index + 1} of ${order.length}. Use the up and down arrow keys to move it.`}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                    return;
                  event.preventDefault();
                  move(id, event.key === "ArrowUp" ? -1 : 1);
                }}
              >
                <span
                  {...mergeStylexProps(
                    "group-hover:text-dim",
                    sx.flex,
                    sx.size5,
                    sx.shrink0,
                    sx.itemsCenter,
                    sx.justifyCenter,
                    sx.textFaint,
                  )}
                >
                  <IconGripVertical size={18} />
                </span>
                {/* Shared geometry keeps every tool and repository label
								    on the same vertical line. */}
                <span
                  {...mergeStylexProps(
                    "[&_svg]:size-[20px]",
                    sx.flex,
                    sx.size5,
                    sx.shrink0,
                    sx.itemsCenter,
                    sx.justifyCenter,
                    sx.textDim,
                  )}
                >
                  {item.icon}
                </span>
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                  {item.label}
                </span>
                {item.action && (
                  <span
                    {...stylex.props(sx.shrink0)}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {item.action}
                  </span>
                )}
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      )}
      <div {...stylex.props(sx.srOnly)} aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}

export function SidebarCustomizeDialog({
  open,
  onOpenChange,
  tools,
  repositories,
  onToolOrderChange,
  onRepositoryOrderChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tools: Array<
    OrderItem<SidebarToolId> & {
      shown: boolean;
      onShownChange: (shown: boolean) => void;
    }
  >;
  repositories: string[];
  onToolOrderChange: (order: SidebarToolId[]) => void;
  onRepositoryOrderChange: (order: string[]) => void;
}) {
  const isPhone = useIsPhone();
  const sections = (
    <>
      <OrderSection
        label="Tools"
        items={tools.map((tool) => ({
          ...tool,
          action: (
            <Switch
              size="sm"
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneAfterAbsolute,
                sx.phoneAfterInsetX0,
                sx.phoneAfterInsetY3,
                sx.phoneAfterContent,
              )}
              checked={tool.shown}
              onCheckedChange={tool.onShownChange}
              aria-label={`${tool.shown ? "Hide" : "Show"} ${tool.label} in sidebar`}
            />
          ),
        }))}
        onCommit={onToolOrderChange}
      />
      <OrderSection
        label="Repositories"
        items={repositories.map((repo) => ({
          id: repo,
          label: repoLabel(repo),
          icon: <RepoTile name={repo} size={20} />,
        }))}
        onCommit={onRepositoryOrderChange}
      />
    </>
  );

  if (isPhone) {
    return (
      <ResponsiveDialog
        open={open}
        onClose={() => onOpenChange(false)}
        phone
        label="Customize sidebar"
        sheetClassName={utilityClassName("max-h-[88dvh]")}
      >
        <div
          {...stylex.props(
            sx.flex,
            sx.shrink0,
            sx.itemsCenter,
            sx.gap3,
            sx.px6,
            sx.pb4,
            sx.pt05,
          )}
        >
          <h2
            {...stylex.props(
              sx.m0,
              sx.minW0,
              sx.flex1,
              sx.fontSemibold,
              sx.leadingTight,
              sx.tracking001em,
              sx.textFg,
              typography.dialogTitle,
            )}
          >
            Customize sidebar
          </h2>
          <SheetIconButton
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <IconX />
          </SheetIconButton>
        </div>
        <SheetBody
          className={mergeStylexOverrideClassName(
            "",
            sx.flex,
            sx.flex1,
            sx.flexCol,
            sx.gap5,
            sx.px6,
            sx.pb6,
          )}
        >
          {sections}
        </SheetBody>
      </ResponsiveDialog>
    );
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        widthClassName={utilityClassName("max-w-[32rem]")}
        className={mergeStylexOverrideClassName("", sx.maxH80dvh, sx.gap3)}
      >
        <Modal.Header title="Customize sidebar" />
        {sections}
      </Modal.Content>
    </Modal.Root>
  );
}
