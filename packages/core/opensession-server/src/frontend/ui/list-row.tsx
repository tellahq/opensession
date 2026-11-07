import * as React from "react";
import { cn } from "./cn";

/**
 * A whole list row that is one action: a thread, a comment, a file. Full
 * width, left aligned, any layout inside; the focus ring and hover wash are
 * the row's, and it is a 44px target on a phone. `Button` is for a labelled
 * control, this is for a row of content you open.
 *
 * `variant="card"` is the same row standing on its own fill, for a row that
 * sits in running text rather than in a list (a thread card in a transcript).
 */
export function ListRow({
  className,
  variant = "plain",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & { variant?: "plain" | "card" }) {
  return (
    <button
      type={type}
      className={cn(
        "focus-ring flex w-full min-w-0 items-start gap-2.5 text-left transition-colors hover:bg-hover phone:min-h-11",
        variant === "card"
          ? "rounded-xl bg-panel px-3 py-2"
          : "rounded-md px-2 py-1.5",
        className,
      )}
      {...props}
    />
  );
}
