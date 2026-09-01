/**
 * Command policy — a semantic floor under every bash command an unattended run
 * issues, ported from yc-software/qm (MIT), src/policy/command-policy.ts.
 *
 * `deniedTools` is a name-level gate: it can strip `mcp__stripe__create_refund`
 * from a tool list, but nothing in that layer stops a bash call from running
 * `rm -rf`, force-pushing, or piping curl into sh — and unattended runs
 * (automations, Plain triage, the github behaviors) execute bash steered by
 * untrusted ticket/event text. This module closes that hole at the command
 * layer.
 *
 * The interesting part is not the rule list, it's `scannableCommand`: the
 * normalizer that runs BEFORE matching. A regex over the raw command string is
 * trivially evaded (`rm$IFS-rf`, `bash -c 'rm -rf x'`, `acme''cli`, ANSI-C
 * quoting, a heredoc piped to sh). The normalizer strips written heredocs but
 * keeps ones fed to a shell, unwraps quoting (bare words are unquoted so
 * word-boundary rules still see them; multi-word strings collapse to inert
 * quotes so DATA never matches), decodes ANSI-C escapes, extracts `$(…)` and
 * backtick substitutions, and recurses into every executed payload it can see
 * — `bash -c`, `eval`, `env -S`, `xargs`, wrapper chains (`EXEC_WRAPPERS`:
 * sudo/nice/timeout/time/nohup/stdbuf/command/builtin/exec/env), literal stdin
 * piped into a shell, here-strings, and simple `V=cmd; $V` indirection — to a
 * depth of 8.
 *
 * Enforcement wiring lives in pi-runner.ts: unattended code-mode runs
 * get a `bash: {"*": "ask"}` permission config, and the permission-ask bridge
 * answers each ask with `bashAskPolicyReply` below. Interactive runs are
 * untouched — the human at the keyboard is the authority there, and the only
 * always-deny rules (mkfs, fork bomb) never come up in honest work.
 *
 * This cannot be a security boundary against an adversarial MODEL — bash is
 * Turing-complete and a determined payload can always hide (`$IFS` splitting,
 * base64 self-decoding). It is a tripwire for the realistic failure: a
 * confused agent, or injected ticket text nudging one toward a destructive
 * one-liner. Defense in depth on top of worktree isolation, the minimal run
 * env, and the credential-scope containment.
 */
import { compileSafeRegex } from "./shared/safe-regex";
import { audit } from "./audit";

export type CommandDecision = "allow" | "deny" | "require_approval";

export interface CommandRule {
  pattern: string;
  decision: CommandDecision;
  reason?: string;
}

export interface CommandPolicy {
  mode: "denylist" | "allowlist";
  rules: CommandRule[];
}

/**
 * The org floor. qm's five rules plus one of our own (`git reset --hard` /
 * `git checkout .` — opensession automations run in the SHARED checkout, where a
 * rollback yanks the tree out from under the live server and every other
 * session; see CLAUDE.md's shared-checkout rules). First match wins, so an
 * allow carve-out added ABOVE a rule can widen it deliberately.
 *
 * `require_approval` means: an unattended run is refused (propose the command
 * in your note instead); an interactive run would surface a question card —
 * today interactive runs never generate bash asks, so the distinction is
 * latent. `deny` refuses everywhere, every mode.
 */
const ORG_FLOOR_RULES: CommandRule[] = [
  {
    pattern: "\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)",
    decision: "require_approval",
    reason: "recursive delete",
  },
  {
    pattern: "\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)",
    decision: "require_approval",
    reason: "force push",
  },
  {
    pattern: "\\bgit\\s+(?:reset\\s+--hard|checkout\\s+\\.(?:\\s|$))",
    decision: "require_approval",
    reason: "rollback in a possibly-shared checkout",
  },
  {
    pattern: "\\b(drop|truncate)\\s+table\\b",
    decision: "require_approval",
    reason: "destructive SQL",
  },
  {
    pattern: "\\bmkfs\\b|:\\(\\)\\s*\\{",
    decision: "deny",
    reason: "destructive / fork bomb",
  },
  {
    pattern: "\\bcurl\\b.*\\|\\s*(sh|bash)\\b",
    decision: "require_approval",
    reason: "pipe-to-shell",
  },
];

export function orgFloorPolicy(): CommandPolicy {
  return { mode: "denylist", rules: ORG_FLOOR_RULES };
}

