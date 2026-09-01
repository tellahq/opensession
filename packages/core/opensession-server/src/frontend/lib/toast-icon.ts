export type ToastIconName =
  | "archive"
  | "branches"
  | "check"
  | "copy"
  | "error"
  | "link"
  | "play"
  | "plug"
  | "plus"
  | "restore"
  | "send"
  | "server"
  | "trash";

/** Choose a concrete receipt icon when the outcome names one. */
export function toastIconName(
  message: string,
  variant: "default" | "success" | "error",
): ToastIconName | null {
  if (variant === "error") return "error";
  if (/\barchived\b/i.test(message)) return "archive";
  if (/\b(reopened|restored)\b/i.test(message)) return "restore";
  if (/\bcopied\b/i.test(message)) return "copy";
  if (/\b(removed|forgotten|deleted)\b/i.test(message)) return "trash";
  if (/\b(connected|disconnected)\b/i.test(message)) return "plug";
  if (/\b(linked|unlinked)\b/i.test(message)) return "link";
  if (/\b(switched|moved|code mode)\b/i.test(message)) return "branches";
  if (/\b(created|added|registered)\b/i.test(message)) return "plus";
  if (/\brestarted\b/i.test(message)) return "server";
  if (/\bstarted\b/i.test(message)) return "play";
  if (/\bsent\b/i.test(message)) return "send";
  return variant === "success" ? "check" : null;
}
