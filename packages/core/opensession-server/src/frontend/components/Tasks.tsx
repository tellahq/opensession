import React, { useCallback, useEffect, useState } from "react";
import { z } from "zod";
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

interface TasksProps {
  addHandler: (handler: (message: WSServerMessage) => void) => () => void;
  onOpenSession: (sessionId: string) => void;
}

const todoItemSchema = z.object({
  id: z.string(),
  user: z.string(),
  text: z.string(),
  status: z.enum(["open", "done", "dropped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  note: z.string().optional(),
  due: z.string().optional(),
  remindAt: z.string().optional(),
  remindedAt: z.string().optional(),
  source: z.object({
    kind: z.enum(["session", "manual"]),
    sessionId: z.string().optional(),
    by: z.string().optional(),
  }),
}) satisfies z.ZodType<TodoItem>;

const todosResponseSchema = z.object({
  todos: z.array(todoItemSchema).optional(),
});

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
    <li className="group flex min-h-11 items-center gap-3 px-3 py-2.5 sm:px-4">
      <button
        type="button"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors active:scale-[0.96]",
          done
            ? "border-green bg-green text-panel"
            : "border-line-strong text-transparent hover:border-fg/50",
        )}
        onClick={() => onToggle(task)}
        aria-label={done ? `Reopen ${task.text}` : `Mark ${task.text} done`}
      >
        <IconCheck size={14} />
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-item-title font-medium text-fg",
            done && "text-dim line-through",
          )}
        >
          {task.text}
        </div>
        {task.note && (
          <div className="mt-0.5 text-label text-faint">{task.note}</div>
        )}
        {(task.due || (task.remindAt && !done) || task.source.sessionId) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-faint">
            {task.due && <span>Due {task.due}</span>}
            {task.remindAt && !done && (
              <span className={cn(task.remindedAt && "line-through")}>
                {task.remindedAt ? "Reminded" : "Reminder"}{" "}
                {formatReminder(task.remindAt)}
              </span>
            )}
            {task.source.sessionId && (
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 hover:text-dim"
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
          className="shrink-0 text-faint"
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
      const data = todosResponseSchema.parse(await response.json());
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

  async function patchTask(id: string, patch: Pick<TodoItem, "status">) {
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
      className="h-full overflow-y-auto px-4 py-5 sm:px-7 sm:py-7"
    >
      <div className="mx-auto max-w-[760px]">
        <PageHeader>
          <div>
            <PageTitle>Tasks</PageTitle>
            <PageDescription>
              {open.length} open task{open.length === 1 ? "" : "s"}
            </PageDescription>
          </div>
        </PageHeader>

        <form
          className="mb-5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <Input
            size="lg"
            className="min-w-0 flex-1"
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

        {error && <div className="mb-3 text-body text-red">{error}</div>}

        {tasks === null ? (
          <Card>
            <div className="px-4 py-8 text-center text-body text-dim">
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
            className="overflow-hidden rounded-xl bg-raised px-4"
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
          <div className="mt-5">
            <button
              type="button"
              className="mb-2 flex min-h-10 items-center gap-2 text-control-label font-medium text-dim hover:text-fg"
              onClick={() => setShowDone((current) => !current)}
              aria-expanded={showDone}
            >
              <span>{showDone ? "Hide" : "Show"} completed</span>
              <span className="text-faint">{done.length}</span>
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
