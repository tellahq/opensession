/**
 * Extracts markdown tables and alert-style paragraphs from the final response
 * text and converts them into native Slack Block Kit blocks.
 *
 * See https://docs.slack.dev/reference/block-kit/blocks/table-block
 * and https://docs.slack.dev/reference/block-kit/blocks/alert-block
 */

export type AlertLevel = "default" | "info" | "success" | "warning" | "error";

export interface ExtractedBlock {
  type: "table" | "alert";
  block: any;
}

const ALERT_MARKERS: Array<{ pattern: RegExp; level: AlertLevel }> = [
  { pattern: /^(?::warning:|⚠️|⚠)\s+/, level: "warning" },
  { pattern: /^(?::x:|❌|❗|🚨)\s+/, level: "error" },
  { pattern: /^(?::white_check_mark:|✅|✔️)\s+/, level: "success" },
  { pattern: /^(?::information_source:|ℹ️|ℹ)\s+/, level: "info" },
];

function parseMarkdownTable(block: string): any | null {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const isRow = (l: string) => l.startsWith("|") && l.endsWith("|");
  if (!lines.every(isRow)) return null;

  // Second line must be a markdown separator like |---|---|
  const separator = lines[1];
  if (!/^\|[\s\-:|]+\|$/.test(separator)) return null;

  const parseRow = (line: string) =>
    line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

  const header = parseRow(lines[0]);
  const bodyRows = lines.slice(2).map(parseRow);

  const colCount = header.length;
  if (colCount === 0 || colCount > 20) return null;

  const toCell = (text: string) => ({ type: "raw_text", text: text || " " });
  const rows = [header, ...bodyRows]
    .slice(0, 100)
    .map((row) => row.slice(0, 20).map(toCell));

  return { type: "table", rows };
}

function parseAlertParagraph(paragraph: string): any | null {
  const trimmed = paragraph.trim();
  // Alerts are single-line paragraphs so we don't accidentally eat prose.
  if (!trimmed || trimmed.includes("\n")) return null;
  for (const { pattern, level } of ALERT_MARKERS) {
    const match = trimmed.match(pattern);
    if (match) {
      const text = trimmed.slice(match[0].length).trim();
      if (!text) return null;
      return { type: "alert", level, text: { type: "mrkdwn", text } };
    }
  }
  return null;
}

/**
 * Splits text into paragraphs (blank-line separated) and extracts markdown
 * tables and single-line alerts as Block Kit blocks. Returns the remaining
 * prose and the extracted blocks in document order.
 */
export function extractBlocks(text: string): {
  cleanedText: string;
  blocks: ExtractedBlock[];
} {
  const paragraphs = text.split(/\n{2,}/);
  const keptParagraphs: string[] = [];
  const blocks: ExtractedBlock[] = [];

  for (const para of paragraphs) {
    const table = parseMarkdownTable(para);
    if (table) {
      blocks.push({ type: "table", block: table });
      continue;
    }
    const alert = parseAlertParagraph(para);
    if (alert) {
      blocks.push({ type: "alert", block: alert });
      continue;
    }
    keptParagraphs.push(para);
  }

  return {
    cleanedText: keptParagraphs.join("\n\n").trim(),
    blocks,
  };
}
