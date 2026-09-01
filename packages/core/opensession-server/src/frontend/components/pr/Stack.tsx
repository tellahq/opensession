import { useState } from "react";
import { linkPrStackApi } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import type { PrDetails } from "../../lib/types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { toast } from "../../ui/toast";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  phonePx3: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 3)",
    },
  },
  minW0: {
    minWidth: "0",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
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
});

/**
 * The one stack state that cannot live in StackPopover yet: this session was
 * branched from another session, but GitHub has not linked the two PRs into a
 * stack. Once linked, PrPanel replaces this prompt with the compact stack chip
 * in its identity bar.
 */
export function StackLinkSection({
  pr,
  sessionId,
  onLinked,
}: {
  pr: PrDetails;
  sessionId?: string;
  onLinked: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pr.stack || !pr.stackBase || !sessionId) return null;

  const link = async () => {
    setLinking(true);
    setError(null);
    await (async () => {
      await linkPrStackApi(sessionId);
      toast("Linked into a stack");
      onLinked();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Couldn't link the stack"));
      })
      .finally(async () => {
        setLinking(false);
      });
  };

  return (
    <section
      {...stylex.props(
        sx.flex,
        sx.shrink0,
        sx.itemsCenter,
        sx.gap3,
        sx.px6,
        sx.py3,
        sx.phonePx3,
      )}
    >
      <div
        {...stylex.props(sx.minW0, sx.textXs, sx.leadingRelaxed, sx.textDim)}
      >
        This branch was cut from <Badge variant="outline">{pr.stackBase}</Badge>
        , but the PRs are not linked on GitHub yet.
      </div>
      <Button size="sm" onClick={link} disabled={linking}>
        {linking ? "Linking…" : "Link stack"}
      </Button>
      {error && <span {...stylex.props(sx.textXs, sx.textRed)}>{error}</span>}
    </section>
  );
}
