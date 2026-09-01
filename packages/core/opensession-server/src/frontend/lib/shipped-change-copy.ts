function sentence(value: string): string {
  const clean = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.` : "";
}

export function shippedChangeOutcome(
  markdown?: string,
  title?: string,
): string {
  if (!markdown) return "";
  const lines = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s+/, "")
        .replace(/[*_`~]/g, "")
        .trim(),
    )
    .filter(Boolean);
  for (const raw of lines) {
    const value = raw
      .replace(/^Deployment is live\s*[—:-]\s*/i, "")
      .replace(/^This change\s+/i, "")
      .trim();
    if (
      value.length < 20 ||
      /^(done|pushed|merged|commit|tests?|verified|pr\s*#|updated and live)\b/i.test(
        value,
      )
    )
      continue;
    const first = value.split(/(?<=[.!?])\s+/)[0];
    const named = title
      ?.replace(/^Name\s+/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    const allUpdated = first?.match(
      /^Updated all (\d+) to (.+?)(?:, including:)?$/i,
    );
    if (allUpdated && named)
      return sentence(`All ${allUpdated[1]} ${named} now use ${allUpdated[2]}`);
    if (first && !/^we\s+(shipped|updated|added|changed|fixed)\b/i.test(first))
      return sentence(first);
  }
  return "";
}

function visibleOutcome(value: string): string {
  const match = value.match(/^(.+?)(\s+(?:in|via|on|through|with)\s+.+)?$/i);
  const subject = match?.[1]?.trim() || value;
  const qualifier = match?.[2] || "";
  const noun = subject.split(/\s+/).at(-1)?.toLowerCase() || "";
  const verb = noun.endsWith("s") && !noun.endsWith("ss") ? "are" : "is";
  return `${subject} ${verb} now visible${qualifier}`;
}

/**
 * A first draft of the Slack message announcing a merged change, shown in the
 * composer for the person to edit before sending. Repository-neutral: it reads
 * the walkthrough summary when there is one, and otherwise turns the PR title
 * from an instruction into an outcome.
 */
export function suggestedShippedChangeMessage(
  title: string,
  context?: string,
): string {
  const outcome = shippedChangeOutcome(context, title);
  if (outcome) return outcome;
  const clean = title
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!clean) return "The update is now available.";
  if (/\b(now|is|are|has|have|can)\b/i.test(clean)) return sentence(clean);
  const [verb, ...rest] = clean.split(/\s+/);
  const object = rest.join(" ").trim();
  const lower = verb.toLowerCase();
  if (lower === "name" && object) return sentence(`${object} now have names`);
  if (lower === "show" && object) return sentence(visibleOutcome(object));
  if (["add", "create"].includes(lower) && object)
    return sentence(`${object} is now available`);
  if (["fix"].includes(lower) && object)
    return sentence(`${object} now works correctly`);
  if (["remove"].includes(lower) && object)
    return sentence(`${object} is now removed`);
  if (
    ["adopt", "change", "make", "replace", "update", "use"].includes(lower) &&
    object
  )
    return sentence(`${object} is now updated`);
  if (["improve", "polish", "redesign", "simplify"].includes(lower) && object)
    return sentence(`${object} is now improved`);
  return sentence(`${clean} is now available`);
}