export function scannableCommand(command: string): string {
  return scannableCommandAtDepth(command, 0);
}

function scannableCommandAtDepth(command: string, depth: number): string {
  const stripped = stripWrittenHeredocs(command);
  const base = stripped
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
      const subs = m.match(/\$\([^)]*\)|`[^`]*`/g);
      if (subs) return subs.join(" ");
      return unquoteBareWord(m.slice(1, -1)) ?? '""';
    })
    .replace(
      /\$'((?:[^'\\]|\\.)*)'/g,
      (_m, inner: string) => unquoteBareWord(decodeAnsiC(inner)) ?? "''",
    )
    .replace(/'[^']*'/g, (m) => unquoteBareWord(m.slice(1, -1)) ?? "''")
    .replace(/\\([\w@%+=:,./-])/g, "$1");
  if (depth >= 8) return base;
  const executed = executedShellPayloads(stripped);
  if (!executed.length) return base;
  return [
    base,
    ...executed.map((payload) => scannableCommandAtDepth(payload, depth + 1)),
  ].join("\n");
}

function stripWrittenHeredocs(command: string): string {
  return command.replace(
    /^([^\n]*)<<-?\s*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$/gm,
    (full, pre, _q, _delim, post) =>
      /[>]/.test(pre + post) && !heredocRunsShell(pre + post) ? "" : full,
  );
}

function heredocRunsShell(commandLine: string): boolean {
  const shells = /(?:^|[|;&]\s*)(?:\S*\/)?(?:ba|da|k|z)?sh((?:\s+[^|;&]*)?)/g;
  return [...commandLine.matchAll(shells)].some(
    (match) => !/(?:^|\s)-[^-\s]*c(?:\s|$)/.test(match[1] ?? ""),
  );
}

function decodeAnsiC(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCodePoint(Number.parseInt(octal, 8)),
    )
    .replace(
      /\\([\\'"abefnrtv])/g,
      (_, escape: string) =>
        ({
          a: "\x07",
          b: "\b",
          e: "\x1b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
          v: "\v",
        })[escape] ?? escape,
    );
}

function unquoteBareWord(inner: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(inner) ? inner : undefined;
}

export interface PublicationPolicy {
  repo: string;
  branch: string;
  headBranch: string;
}

/** Server-side floor for automation descendants. It permits publishing the
 * owned feature branch and updating its PR, but never merging, pushing the
 * protected base, or selecting another repository for a write. */
export function publicationPolicyDenyReason(
  command: string,
  policy: PublicationPolicy,
): string | undefined {
  const scan = scannableCommand(command);
  const shellCommands = scanShell(scan).commands;
  for (const words of shellCommands) {
    const gitIndex = words.indexOf("git");
    if (gitIndex >= 0) {
      let index = gitIndex + 1;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index++];
        if (
          ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(
            option,
          )
        )
          index++;
      }
      const subcommand = words[index];
      if (subcommand === "send-pack")
        return "automation descendants cannot use git send-pack";
      if (subcommand === "push") {
        const pushArgs = words.slice(index + 1);
        if (pushArgs.some((arg) => /^(?:https?:\/\/|git@|ssh:\/\/)/i.test(arg)))
          return "automation descendants cannot push to an external repository URL";
        const destinations = pushArgs.filter(
          (arg) => !arg.startsWith("-") && arg !== "origin",
        );
        const normalizedDestinations = destinations.map((arg) =>
          (arg.includes(":") ? arg.split(":").at(-1)! : arg).replace(
            /^refs\/heads\//,
            "",
          ),
        );
        if (normalizedDestinations.includes(policy.branch))
          return `automation descendants cannot push the protected base branch ${policy.branch}`;
        if (
          normalizedDestinations.length === 0 ||
          normalizedDestinations.some(
            (destination) => destination !== policy.headBranch,
          )
        )
          return `automation descendants may only push their owned branch ${policy.headBranch}`;
      }
    }
    const ghIndex = words.indexOf("gh");
    if (ghIndex >= 0) {
      for (let index = ghIndex + 1; index < words.length; index++) {
        const word = words[index];
        const inlineRepo = word.match(/^(?:--repo|-R)=(.+)$/)?.[1];
        const repo =
          inlineRepo ||
          (word === "--repo" || word === "-R" ? words[index + 1] : undefined);
        if (repo && repo !== policy.repo)
          return `automation descendants cannot write to repository ${repo}`;
      }
      if (words.includes("api"))
        return "automation descendants cannot use the general GitHub API";
      if (words.includes("pr") && words.includes("merge"))
        return "automation descendants cannot merge pull requests";
    }
  }
  const escapedBranch = policy.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(
      `\\bgit\\s+push\\b[^\\n]*(?:HEAD:|refs/heads/)?${escapedBranch}(?:\\s|$)`,
    ).test(scan)
  )
    return `automation descendants cannot push the protected base branch ${policy.branch}`;
  if (/\bgit\s+push\s+(?:https?:\/\/|git@|ssh:\/\/)/i.test(scan))
    return "automation descendants cannot push to an external repository URL";
  if (/\bgit\s+push\b/i.test(scan)) {
    const escapedHead = policy.headBranch.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const ownsDestination = new RegExp(
      `(?:HEAD:)?(?:refs/heads/)?${escapedHead}(?:\\s|$)`,
    ).test(scan);
    if (!ownsDestination)
      return `automation descendants may only push their owned branch ${policy.headBranch}`;
  }
  for (const match of scan.matchAll(
    /\bgh\b[^\n]*\s(?:--repo|-R)\s+([^\s]+)/g,
  )) {
    if (match[1] !== policy.repo)
      return `automation descendants cannot write to repository ${match[1]}`;
  }
  for (const match of scan.matchAll(
    /\bgh\s+api\s+[^\n]*\/repos\/([^/\s]+\/[^/\s]+)/g,
  )) {
    if (match[1] !== policy.repo)
      return `automation descendants cannot write to repository ${match[1]}`;
  }
  return undefined;
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

interface ShellScan {
  commands: string[][];
  nested: string[];
}

function scanShell(input: string): ShellScan {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let i = 0;
  const flush = () => {
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const commandSubstitution = (
    start: number,
  ): { body: string; end: number } | undefined => {
    let depth = 1;
    let quote = "";
    for (let j = start + 2; j < input.length; j++) {
      const c = input.charAt(j);
      if (c === "\\") {
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === "$" && input.charAt(j + 1) === "(") {
        depth++;
        j++;
      } else if (c === ")" && --depth === 0) {
        return { body: input.slice(start + 2, j), end: j + 1 };
      }
    }
    return undefined;
  };
  while (i < input.length) {
    if (/\s/.test(input.charAt(i))) {
      if (input.charAt(i) === "\n") flush();
      i++;
      continue;
    }
    if (input.charAt(i) === "#" && words.length === 0) {
      while (i < input.length && input.charAt(i) !== "\n") i++;
      continue;
    }
    if (";|&(){}".includes(input.charAt(i))) {
      flush();
      while (i < input.length && ";|&(){}".includes(input.charAt(i))) i++;
      continue;
    }
    let word = "";
    let wordStarted = false;
    while (
      i < input.length &&
      !/\s/.test(input.charAt(i)) &&
      (!";|&(){}".includes(input.charAt(i)) ||
        (input.charAt(i) === "&" && /[<>]$/.test(word)))
    ) {
      const c = input.charAt(i);
      if (c === "\\") {
        if (input.charAt(i + 1) === "\n") i += 2;
        else if (i + 1 < input.length) {
          wordStarted = true;
          word += input.charAt(i + 1);
          i += 2;
        } else i++;
        continue;
      }
      if (c === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 1);
        if (end < 0) {
          word += input.slice(i + 1);
          i = input.length;
        } else {
          word += input.slice(i + 1, end);
          i = end + 1;
        }
        continue;
      }
      if (c === "$" && input.charAt(i + 1) === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 2);
        if (end < 0) {
          word += input.slice(i + 2);
          i = input.length;
        } else {
          word += decodeAnsiC(input.slice(i + 2, end));
          i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        wordStarted = true;
        i++;
        while (i < input.length && input.charAt(i) !== '"') {
          if (input.charAt(i) === "\\" && i + 1 < input.length) {
            word += input.charAt(i + 1);
            i += 2;
          } else if (input.charAt(i) === "$" && input.charAt(i + 1) === "(") {
            const sub = commandSubstitution(i);
            if (!sub) {
              word += input.charAt(i++);
            } else {
              nested.push(sub.body);
              i = sub.end;
            }
          } else if (input.charAt(i) === "`") {
            const end = input.indexOf("`", i + 1);
            if (end < 0) i++;
            else {
              nested.push(input.slice(i + 1, end));
              i = end + 1;
            }
          } else word += input.charAt(i++);
        }
        if (input.charAt(i) === '"') i++;
        continue;
      }
      if (c === "$" && input.charAt(i + 1) === "(") {
        wordStarted = true;
        const sub = commandSubstitution(i);
        if (!sub) word += input.charAt(i++);
        else {
          nested.push(sub.body);
          i = sub.end;
        }
        continue;
      }
      if (c === "`") {
        wordStarted = true;
        const end = input.indexOf("`", i + 1);
        if (end < 0) i++;
        else {
          nested.push(input.slice(i + 1, end));
          i = end + 1;
        }
        continue;
      }
      word += c;
      wordStarted = true;
      i++;
    }
    if (wordStarted) words.push(word);
  }
  flush();
  return { commands, nested };
}

