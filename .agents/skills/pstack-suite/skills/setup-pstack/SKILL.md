---
name: setup-pstack
description: Explain and configure how pstack uses Open Session models and child sessions. Use for /setup-pstack, "configure pstack models", or changing pstack's delegation model choices.
disable-model-invocation: true
---

# Set up pstack for Open Session

Pstack requires no extension installation or host-global model file. The current session model is the lead. Child sessions inherit the platform default unless the caller passes an explicit configured model.

For a reusable lead-and-workers combination, use the workspace's **Model presets** settings. Configure a lead model, supporting models, and short instructions describing when each supporting model helps. Start new pstack sessions with that preset. Open Session exposes only policy-approved configured models and keeps the model choice attached to the session.

## Rules

- Never write or inspect host-global Pi directories, agent configuration, account files, or credentials.
- Never invent a model id. Use the model picker or the exact ids exposed by a policy-gated Open Session tool.
- Omit a child `model` to use normal inheritance and fallback behavior.
- Use different model families for independent judgment only when those models are already configured and the extra cost earns its place.
- A model preset changes routing, not permissions. Every child keeps the same repository, tool, credential, and run-kind boundaries.

Report the active session model or preset, whether explicit child models are needed, and the smallest workspace-preset change required. Do not create configuration files in the repository.
