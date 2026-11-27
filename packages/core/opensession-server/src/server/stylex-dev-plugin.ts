/**
 * StyleX for the OPENSESSION_DEV=1 HMR server. bunfig.toml lists this under
 * `[serve.static] plugins`, which is the one hook Bun's HTML-import dev server
 * offers; without it every `stylex.create` throws on load and the app renders
 * nothing. Production compiles through frontend-build.ts instead, with the
 * same transform (stylex-transform.ts).
 *
 * Each compiled file's rules are kept by path and the whole sheet is rewritten
 * to DEV_STYLEX_CSS, which /stylex.css serves (routes/static-assets.ts). A
 * reload picks up new rules; HMR swaps the JS but not that sheet.
 */
import type { BunPlugin } from "bun";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  STYLEX_REPO_ROOT,
  stylexCss,
  transformStylex,
  usesStylex,
  type StylexRule,
} from "./stylex-transform";

export const DEV_STYLEX_CSS = join(
  STYLEX_REPO_ROOT,
  ".frontend-dist",
  ".stylex-dev.css",
);

const rulesByFile = new Map<string, StylexRule[]>();
let writing: Promise<void> = Promise.resolve();

function writeSheet(): Promise<void> {
  writing = writing.then(async () => {
    const css = await stylexCss([...rulesByFile.values()].flat());
    await mkdir(dirname(DEV_STYLEX_CSS), { recursive: true });
    await writeFile(DEV_STYLEX_CSS, css);
  });
  return writing;
}

const plugin: BunPlugin = {
  name: "opensession-stylex-dev",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      if (!usesStylex(args.path, source)) return undefined;
      const { code, rules } = await transformStylex(args.path, source, "dev");
      rulesByFile.set(args.path, rules);
      await writeSheet();
      return {
        contents: code,
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

export default plugin;
