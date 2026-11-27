/**
 * The bar across the top of each Support inbox column.
 *
 * The queue and the ticket beside it share one height, the app's own
 * `--desktop-header-h`, so the two columns and the sidebar's brand row all
 * start on one line. `wco-chrome` is what makes the row a drag region in the
 * desktop shell, which is why the box is drawn even when it has nothing in it:
 * a bar that came and went with the open ticket would take the window's top
 * edge with it, and the pane below would jump by its height.
 *
 * Shared because two components fill it. The queue puts its name and count
 * here; the open ticket puts its subject and customer here (ConversationPane's
 * `headerInBar`), which is why that pane draws its own copy rather than being
 * handed one.
 */
export const SUPPORT_COLUMN_BAR =
  "wco-chrome flex h-[var(--desktop-header-h)] shrink-0 items-center gap-2 " +
  "border-b border-divider px-4";

/**
 * Where the ticket's agent affordance floats: the offer to triage it, or the
 * session already working on it.
 *
 * It is a sibling of the scroll area, not a row in it, so the thread runs on
 * underneath — the same shape the transcript gives "Load all", which is why
 * the pills in it are that pill (in its opaque form: a support message runs
 * the full width of the column, so glass would show the words through). As a
 * block in the flow it was a full-width plate wedged between the last message
 * and the composer, which is a lot of furniture for one button and cut the
 * conversation off short of the box you answer it in.
 *
 * `pointer-events-none` so the thread under it stays selectable; each pill
 * turns them back on for itself. The thread pays for the space it occupies in
 * its own top padding, so nothing sits under the pill at rest.
 */
export const SUPPORT_TOP_RAIL =
  "pointer-events-none absolute top-3 left-1/2 z-5 flex max-w-[calc(100%-32px)] " +
  "-translate-x-1/2 flex-col items-center gap-1.5";
