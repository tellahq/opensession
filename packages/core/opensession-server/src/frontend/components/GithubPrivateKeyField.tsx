import { mergeStylexOverrideClassName } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconArrowUpToLine } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap1: {
    gap: "4px",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  shrink0: {
    flexShrink: "0",
  },
  textGreen: {
    color: "var(--green)",
  },
  hidden: {
    display: "none",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  phoneItemsStretch: {
    "@media (max-width: 720px)": {
      alignItems: "stretch",
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  phoneJustifyCenter: {
    "@media (max-width: 720px)": {
      justifyContent: "center",
    },
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
});

export function GithubPrivateKeyField({
  configured,
  required = true,
  saving,
  value,
  onChange,
  description,
}: {
  configured: boolean;
  required?: boolean;
  saving: boolean;
  value: string;
  onChange: (value: string) => void;
  description?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value) setFileName(null);
  }, [value]);

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setError(null);
    // Let choosing the same file again fire another change event.
    input.value = "";
    try {
      onChange(await file.text());
      setFileName(file.name);
    } catch {
      setError(
        "Could not read that file. Choose the downloaded PEM file again.",
      );
    }
  }

  const selected = Boolean(value && fileName);

  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
      <div
        {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap2)}
      >
        <span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>
          Private key (PEM)
        </span>
        {selected ? (
          <span {...stylex.props(sx.shrink0, sx.textGreen, typography.meta)}>
            Selected
          </span>
        ) : configured ? (
          <span {...stylex.props(sx.shrink0, sx.textGreen, typography.meta)}>
            Saved
          </span>
        ) : required ? (
          <Badge tone="warning">Required</Badge>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pem,application/x-pem-file,text/plain"
        {...stylex.props(sx.hidden)}
        disabled={saving}
        onChange={(event) => void selectFile(event)}
      />
      <div
        {...stylex.props(
          sx.mt05,
          sx.flex,
          sx.itemsCenter,
          sx.gap3,
          sx.phoneFlexCol,
          sx.phoneItemsStretch,
        )}
      >
        <Button
          type="button"
          icon={<IconArrowUpToLine size={20} />}
          disabled={saving}
          className={mergeStylexOverrideClassName(
            "",
            sx.shrink0,
            sx.phoneMinH11,
            sx.phoneJustifyCenter,
          )}
          onClick={() => inputRef.current?.click()}
        >
          {selected
            ? "Choose another PEM"
            : configured
              ? "Replace PEM file"
              : "Choose PEM file"}
        </Button>
        {fileName && (
          <span
            {...stylex.props(
              sx.minW0,
              sx.truncate,
              sx.textDim,
              typography.supporting,
            )}
            title={fileName}
          >
            {fileName}
          </span>
        )}
      </div>
      <span {...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}>
        {description ??
          (configured
            ? "Choose a .pem file to replace the saved private key, or leave it unchanged."
            : "Choose the .pem private key downloaded from GitHub.")}
      </span>
      {error && (
        <span
          {...stylex.props(sx.leadingSnug, sx.textRed, typography.meta)}
          role="alert"
        >
          {error}
        </span>
      )}
    </div>
  );
}
