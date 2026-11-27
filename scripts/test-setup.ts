import { afterAll } from "bun:test";
/** Bun-only preload: install a private home before any application module loads.
 * The per-file runner already owns a home; nested fixtures may intentionally
 * override it. Keep those overrides rather than re-isolating each subprocess.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEnvironment } from "./test-isolated";
import {
  transformStylex,
  usesStylex,
} from "../packages/core/opensession-server/src/server/stylex-transform";

// StyleX has no runtime: a component that calls `stylex.create` throws on
// import unless the compile step rewrote it. Tests run it in StyleX's `test`
// mode, which keeps class names stable and emits no CSS.
Bun.plugin({
  name: "opensession-stylex-test",
  setup(build) {
    build.onLoad({ filter: /\/src\/frontend\/.*\.tsx?$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      if (!usesStylex(args.path, source)) {
        return {
          contents: source,
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      }
      const { code } = await transformStylex(args.path, source, "test");
      return {
        contents: code,
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
});

if (!process.env.OPENSESSION_TEST_ISOLATED_HOME) {
  const home = mkdtempSync(join(tmpdir(), "os-unit-"));
  const env = testEnvironment(home, process.env);
  mkdirSync(env.TMPDIR!, { recursive: true });
  writeFileSync(env.OPENSESSION_CONFIG!, "{}\n");
  const current = process.env as Record<string, string | undefined>;
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, env);
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  // Bun's normal test completion does not emit process.exit. A preload's
  // afterAll runs once, after all files; exit also covers explicit exits.
  afterAll(cleanup);
  process.on("exit", cleanup);
}