function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (
      /^[A-Za-z_]\w*=/.test(word) ||
      /^(?:if|then|elif|else|while|until|do|!)$/.test(word)
    )
      i++;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&)$/.test(word)) i += 2;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&).+/.test(word)) i++;
    else break;
  }
  return i;
}

function optionCommand(
  words: string[],
  start: number,
  valueOptions: Set<string>,
): number {
  let i = start;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") return i + 1;
    if (!word.startsWith("-") || word === "-") return i;
    const name = word.replace(/=.*/, "");
    if (valueOptions.has(name) && !word.includes("=")) i++;
  }
  return i;
}

function splitStringPayload(
  args: string[],
  split: number,
): { value: string | undefined; rest: string[] } {
  const arg = args[split]!;
  const compact = arg.startsWith("-S") && arg.length > 2;
  let value = args[split + 1];
  if (arg.includes("=")) value = arg.slice(arg.indexOf("=") + 1);
  else if (compact) value = arg.slice(2);
  const rest = args.slice(split + (arg.includes("=") || compact ? 1 : 2));
  return { value, rest };
}

/**
 * A transparent exec wrapper: it eats some of its own options and then hands
 * the remaining words to another command. Every question this module asks
 * about a command segment — does it read stdin as a shell, does it produce a
 * literal, where is its executable word, what payload does it execute — has to
 * peel the same chain before it can answer, so the chain is described once.
 *
 * Shells, `eval`, `xargs`, `coproc` and the `echo`/`printf` producers are
 * deliberately NOT wrappers: they mean different things to different questions.
 * Admitting `xargs` to the stdin question would gate commands whose stdin is
 * never shell-executed.
 */
