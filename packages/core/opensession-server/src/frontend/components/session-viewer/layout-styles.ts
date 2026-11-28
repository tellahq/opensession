import * as stylex from "@stylexjs/stylex";

/** SessionViewer's own frame: a column the height of its pane, with the main
 *  region and side panel sharing the row under the dialogs. */
export const viewerLayout = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    height: "100%",
    minHeight: 0,
    flexDirection: "column",
  },
  body: { display: "flex", minHeight: 0, flex: "1" },
});
