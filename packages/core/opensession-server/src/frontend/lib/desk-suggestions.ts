/**
 * Starter prompts for the Desk's composer, shown as a scrolling pill row while
 * there's no conversation.
 *
 * Named after what the Desk can actually do — session status, archiving,
 * delegation, capture — rather than being generic assistant filler. The
 * trailing-ellipsis ones are deliberately unfinished: picking a pill fills the
 * composer instead of sending, so an opening you have to complete is a feature,
 * and the ones that name an action with side effects must never fire on a
 * single tap.
 *
 * Kept out of the component file so its module stays component-only (React
 * Fast Refresh); the native app carries its own copy in DeskSheet.swift.
 */
export const DESK_SUGGESTIONS = [
  "What's running?",
  "What needs me?",
  "Archive what's done",
  "What shipped today?",
  "Look into…",
  "Remind me to…",
];