interface ExecWrapper {
  /** Options whose value is a separate word, so that word is not the command. */
  valueOptions?: Set<string>;
  /** Operand words consumed before the command (timeout's duration). */
  skipOperands?: number;
  /** VAR=value words between the options and the command (env). */
  envAssignments?: boolean;
  /** `-S`/`--split-string`: what follows is a shell string, not an argv (env). */
  splitString?: boolean;
  /** Leading options after which the wrapper does not execute what follows. */
  abortOptions?: (option: string) => boolean;
}

const NO_VALUE_OPTIONS = new Set<string>();

const EXEC_WRAPPERS = new Map<string, ExecWrapper>([
  ["builtin", { abortOptions: () => true }],
  ["command", { abortOptions: (option) => option === "-v" || option === "-V" }],
  [
    "env",
    {
      valueOptions: new Set([
        "-u",
        "--unset",
        "-C",
        "--chdir",
        "-S",
        "--split-string",
      ]),
      envAssignments: true,
      splitString: true,
    },
  ],
  ["exec", { valueOptions: new Set(["-a"]) }],
  ["nice", { valueOptions: new Set(["-n", "--adjustment"]) }],
  ["nohup", {}],
  [
    "stdbuf",
    {
      valueOptions: new Set([
        "-i",
        "--input",
        "-o",
        "--output",
        "-e",
        "--error",
      ]),
    },
  ],
  [
    "sudo",
    {
      valueOptions: new Set([
        "-u",
        "--user",
        "-g",
        "--group",
        "-h",
        "--host",
        "-p",
        "--prompt",
        "-C",
        "--chdir",
        "-T",
        "--command-timeout",
        "-R",
        "--chroot",
        "-t",
        "--type",
      ]),
    },
  ],
  ["time", { valueOptions: new Set(["-o", "--output", "-f", "--format"]) }],
  [
    "timeout",
    {
      valueOptions: new Set(["-s", "--signal", "-k", "--kill-after"]),
      skipOperands: 1,
    },
  ],
]);

