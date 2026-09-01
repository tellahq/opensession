import { expect, test } from "bun:test";

const FRONTEND = new URL("..", import.meta.url).pathname;
const ROOT_IMPORT =
  /from\s+["'](?:effect|@effect\/atom-react|@effect\/platform-browser)["']/;

test("Effect packages use browser-size-safe subpath imports", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const violations: string[] = [];
  for await (const relative of glob.scan({ cwd: FRONTEND })) {
    const source = await Bun.file(`${FRONTEND}/${relative}`).text();
    if (ROOT_IMPORT.test(source)) violations.push(relative);
  }
  expect(violations).toEqual([]);
});
