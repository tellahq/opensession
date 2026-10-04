# Portable conversation context

Switching engines, forking without native conversation cloning, or replacing an
unresumable engine session transfers saved conversation context. Short histories
transfer intact. Longer histories favor the original request and recent requests
and answers, including partial assistant work. Selected messages preserve their
text, markdown, order and role. Command outcomes and file edits appear as compact
activity, not raw tool output. Provider reasoning and context injections are not
transferred.

This is a selection, not an agent-written summary. Omitted entries have ids and
short hints. The agent can resolve them with `opensession-sessions`
`read_session_transcript`, specifying the session id and `entry_id`. Long entries
are paginated using character `offset` and the returned `nextOffset`.

History uses at most a quarter of the target model's context window and 64,000
UTF-8 bytes. Unknown models use a conservative 128,000-token fallback. The bridge
also reserves capacity for the new request, instructions, tools and subsequent
work. These are conservative estimates, not a provider-tokenizer guarantee.
Your new request is never shortened to fit history. If retrieval references do
not fit, the handoff fails: choose a larger-context model or a smaller history
range. Native provider state, attachments and pending tool calls are not cloned.

## Contributor notes

`src/server/portable-handoff.ts` is the pure shared selection policy. Callers must
supply the **target** context window, not the outgoing model's window, and reserve
bytes for current input and existing context when available. Keep the actual new
request separate. A fallback that includes the current request in history must
mark its entry as required. Do not silently catch `HandoffBudgetError` and launch
with lost context. The entry reader follows `get_session` visibility and existing
MCP mount restrictions; never mount unrestricted session reads on automation
paths. Reads use targeted actor RPC, with async legacy recovery for that one
known session, never a fleet scan.

Prior art: t3code's portable handoff selection and resolvable-history references.
