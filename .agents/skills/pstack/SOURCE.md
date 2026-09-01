# Source and adaptation

This is the Open Session port of pstack's Poteto Mode and its complete 44-skill set.

Upstream sources:

- pstack by Lauren Tan and contributors: https://github.com/cursor/plugins/tree/main/pstack
- Pi-native port by Radical Tinker and contributors: https://github.com/kkgogogo17/pi-pstack

Both source projects are MIT licensed. The local port is based on `kkgogogo17/pi-pstack` commit `14da130e7aac196d355fa70706b06d5b4d71e095`.

Forty-two skills live under `../pstack-suite/skills/`. The remaining two retain established Open Session locations:

- `bro` is `../bro/SKILL.md` and is byte-equivalent to upstream.
- `poteto-mode` is `../poteto-mode/SKILL.md` and aliases this native sticky mode.

Open Session intentionally does not load the upstream Pi extension. Its behavior maps onto existing policy-enforced product surfaces:

| Upstream behavior | Open Session implementation |
| --- | --- |
| Sticky Poteto Mode | Native `/pstack` and `/poteto-mode` session state |
| Bundled subagents | Policy-gated durable child sessions with self-contained `/pstack` briefs |
| Role-to-model JSON | Session and workspace model presets |
| Extension todo tool | A short checklist or reviewable decision trail |
| Session-file lookup | Policy-gated session and history MCP tools |
| Shell confirmation hook | Guarded tools, scoped credentials, user authorization, and repository policy |

The port replaces Pi-only paths and tool names, preserves references and the safe decision-log helper, and keeps higher-priority Open Session security and repository instructions authoritative.
