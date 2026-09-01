import { utilityClassName } from "../ui/cn";
import { cn } from "../ui/cn";
import { typingLabel } from "../lib/typing";

export function TypingIndicator({
  users,
  className,
}: {
  users: string[];
  className?: string;
}) {
  const label = typingLabel(users);
  if (!label) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(utilityClassName("text-label text-faint"), className)}
    >
      {label}
    </div>
  );
}
