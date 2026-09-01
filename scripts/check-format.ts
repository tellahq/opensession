import { join } from "node:path";

interface FormatConfig {
  ignorePatterns?: unknown;
}

const root = join(import.meta.dir, "..");
const config = (await Bun.file(
  join(root, ".oxfmtrc.json"),
).json()) as FormatConfig;
const ignorePatterns = Array.isArray(config.ignorePatterns)
  ? config.ignorePatterns.filter(
      (pattern): pattern is string => typeof pattern === "string",
    )
  : [];
const ignored = ignorePatterns.map((pattern) => new Bun.Glob(pattern));

const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
if (listed.exitCode !== 0) process.exit(listed.exitCode);

const files = listed.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter((path) => !ignored.some((pattern) => pattern.match(path)));

// Keep each invocation comfortably below the platform command-line limit.
for (let index = 0; index < files.length; index += 700) {
  const formatter = Bun.spawn(
    ["oxfmt", "--check", ...files.slice(index, index + 700)],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await formatter.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
