import { useState, type ReactElement } from "react";
import { EMOJI, type EmojiEntry } from "../../lib/emoji";
import { Input } from "../../ui/input";
import { ListRow } from "../../ui/list-row";
import { Popover } from "../../ui/popover";
import { Tooltip } from "../../ui/tooltip";

function matches(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!q) return EMOJI;
  return EMOJI.filter(
    (entry) =>
      entry.name.includes(q) || entry.alias?.some((alias) => alias.includes(q)),
  );
}

/**
 * Slack's emoji picker, cut down: a search field over a grid. Picking one
 * closes it. `trigger` is the button that opens it.
 */
export function EmojiPicker({
  trigger,
  onPick,
  side = "top",
  align = "end",
  tooltip,
}: {
  trigger: ReactElement;
  /** Shown on hover over the trigger. */
  tooltip?: string;
  onPick: (entry: EmojiEntry) => void;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = matches(query);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      {tooltip ? (
        <Tooltip label={tooltip}>
          <Popover.Trigger render={trigger} />
        </Tooltip>
      ) : (
        <Popover.Trigger render={trigger} />
      )}
      <Popover.Popup
        side={side}
        align={align}
        className="flex w-[324px] max-w-[calc(100vw-16px)] flex-col gap-2 p-2"
        aria-label="Emoji"
        initialFocus
      >
        <Input
          value={query}
          placeholder="Search all emoji"
          aria-label="Search emoji"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && shown[0]) {
              event.preventDefault();
              onPick(shown[0]);
              setOpen(false);
            }
          }}
        />
        <div className="grid max-h-[248px] grid-cols-8 gap-0.5 overflow-y-auto">
          {shown.map((entry) => (
            <ListRow
              key={entry.name}
              title={`:${entry.name}:`}
              aria-label={`:${entry.name}:`}
              className="size-9 min-h-0 items-center justify-center p-0 text-dialog-title"
              onClick={() => {
                onPick(entry);
                setOpen(false);
              }}
            >
              {entry.char}
            </ListRow>
          ))}
          {!shown.length && (
            <p className="col-span-8 py-6 text-center text-meta text-faint">
              No emoji match
            </p>
          )}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}