/** The wrapper names, for tests that want to sweep the whole registry. */
export const EXEC_WRAPPER_NAMES: readonly string[] = [...EXEC_WRAPPERS.keys()];

interface UnwrappedExec {
  /** The wrapped words, every wrapper peeled off. */
  inner: string[];
  /** Where `inner` starts in the words handed in — callers that need a position, not a slice. */
  offset: number;
  /** `env -S`: a shell string to execute, so there is no inner argv. */
  shellString?: string;
  /** The wrapper does not execute what follows (`command -v`, `builtin -x`). */
  aborted?: boolean;
}

function unwrapExec(words: string[]): UnwrappedExec {
  let inner = words;
  let offset = 0;
  for (;;) {
    const start = commandStart(inner);
    if (start >= inner.length) return { inner, offset };
    const executableWord = inner[start]!;
    const wrapper = EXEC_WRAPPERS.get(
      executableWord.split("/").pop() ?? executableWord,
    );
    if (!wrapper) return { inner, offset };
    const args = inner.slice(start + 1);
    if (wrapper.abortOptions) {
      for (const arg of args) {
        if (arg === "--" || arg === "-" || !arg.startsWith("-")) break;
        if (wrapper.abortOptions(arg.replace(/=.*/, "")))
          return { inner: [], offset, aborted: true };
      }
    }
    if (wrapper.splitString) {
      const split = args.findIndex(
        (arg) => arg.startsWith("-S") || arg.startsWith("--split-string"),
      );
      if (split >= 0) {
        const { value, rest } = splitStringPayload(args, split);
        if (value === undefined) return { inner: [], offset, aborted: true };
        return { inner: [], offset, shellString: [value, ...rest].join(" ") };
      }
    }
    let next =
      optionCommand(args, 0, wrapper.valueOptions ?? NO_VALUE_OPTIONS) +
      (wrapper.skipOperands ?? 0);
    if (wrapper.envAssignments)
      while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    offset += start + 1 + next;
    inner = args.slice(next);
  }
}

/** The `env -S` string as an argv, for the questions that ask about a command rather than a payload. */
function splitStringWords(shellString: string): string[] {
  return scanShell(shellString).commands[0] ?? [];
}

function executableName(words: string[], start: number): string {
  const word = words[start]!;
  return word.split("/").pop() ?? word;
}

function shellPipelines(input: string): string[][] {
  const pipelines: string[][] = [];
  let pipeline: string[] = [];
  let start = 0;
  let quote = "";
  const finishSegment = (end: number) => {
    const segment = input.slice(start, end).trim();
    if (segment) pipeline.push(segment);
  };
  const finishPipeline = (end: number) => {
    finishSegment(end);
    if (pipeline.length > 1) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if ((char === "|" || char === "&") && input.charAt(i + 1) === char) {
      finishPipeline(i);
      i++;
      start = i + 1;
      continue;
    }
    if (char === "|") {
      finishSegment(i);
      if (input.charAt(i + 1) === "&") i++;
      start = i + 1;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&") {
      finishPipeline(i);
      start = i + 1;
    }
  }
  finishPipeline(input.length);
  return pipelines;
}

function segmentConsumesShellStdin(words: string[]): boolean {
  const { inner, shellString, aborted } = unwrapExec(words);
  if (aborted) return false;
  if (shellString !== undefined)
    return segmentConsumesShellStdin(splitStringWords(shellString));
  const start = commandStart(inner);
  if (start >= inner.length) return false;
  if (
    !["bash", "sh", "dash", "zsh", "ksh"].includes(executableName(inner, start))
  )
    return false;
  const args = inner.slice(start + 1);
  const stdinScripts = new Set([
    "-",
    "/dev/stdin",
    "/dev/fd/0",
    "/proc/self/fd/0",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-[^-]*c/.test(arg)) return false;
    if (arg === "-s") return true;
    if (["-O", "-o", "--rcfile", "--init-file"].includes(arg)) {
      i++;
      continue;
    }
    if (arg === "--")
      return args[i + 1] === undefined || stdinScripts.has(args[i + 1]!);
    if (!arg.startsWith("-") || arg === "-") return stdinScripts.has(arg);
  }
  return true;
}

