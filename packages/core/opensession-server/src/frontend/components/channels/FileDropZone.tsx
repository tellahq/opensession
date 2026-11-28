import { useState, type ReactNode } from "react";
import { cn } from "../../ui/cn";
import { IconPaperclip } from "../icons";

function hasFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * A conversation that takes files dropped anywhere on it, as Slack's does:
 * while files are dragged over, a quiet sheet says where they will go.
 */
export function FileDropZone({
  label,
  onFiles,
  disabled = false,
  className,
  children,
}: {
  /** "Upload to #design". */
  label: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn("relative", className)}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next))
          setOver(false);
      }}
      onDrop={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-9 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface/90 text-dialog-title font-semibold text-fg"
        >
          <IconPaperclip size={28} className="text-accent" />
          {label}
        </div>
      )}
    </div>
  );
}
