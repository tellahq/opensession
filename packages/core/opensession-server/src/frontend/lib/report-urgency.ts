/**
 * How a report's urgency is drawn as a mark, shared by the two surfaces that
 * list reports: the sidebar's AutomationReportRow and the Reports page's own
 * list column. It lived in the sidebar row alone, and the page then invented a
 * pill instead — so the same field read as a coloured dot in one place and as
 * "low urgency · high confidence" in the other.
 *
 * An unset urgency is not "low" — the report simply didn't say — so it takes
 * the neutral mark rather than borrowing the calmest one. The scale is the
 * support lanes': red, yellow, blue, then neutral.
 */
/** The dot's fill, as a colour for an inline `background-color`. */
export function reportUrgencyDot(urgency?: string): string {
  switch (urgency) {
    case "critical":
      return "var(--red)";
    case "high":
      return "var(--yellow)";
    case "medium":
      return "var(--blue)";
    default:
      return "var(--text-faint)";
  }
}

/**
 * What the dot says, for a reader who can't see it. A row whose only urgency
 * signal is a colour has none at all in a screen reader, and "unknown urgency"
 * is noise on the majority of rows — so an unset urgency gets no label and the
 * row reads as just its title.
 */
export function reportUrgencyLabel(urgency?: string): string | null {
  return urgency ? `${urgency} urgency` : null;
}