function literalProducerPayload(words: string[]): string | undefined {
  const { inner, shellString, aborted } = unwrapExec(words);
  if (aborted) return undefined;
  if (shellString !== undefined)
    return literalProducerPayload(splitStringWords(shellString));
  const start = commandStart(inner);
  if (start >= inner.length) return undefined;
  const executable = executableName(inner, start);
  let args = inner.slice(start + 1);
  if (args[0] === "--") args = args.slice(1);
  if (executable === "echo") {
    let decodeEscapes = false;
    while (/^-[neE]+$/.test(args[0] ?? "")) {
      for (const option of args[0]!.slice(1)) {
        if (option === "e") decodeEscapes = true;
        if (option === "E") decodeEscapes = false;
      }
      args = args.slice(1);
    }
    const payload = args.join(" ");
    return decodeEscapes ? decodeAnsiC(payload) : payload;
  }
  if (executable !== "printf" || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const rendered = decodeAnsiC(format!).replace(
    /%([%sb])/g,
    (_match, conversion: string) => {
      if (conversion === "%") return "%";
      const value = values[valueIndex++] ?? "";
      return conversion === "b" ? decodeAnsiC(value) : value;
    },
  );
  return [rendered, ...values.slice(valueIndex), args.join(" ")].join("\n");
}

function pipedShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  for (const pipeline of shellPipelines(input)) {
    for (let i = 1; i < pipeline.length; i++) {
      const consumer = scanShell(pipeline[i]!).commands[0];
      if (!consumer || !segmentConsumesShellStdin(consumer)) continue;
      const producerCommands = scanShell(pipeline[i - 1]!).commands;
      const producer = producerCommands.at(-1);
      if (!producer) continue;
      const payload = literalProducerPayload(producer);
      if (payload) payloads.push(payload);
    }
  }
  return payloads;
}

function hereStringShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  let spaced = "";
  let quote = "";
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === "\\") {
      spaced += input.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      spaced += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      spaced += char;
      continue;
    }
    if (input.startsWith("<<<", i)) {
      spaced += " <<< ";
      i += 2;
      continue;
    }
    spaced += char;
  }
  for (const words of scanShell(spaced).commands) {
    const redirect = words.indexOf("<<<");
    if (redirect <= 0 || !segmentConsumesShellStdin(words.slice(0, redirect)))
      continue;
    const payload = words[redirect + 1];
    if (payload) payloads.push(payload);
  }
  return payloads;
}

function simpleVariablePayloads(input: string): string[] {
  const values = new Map<string, string>();
  const payloads: string[] = [];
  const executableIndex = (words: string[]): number | undefined => {
    const { inner, offset, shellString, aborted } = unwrapExec(words);
    // A split string is a payload, not a word position — segmentShellPayloads
    // recurses into it instead.
    if (aborted || shellString !== undefined) return undefined;
    const start = commandStart(inner);
    if (start >= inner.length) return undefined;
    return offset + start;
  };
  for (const words of scanShell(input).commands) {
    const start = commandStart(words);
    if (start >= words.length) {
      for (const word of words) {
        const match = /^([A-Za-z_]\w*)=([\w./-]+)$/.exec(word);
        if (match) values.set(match[1]!, match[2]!);
      }
      continue;
    }
    const index = executableIndex(words);
    if (index === undefined) continue;
    const match = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(
      words[index]!,
    );
    const value = values.get(match?.[1] ?? match?.[2] ?? "");
    if (value)
      payloads.push(
        [...words.slice(0, index), value, ...words.slice(index + 1)].join(" "),
      );
  }
  return payloads;
}

function segmentShellPayloads(words: string[]): string[] {
  const { inner, shellString, aborted } = unwrapExec(words);
  if (aborted) return [];
  // `env -S 'rm -rf x'` executes the split string itself, so it IS the payload.
  if (shellString !== undefined) return [shellString];
  const start = commandStart(inner);
  if (start >= inner.length) return [];
  const executable = executableName(inner, start);
  const args = inner.slice(start + 1);
  if (["bash", "sh", "dash", "zsh", "ksh"].includes(executable)) {
    for (let j = 0; j < args.length; j++) {
      if (args[j] === "--" || !args[j]!.startsWith("-")) return [];
      if (["-O", "-o", "--rcfile", "--init-file"].includes(args[j]!)) {
        j++;
        continue;
      }
      if (/^-[^-]*c/.test(args[j]!))
        return args[j + 1] === undefined ? [] : [args[j + 1]!];
    }
    return [];
  }
  if (executable === "eval") return args.length ? [args.join(" ")] : [];
  if (executable === "coproc") return segmentShellPayloads(args);
  if (executable === "xargs") {
    const next = optionCommand(
      args,
      0,
      new Set([
        "-a",
        "--arg-file",
        "-d",
        "--delimiter",
        "-E",
        "--eof",
        "-I",
        "--replace",
        "-L",
        "--max-lines",
        "-n",
        "--max-args",
        "-P",
        "--max-procs",
        "-s",
        "--max-chars",
      ]),
    );
    return segmentShellPayloads(args.slice(next));
  }
  return [];
}

