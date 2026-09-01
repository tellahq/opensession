import React, { Suspense, lazy } from "react";
import { TOOL_PRE } from "../lib/tool-classes";

// Shiki (the syntax highlighter) is multi-MB; keep it out of the initial
// bundle and load it only when something actually shows code — a tool call
// expanded, or a turn's file chip opened. Until the chunk arrives, the code
// shows as a plain pre, which is the same text without the colour.
const CodeHighlightLazy = lazy(() =>
  import("./CodeHighlight").then((m) => ({ default: m.CodeHighlight })),
);

export function CodeHighlight(props: {
  code: string;
  lang: string;
  gutter?: boolean;
  requireGutter?: boolean;
}) {
  return (
    <Suspense fallback={<pre className={TOOL_PRE}>{props.code}</pre>}>
      <CodeHighlightLazy {...props} />
    </Suspense>
  );
}
