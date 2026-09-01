import { mergeStylexProps, utilityClassName } from "../ui/cn";
import { useState } from "react";
import type { SessionSafetyState } from "../lib/types";
import { Button } from "../ui/button";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mxAuto: {
    marginInline: "auto",
  },
  my4: {
    marginBlock: "calc(4px * 4)",
  },
  wFull: {
    width: "100%",
  },
  maxW52rem: {
    maxWidth: "52rem",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",

    cornerShape: "var(--cs)",
  },
  bgYellowSoft: {
    backgroundColor: "var(--yellow-soft)",
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  textFg: {
    color: "var(--text)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  shrink0: {
    flexShrink: "0",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",

    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  textPretty: {
    textWrap: "pretty",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  textRed: {
    color: "var(--red)",
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
});

export function SessionSafetyNotice({
  safety,
  onContinue,
  onRepair,
}: {
  safety: SessionSafetyState;
  onContinue: () => void;
  onRepair?: () => Promise<void>;
}) {
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="session-safety-title"
      className={utilityClassName(
        "mx-auto my-4 w-full max-w-[46rem] rounded-2xl bg-yellow-soft p-4 text-fg phone:my-3 phone:rounded-xl",
      )}
    >
      <h2
        id="session-safety-title"
        className={utilityClassName("m-0 text-body font-semibold")}
      >
        Paused for safety
      </h2>
      <p
        className={utilityClassName(
          "mt-1 text-pretty text-body leading-relaxed text-dim",
        )}
      >
        {safety.explanation}
      </p>
      {repairError && (
        <p
          role="alert"
          {...stylex.props(sx.mt3, sx.textRed, typography.supporting)}
        >
          {repairError}
        </p>
      )}
      <div
        {...mergeStylexProps(
          "phone:flex-col phone:items-stretch",
          sx.mt4,
          sx.flex,
          sx.flexWrap,
          sx.itemsCenter,
          sx.gap2,
        )}
      >
        {onRepair && safety.repairAvailable ? (
          <>
            <Button
              variant="primary"
              size="lg"
              disabled={repairing}
              onClick={() => {
                setRepairing(true);
                setRepairError(null);
                void onRepair()
                  .catch((error) =>
                    setRepairError(
                      error instanceof Error
                        ? error.message
                        : "This session could not be recovered safely.",
                    ),
                  )
                  .finally(() => setRepairing(false));
              }}
            >
              {repairing ? "Recovering" : "Continue in this session"}
            </Button>
            <Button size="lg" disabled={repairing} onClick={onContinue}>
              Continue in a new session
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" onClick={onContinue}>
            Continue in a new session
          </Button>
        )}
      </div>
    </section>
  );
}
