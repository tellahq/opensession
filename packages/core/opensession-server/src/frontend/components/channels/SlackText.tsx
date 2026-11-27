import React from "react";

/** Markdown-lite renderer for slack text the route emits: ![:name:](url)
 *  custom-emoji images, [label](url) links, [[@Name]]/[[#chan]] mention
 *  chips, bare URLs — everything else as selectable text. */
export function SlackText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re =
    /!\[([^\]]*)\]\((https?:[^)\s]+)\)|\[([^\]]+)\]\((https?:[^)\s]+)\)|\[\[([@#][^\]]+)\]\]|(https?:\/\/[^\s<>]+[^\s<>.,)\]}])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      // Custom emoji image, sized to ride inline with the text.
      parts.push(
        <img
          key={key++}
          src={m[2]}
          alt={m[1]}
          title={m[1]}
          className="inline-block h-[18px] w-[18px] align-text-bottom"
        />,
      );
    } else if (m[5] !== undefined) {
      parts.push(
        <span
          key={key++}
          className="rounded-sm bg-accent-soft px-1 font-medium text-accent"
        >
          {m[5]}
        </span>,
      );
    } else {
      const href = m[4] || m[6];
      const label = m[3] || m[6];
      parts.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-line underline-offset-2 hover:decoration-current"
        >
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <div className="select-text whitespace-pre-wrap break-words text-body leading-snug text-fg">
      {parts}
    </div>
  );
}
