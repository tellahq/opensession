import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useCallback, useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import type { TodoItem, WSServerMessage } from "../lib/types";
import { Button } from "../ui/button";
import { Card, CardList } from "../ui/card";
import { cn } from "../ui/cn";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { EmptyState } from "../ui/state";
import { getCurrentUser } from "./UserPicker";
import { IconCheck, IconListCircles, IconPlus, IconX } from "./icons";
import { Input } from "../ui/input";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py25: {
    paddingBlock: "calc(4px * 2.5)",
  },
  smPx4: {
    "@media (min-width: 40rem)": {
      paddingInline: "calc(4px * 4)",
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  mt1: {
    marginTop: "4px",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gapX25: {
    columnGap: "calc(4px * 2.5)",
  },
  gapY1: {
    rowGap: "4px",
  },
  underline: {
    textDecorationLine: "underline",
  },
  decorationDotted: {
    textDecorationStyle: "dotted",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  hoverTextDim: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text-dim)",
      },
    },
  },
  shrink0: {
    flexShrink: "0",
  },
  hFull: {
    height: "100%",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py5: {
    paddingBlock: "calc(4px * 5)",
  },
  smPx7: {
    "@media (min-width: 40rem)": {
      paddingInline: "calc(4px * 7)",
    },
  },
  smPy7: {
    "@media (min-width: 40rem)": {
      paddingBlock: "calc(4px * 7)",
    },
  },
  mxAuto: {
    marginInline: "auto",
  },
  maxW760px: {
    maxWidth: "760px",
  },
  mb5: {
    marginBottom: "calc(4px * 5)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  textRed: {
    color: "var(--red)",
  },
  py8: {
    paddingBlock: "calc(4px * 8)",
  },
  textCenter: {
    textAlign: "center",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  mt5: {
    marginTop: "calc(4px * 5)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
});

interface TasksProps {
  addHandler: (handler: (message: WSServerMessage) => void) => () => void;
  onOpenSession: (sessionId: string) => void;
}

function formatReminder(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return time;
  if (Math.abs(date.getTime() - now.getTime()) < 6 * 86_400_000)
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function TaskRow({
  task,
  onToggle,
  onDrop,
  onOpenSession,
}: {
  task: TodoItem;
  onToggle: (task: TodoItem) => void;
  onDrop: (task: TodoItem) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const done = task.status === "done";
  return (
    <li
      {...mergeStylexProps(
        "group",
        sx.flex,
        sx.minH11,
        sx.itemsCenter,
        sx.gap3,
        sx.px3,
        sx.py25,
        sx.smPx4,
      )}
    >
      <button
        type="button"
        className={cn(
          utilityClassName(
            "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors active:scale-[0.96]",
          ),
          done
            ? utilityClassName("border-green bg-green text-panel")
            : utilityClassName(
                "border-line-strong text-transparent hover:border-fg/50",
              ),
        )}
        onClick={() => onToggle(task)}
        aria-label={done ? `Reopen ${task.text}` : `Mark ${task.text} done`}
      >
        <IconCheck size={14} />
      </button>
      <div {...stylex.props(sx.minW0, sx.flex1)}>
        <div
          className={cn(
            utilityClassName("text-item-title font-medium text-fg"),
            done && utilityClassName("text-dim line-through"),
          )}
        >
          {task.text}
        </div>
        {task.note && (
          <div {...stylex.props(sx.mt05, sx.textFaint, typography.label)}>
            {task.note}
          </div>
        )}
        {(task.due || (task.remindAt && !done) || task.source.sessionId) && (
          <div
            {...stylex.props(
              sx.mt1,
              sx.flex,
              sx.flexWrap,
              sx.itemsCenter,
              sx.gapX25,
              sx.gapY1,
              sx.textFaint,
              typography.label,
            )}
          >
            {task.due && <span>Due {task.due}</span>}
            {task.remindAt && !done && (
              <span
                className={cn(
                  task.remindedAt && utilityClassName("line-through"),
                )}
              >
                {task.remindedAt ? "Reminded" : "Reminder"}{" "}
                {formatReminder(task.remindAt)}
              </span>
            )}
            {task.source.sessionId && (
              <button
                type="button"
                {...stylex.props(
                  sx.underline,
                  sx.decorationDotted,
                  sx.underlineOffset2,
                  sx.hoverTextDim,
                )}
                onClick={() => onOpenSession(task.source.sessionId!)}
              >
                Open source
              </button>
            )}
          </div>
        )}
      </div>
      {!done && (
        <Button
          variant="ghost"
          size="md"
          className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
          onClick={() => onDrop(task)}
          aria-label={`Drop ${task.text}`}
          title="Drop task"
          icon={<IconX size={16} />}
        />
      )}
    </li>
  );
}

export function Tasks({ addHandler, onOpenSession }: TasksProps) {
  const user = getCurrentUser();
  const [tasks, setTasks] = useState<TodoItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    await (async () => {
      const response = await fetch(
        `${BASE_PATH}/api/todos?status=all&user=${encodeURIComponent(user)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { todos?: TodoItem[] };
      setTasks(data.todos || []);
      setError(null);
    })().catch(async () => {
      setTasks((current) => current ?? []);
      setError("Tasks could not be loaded.");
    });
  }, [user]);

  useEffect(() => {
    document.title = docTitle("Tasks");
    void load();
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  useEffect(
    () =>
      addHandler((message) => {
        if (message.type === "todos_changed") void load();
      }),
    [addHandler, load],
  );

  async function patchTask(id: string, patch: Record<string, unknown>) {
    await (async () => {
      const response = await fetch(
        `${BASE_PATH}/api/todos/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...patch, user }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setError(null);
    })()
      .catch(async () => {
        setError("The task could not be updated.");
      })
      .finally(async () => {
        void load();
      });
  }

  function toggle(task: TodoItem) {
    const status = task.status === "done" ? "open" : "done";
    setTasks(
      (current) =>
        current?.map((item) =>
          item.id === task.id ? { ...item, status } : item,
        ) ?? current,
    );
    void patchTask(task.id, { status });
  }

  function drop(task: TodoItem) {
    setTasks(
      (current) => current?.filter((item) => item.id !== task.id) ?? current,
    );
    void patchTask(task.id, { status: "dropped" });
  }

  async function addTask() {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    await (async () => {
      const response = await fetch(`${BASE_PATH}/api/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, user }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDraft("");
      setError(null);
    })()
      .catch(async () => {
        setError("The task could not be added.");
      })
      .finally(async () => {
        setAdding(false);
        void load();
      });
  }

  const open = (tasks || []).filter((task) => task.status === "open");
  const done = (tasks || []).filter((task) => task.status === "done");

  return (
    <div
      data-page-scroll
      {...stylex.props(
        sx.hFull,
        sx.overflowYAuto,
        sx.px4,
        sx.py5,
        sx.smPx7,
        sx.smPy7,
      )}
    >
      <div {...stylex.props(sx.mxAuto, sx.maxW760px)}>
        <PageHeader>
          <div>
            <PageTitle>Tasks</PageTitle>
            <PageDescription>
              {open.length} open task{open.length === 1 ? "" : "s"}
            </PageDescription>
          </div>
        </PageHeader>

        <form
          {...stylex.props(sx.mb5, sx.flex, sx.gap2)}
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <Input
            size="lg"
            className={mergeStylexOverrideClassName("", sx.minW0, sx.flex1)}
            value={draft}
            placeholder="Add a task"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            variant="primary"
            icon={<IconPlus size={20} />}
            disabled={!draft.trim() || adding}
          >
            {adding ? "Adding…" : "Add task"}
          </Button>
        </form>

        {error && (
          <div {...stylex.props(sx.mb3, sx.textRed, typography.body)}>
            {error}
          </div>
        )}

        {tasks === null ? (
          <Card>
            <div
              {...stylex.props(
                sx.px4,
                sx.py8,
                sx.textCenter,
                sx.textDim,
                typography.body,
              )}
            >
              Loading…
            </div>
          </Card>
        ) : open.length ? (
          <CardList as="ul">
            {open.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={toggle}
                onDrop={drop}
                onOpenSession={onOpenSession}
              />
            ))}
          </CardList>
        ) : (
          <div
            // Empty reads as a soft, borderless well rather than a card with
            // nothing in it: rounder, one step lighter, no outline.
            {...stylex.props(
              sx.overflowHidden,
              sx.roundedXl,
              sx.bgRaised,
              sx.px4,
            )}
          >
            <EmptyState
              icon={<IconListCircles size={22} />}
              title="Nothing on your list"
            >
              Add a task when something needs your attention.
            </EmptyState>
          </div>
        )}

        {done.length > 0 && (
          <div {...stylex.props(sx.mt5)}>
            <button
              type="button"
              {...stylex.props(
                sx.mb2,
                sx.flex,
                sx.minH10,
                sx.itemsCenter,
                sx.gap2,
                sx.fontMedium,
                sx.textDim,
                sx.hoverTextFg,
                typography.controlLabel,
              )}
              onClick={() => setShowDone((current) => !current)}
              aria-expanded={showDone}
            >
              <span>{showDone ? "Hide" : "Show"} completed</span>
              <span {...stylex.props(sx.textFaint)}>{done.length}</span>
            </button>
            {showDone && (
              <CardList as="ul">
                {done.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={toggle}
                    onDrop={drop}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </CardList>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
