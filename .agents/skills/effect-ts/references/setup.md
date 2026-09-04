# Project Setup

## Table of Contents

- [Version pinning](#version-pinning)
- [Effect Language Service](#effect-language-service)
- [TypeScript Configuration](#typescript-configuration)
- [Module Settings by Project Type](#module-settings-by-project-type)
- [Source mirror](#source-mirror)
- [Development Workflow](#development-workflow)

## Version pinning

Pin `effect` and every `@effect/*` package to the same exact version; v4
releases them together. Open Session pins `4.0.0-rc.112` in
`packages/core/opensession-server/package.json`:

```json
"effect": "4.0.0-rc.112",
"@effect/atom-react": "4.0.0-rc.112",
"@effect/platform-browser": "4.0.0-rc.112"
```

No caret. RC releases rename APIs (`Config.string` became `Config.String`
right after rc.112), so a floating range silently breaks the build.

Browser bundles must import subpaths (`effect/Effect`, `effect/Schedule`,
`effect/unstable/reactivity/Atom`) rather than the `effect` barrel;
`lib/effect-imports.test.ts` enforces this.

## Effect Language Service

The Effect Language Service provides editor diagnostics and compile-time type checking. It catches errors TypeScript alone cannot detect.

### Install

```bash
bun add -d @effect/language-service
```

Add to `tsconfig.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/Effect-TS/language-service/refs/heads/main/schema.json",
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

The `$schema` field enables autocomplete and validation for plugin options.

### Editor Setup

Your editor must use the **workspace** TypeScript version.

**VS Code / Cursor:**

```json
// .vscode/settings.json
{
  "typescript.tsdk": "./node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
}
```

Then F1, "TypeScript: Select TypeScript version", "Use workspace version".

**JetBrains:** Settings, Languages & Frameworks, TypeScript, select workspace version.

### Build-Time Diagnostics

Patch TypeScript for CI enforcement:

```bash
bunx effect-language-service patch
```

Persist across installs:

```json
{
  "scripts": { "prepare": "effect-language-service patch" }
}
```

## TypeScript Configuration

### Key Settings

```jsonc
{
  "compilerOptions": {
    // Build performance
    "incremental": true,
    "composite": true,

    // Module system
    "target": "ES2022",
    "module": "NodeNext",
    "moduleDetection": "force",

    // Import handling
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,

    // Type safety
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUnusedLocals": true,
    "noImplicitOverride": true,

    // Development
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,

    // Effect
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

### Why These Settings

- **incremental + composite**: Fast rebuilds, monorepo project references
- **ES2022 + NodeNext**: Modern JS, proper ESM/CJS resolution
- **verbatimModuleSyntax**: Preserves `import type` exactly
- **rewriteRelativeImportExtensions**: Allows `.ts` in imports
- **strict + exactOptionalPropertyTypes**: Maximum type safety
- **skipLibCheck**: Faster builds (skip node_modules checking)

## Module Settings by Project Type

### Bundled Apps (Vite, Webpack, esbuild)

```jsonc
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "noEmit": true
  }
}
```

TypeScript acts as type-checker only. Bundler handles module transformation.

### Libraries and Node.js Apps

```jsonc
{
  "compilerOptions": {
    "module": "NodeNext"
  }
}
```

Required for npm packages, Node.js apps, and CLI tools. Enforces Node.js module resolution rules.

Additional library settings:

```jsonc
{
  "compilerOptions": {
    "declaration": true,
    "composite": true,
    "declarationMap": true
  }
}
```

**Rule of thumb:** Build tool compiling your code? Use `preserve` + `bundler`. TypeScript compiling your code? Use `NodeNext`.

## Source mirror

A repo-local shallow clone of the Effect monorepo at the pinned tag, excluded
from git through `.git/info/exclude`:

```bash
mkdir -p .agent-sources
git clone --depth 1 --branch effect@4.0.0-rc.112 https://github.com/Effect-TS/effect.git .agent-sources/effect
git -C .agent-sources/effect describe --tags   # must print effect@4.0.0-rc.112
```

Re-pin an existing mirror after a version bump:

```bash
git -C .agent-sources/effect fetch --depth 1 origin tag effect@<version>
git -C .agent-sources/effect checkout effect@<version>
```

What to read, in order:

| Path | Contents |
|---|---|
| `LLMS.md` | the Effect team's curated patterns (gen/fn, Context.Service, errors, resources, schedules) |
| `ai-docs/src/**/*.ts` | runnable examples per topic; the `@title` comment names them |
| `migration/*.md` | v3 to v4 rename tables (services, error-handling, forking, fiberref, schema) |
| `packages/effect/src/<Module>.ts` | signatures and JSDoc with `**When to use**` sections |
| `packages/effect/test/**` | how the maintainers test each module |
| `packages/platform/{bun,node,browser}/` | platform layers (`BunServices`, `NodeRuntime`, `BrowserSocket`) |

```bash
grep -rn "Schedule.while" .agent-sources/effect/ai-docs/src
grep -n "^export const retry" .agent-sources/effect/packages/effect/src/Effect.ts
grep -n "^export declare const retry:" node_modules/effect/dist/Effect.d.ts
```

The installed `node_modules/effect/dist/*.d.ts` is the final word for what
compiles; the mirror explains it.

## Development Workflow

In this repository: `bun test <path>` for focused runs, `bun run check` before
every commit (format, typecheck, lint, isolated unit tests, snapshots).

In the Effect monorepo (`.agent-sources/effect/.agents/AGENTS.md`):

```bash
pnpm lint-fix                     # lint and format
pnpm test --run <file>            # never bare `pnpm test` (watch mode)
pnpm check                        # type checking
pnpm test-types <file>            # type-level tests
pnpm codegen                      # regenerate @barrel sections of index.ts
```

### Testing conventions

- Here: `bun:test` with `Effect.runPromise(Effect.provide(program, TestClock.layer()))`.
- Effect monorepo and vitest projects: `it.effect` from `@effect/vitest`, with
  its `assert` helpers; tests live in `packages/*/test/`.
