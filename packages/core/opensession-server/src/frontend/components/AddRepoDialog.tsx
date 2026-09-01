import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import { registerRepoApi, type RepoInfo } from "../lib/api";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { fieldClasses } from "../ui/input";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  wFull: {
    width: "100%",
  },
  flex1: {
    flex: "1",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderRed30: {
    borderColor: "color-mix(in oklab, var(--red) 30%, transparent)",
  },
  bgRedSoft: {
    backgroundColor: "var(--red-soft)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textRed: {
    color: "var(--red)",
  },
});

type AddMode = "clone" | "path";

export function AddRepoDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (repo: RepoInfo) => void;
}) {
  const [mode, setMode] = useState<AddMode>("clone");
  const [cloneUrl, setCloneUrl] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const value = mode === "clone" ? cloneUrl : folderPath;

  useEffect(() => {
    if (!open) return;
    setError(null);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open, mode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = value.trim();
    if (!input || adding) return;
    setAdding(true);
    setError(null);
    await (async () => {
      const repo = await registerRepoApi(
        mode === "clone" ? { url: input } : { path: input },
      );
      onAdded(repo);
      if (mode === "clone") setCloneUrl("");
      else setFolderPath("");
      onOpenChange(false);
    })()
      .catch(async (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(async () => {
        setAdding(false);
      });
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!adding) onOpenChange(next);
      }}
      disablePointerDismissal={adding}
    >
      <Modal.Content
        widthClassName={utilityClassName("max-w-[28rem]")}
        initialFocus={inputRef}
      >
        <Modal.Header
          title="Add repository"
          description="Clone a Git repository (GitHub or a code.storage remote), or register a checkout already on this Mac."
        />

        <Segmented
          className={mergeStylexOverrideClassName("", sx.wFull)}
          label="Repository source"
          value={mode}
          onValueChange={(next) => {
            setMode(next as typeof mode);
            setError(null);
          }}
        >
          {(
            [
              ["clone", "Clone URL"],
              ["path", "Local folder"],
            ] as const
          ).map(([nextMode, label]) => (
            <SegmentedOption
              key={nextMode}
              value={nextMode}
              className={mergeStylexOverrideClassName(
                "",
                sx.flex1,
                sx.justifyCenter,
              )}
              disabled={adding}
            >
              {label}
            </SegmentedOption>
          ))}
        </Segmented>

        <form {...stylex.props(sx.flex, sx.flexCol, sx.gap3)} onSubmit={submit}>
          <label
            {...stylex.props(
              sx.flex,
              sx.flexCol,
              sx.gap15,
              sx.textSm,
              sx.fontMedium,
              sx.textFg,
            )}
          >
            {mode === "clone" ? "Git clone URL" : "Absolute folder path"}
            <input
              ref={inputRef}
              type="text"
              /* Raw element for the ref; optics from the field primitive. The
							   40px height is the dialog's own — this is the modal's single
							   affordance and has no control beside it to match. */
              className={fieldClasses(
                "lg",
                "h-10 border-line-strong text-sm focus:shadow-[0_0_0_3px_var(--accent-soft)]",
              )}
              value={value}
              onChange={(event) =>
                mode === "clone"
                  ? setCloneUrl(event.target.value)
                  : setFolderPath(event.target.value)
              }
              placeholder={
                mode === "clone"
                  ? "git@github.com:owner/repo.git or https://org.code.storage/repo.git"
                  : "/Users/you/code/repository"
              }
              disabled={adding}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {error && (
            <div
              {...stylex.props(
                sx.roundedMd,
                sx.border,
                sx.borderRed30,
                sx.bgRedSoft,
                sx.px3,
                sx.py2,
                sx.textXs,
                sx.leadingRelaxed,
                sx.textRed,
              )}
              role="alert"
            >
              {error}
            </div>
          )}

          <Modal.Footer>
            <div {...stylex.props(sx.flex1)} />
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!value.trim() || adding}
            >
              {adding
                ? mode === "clone"
                  ? "Cloning..."
                  : "Adding..."
                : "Add repository"}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
