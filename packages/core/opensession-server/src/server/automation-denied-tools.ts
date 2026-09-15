/**
 * The tool-permission denials every automation run carries — and every
 * interactive resume of an automation-owned session. Moved out of
 * automations.ts verbatim so the table can be READ without importing the
 * automations engine, which pulls in agent-runner, the sandbox providers and a
 * mkdir of the automations state dir. automations.ts imports it back and still
 * owns `automationDeniedTools()`, so every call site is unchanged.
 *
 * Every entry names an EXTERNAL MCP tool (Plain, WorkOS, incident.io).
 * In-process opensession-* tools are gated by WHICH SERVERS a run is wired
 * with (interactive-mcp.ts vs automations.ts), never by this list — see
 * docs/generated/mcp-tools.md, which is generated from both.
 */

// Automation runs are headless and often driven by untrusted text (e.g.
// customer ticket content), so they must stay read-only toward the customer:
// no replying to or changing the state of a Plain thread. Enforced at the
// tool-permission layer — prompt instructions alone don't constrain a run.
const PLAIN_WRITE_DENIAL =
  "This tool isn't available in automation runs — they are read-only toward the " +
  "customer thread. Put your suggested reply or status change in the internal " +
  "note (mcp__plain__create_note) for a human to act on instead.";
// WorkOS lookups (get_*/list_*) are fine for investigation, but its MCP also
// exposes destructive identity tools — creating/deleting users and orgs,
// revoking sessions, password resets, and especially impersonation URLs (login
// as the customer). Untrusted ticket text must never reach those, so deny the
// write/destructive subset at the tool layer and keep the read tools.
const WORKOS_WRITE_DENIAL =
  "This tool isn't available in automation runs — they get read-only WorkOS " +
  "access for investigation. Use get_*/list_* to look up the user/org; if a " +
  "change is needed, recommend it in the note for a human to do.";
// incident.io: a run may DECLARE (incident_create, which lands in triage with
// no severity for a human to accept) and read everything, but nothing else.
// The workspace API key carries broad roles, so the ceiling has to come from
// here: untrusted ticket text must not be able to close or rename someone
// else's incident, acknowledge a live page, or change response settings.
const INCIDENT_WRITE_DENIAL =
  "This tool isn't available in automation runs — they may declare an incident " +
  "(mcp__incident__incident_create, which starts in triage for a human to accept) " +
  "and read incident data, nothing more. Put anything else you want done in your " +
  "internal note or final report for a human to action.";
export const AUTOMATION_DENIED_TOOLS: Record<string, string> = {
  // Plain: read + internal note only, never customer-facing or state-changing
  mcp__plain__reply_to_thread: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_done: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_todo: PLAIN_WRITE_DENIAL,
  mcp__plain__snooze_thread: PLAIN_WRITE_DENIAL,
  // WorkOS: read-only — no identity mutation or impersonation from a run
  mcp__workos__create_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__create_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__create_user: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_user: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__update_user: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_session: WORKOS_WRITE_DENIAL,
  mcp__workos__send_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__send_password_reset_email: WORKOS_WRITE_DENIAL,
  mcp__workos__send_verification_email: WORKOS_WRITE_DENIAL,
  mcp__workos__get_impersonation_url: WORKOS_WRITE_DENIAL,
  // incident.io: declare + read only — no mutating anything else
  mcp__incident__incident_update: INCIDENT_WRITE_DENIAL,
  mcp__incident__follow_up_create: INCIDENT_WRITE_DENIAL,
  mcp__incident__follow_up_update: INCIDENT_WRITE_DENIAL,
  mcp__incident__escalation_respond: INCIDENT_WRITE_DENIAL,
  mcp__incident__alert_attach: INCIDENT_WRITE_DENIAL,
  mcp__incident__alert_detach: INCIDENT_WRITE_DENIAL,
  mcp__incident__investigation_steer: INCIDENT_WRITE_DENIAL,
  mcp__incident__investigation_sync: INCIDENT_WRITE_DENIAL,
  mcp__incident__extension_plugin_create: INCIDENT_WRITE_DENIAL,
  mcp__incident__extension_plugin_update: INCIDENT_WRITE_DENIAL,
  mcp__incident__extension_plugin_sync: INCIDENT_WRITE_DENIAL,
  mcp__incident__extension_skill_feedback_update: INCIDENT_WRITE_DENIAL,
};

// A Plain discussion session (Ask Sidekick → Open Session) is driven by a
// teammate, but the ticket text it reads is still untrusted, and the teammate
// only sees the discussion — a reply sent straight through the Plain MCP would
// be invisible to them until the customer answered, and a Stripe confirm card
// in the Open Session UI would never be seen at all. Customer-facing writes
// and money moves go through opensession-plain-discussion, whose tools park
// behind an Approve/Deny card in the discussion; everything the triage
// automation denies (identity and incident writes) stays denied here too.
const PLAIN_DISCUSSION_DENIAL =
  "This tool isn't available in a Plain discussion session. To reply to the " +
  "customer use reply_to_customer (opensession-plain-discussion), which shows " +
  "the teammate an Approve/Deny card in Plain; describe status changes in " +
  "your reply for the teammate to do.";
const PLAIN_DISCUSSION_MONEY_DENIAL =
  "Money-moving Stripe actions can't run directly in a Plain discussion " +
  "session. Propose the exact refund/cancellation in your reply and, when the " +
  "teammate asks for it, call execute_stripe_action " +
  "(opensession-plain-discussion): it shows them an Approve/Deny card and runs " +
  "the approved action in a dedicated execution turn.";
export const PLAIN_DISCUSSION_DENIED_TOOLS: Record<string, string> = {
  ...AUTOMATION_DENIED_TOOLS,
  mcp__plain__reply_to_thread: PLAIN_DISCUSSION_DENIAL,
  mcp__plain__mark_thread_done: PLAIN_DISCUSSION_DENIAL,
  mcp__plain__mark_thread_todo: PLAIN_DISCUSSION_DENIAL,
  mcp__plain__snooze_thread: PLAIN_DISCUSSION_DENIAL,
  mcp__stripe__create_refund: PLAIN_DISCUSSION_MONEY_DENIAL,
  mcp__stripe__cancel_subscription: PLAIN_DISCUSSION_MONEY_DENIAL,
  mcp__stripe__update_subscription: PLAIN_DISCUSSION_MONEY_DENIAL,
  mcp__stripe__stripe_api_execute: PLAIN_DISCUSSION_MONEY_DENIAL,
  mcp__stripe__stripe_api_write: PLAIN_DISCUSSION_MONEY_DENIAL,
};
export function plainDiscussionDeniedTools(): Record<string, string> {
  return PLAIN_DISCUSSION_DENIED_TOOLS;
}