function executedShellPayloads(input: string): string[] {
  const scan = scanShell(input);
  return [
    ...scan.nested,
    ...scan.commands.flatMap(segmentShellPayloads),
    ...pipedShellPayloads(input),
    ...hereStringShellPayloads(input),
    ...simpleVariablePayloads(input),
  ];
}

function firstMatch(
  scannable: string,
  rules: readonly CommandRule[],
): CommandEvaluation | null {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = compileSafeRegex(rule.pattern, "i");
    } catch {
      console.error(
        `[command-policy] skipping invalid stored rule pattern ${JSON.stringify(rule.pattern)} (${rule.decision}) — re-save it to migrate`,
      );
      continue;
    }
    const hit = re.exec(scannable);
    if (hit) {
      return {
        decision: rule.decision,
        ...(rule.reason ? { reason: rule.reason } : {}),
        matched: hit[0],
        approvalKey: rule.pattern,
      };
    }
  }
  return null;
}

export function evaluateCommand(
  command: string,
  policy: CommandPolicy,
): CommandEvaluation {
  const matched = firstMatch(scannableCommand(command), policy.rules);
  if (matched) return matched;
  if (policy.mode === "allowlist") {
    return { decision: "deny", reason: "not in allowlist" };
  }
  return { decision: "allow" };
}

/**
 * Decide the reply to an pi bash permission ask, for BOTH permission
 * bridges in pi-runner.ts (master run + reattach — one decision, two
 * call sites). Returns null when the ask isn't bash or when the interactive
 * flow should keep handling it (surface a question card); a non-null reply is
 * final.
 *
 * `gated` marks the runs that carry the `bash: {"*": "ask"}` permission config
 * (unattended code-mode kinds) — for those, an "allow" verdict answers the ask
 * with "once", because the ask only exists as the policy's enforcement hook.
 * Non-gated unattended runs (config drift, ask-mode edge cases) keep their
 * historical auto-reject for anything the policy doesn't explicitly clear.
 *
 * Always "once", never "always": under a wildcard ask rule, an "always" reply
 * would allowlist the matched pattern for the rest of the session and every
 * later command would skip the bridge — the gate would evaporate after the
 * first approved call.
 */
export function bashAskPolicyReply(
  ask: {
    permission?: unknown;
    action?: unknown;
    metadata?: unknown;
    title?: unknown;
  },
  opts: {
    unattended: boolean;
    gated: boolean;
    sessionId?: string;
    runKind?: string;
  },
): "once" | "reject" | null {
  const kind = String(ask?.permission ?? ask?.action ?? "");
  if (kind !== "bash") return null;
  const meta = (ask?.metadata ?? {}) as { command?: unknown };
  const command = String(meta.command ?? ask?.title ?? "").trim();
  const verdict = command ? evaluateCommand(command, orgFloorPolicy()) : null;

  if (verdict && verdict.decision !== "allow") {
    audit({
      kind: "command_policy",
      session_id: opts.sessionId,
      run_kind: opts.runKind,
      decision: verdict.decision,
      reason: verdict.reason,
      matched: verdict.matched,
      command: command.slice(0, 300),
      unattended: opts.unattended,
    });
  }

  if (verdict?.decision === "deny") return "reject";
  if (!opts.unattended) {
    // Interactive: a deny already rejected above; require_approval and allow
    // both fall to the existing question-card flow, where the human decides.
    return null;
  }
  if (verdict?.decision === "require_approval") return "reject";
  // Unattended + allowed: only answer yes when this run's asks exist because
  // of the policy gate. An unreadable command (no metadata) fails closed.
  return opts.gated && verdict?.decision === "allow" ? "once" : "reject";
}
