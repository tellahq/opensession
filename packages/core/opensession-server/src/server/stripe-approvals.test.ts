import { describe, expect, test } from "bun:test";
import {
  STRIPE_APPROVAL_SESSION_MARKER,
  guardStripeApprovalCall,
  recordStripeDraftInvoice,
  stampApprovalReason,
} from "./stripe-approvals";
import { runToolPolicy } from "./run-policy";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";

const URL = "https://os.example.test/session/os-abc";

describe("guardStripeApprovalCall", () => {
  const write = { server: "stripe", name: "stripe_api_write" };

  test("lets refunds through unchanged", () => {
    const args = {
      stripe_api_operation_id: "PostRefunds",
      parameters: { charge: "ch_1", amount: 1000 },
    };
    expect(guardStripeApprovalCall(write, args, URL)).toEqual(args);
  });

  test("rejects writes Stripe cannot hold for approval", () => {
    for (const op of [
      "PostCharges",
      "PostPaymentIntents",
      "PostSubscriptionsSubscriptionExposedId",
      "PostInvoicesInvoiceFinalize",
      "PostInvoicesInvoice",
      undefined,
    ])
      expect(() =>
        guardStripeApprovalCall(
          write,
          { stripe_api_operation_id: op, parameters: {} },
          URL,
        ),
      ).toThrow(/not allowed/);
    expect(() =>
      guardStripeApprovalCall(
        { server: "stripe", name: "stripe_api_execute" },
        { stripe_api_operation_id: "PostCustomers" },
        URL,
      ),
    ).toThrow(/not allowed/);
  });

  test("keeps created invoices drafts that cannot charge a card", () => {
    const create = (parameters: Record<string, unknown>) =>
      guardStripeApprovalCall(
        write,
        { stripe_api_operation_id: "PostInvoices", parameters },
        URL,
      );
    expect(
      create({
        customer: "cus_1",
        collection_method: "send_invoice",
        days_until_due: 0,
      }),
    ).toEqual({
      stripe_api_operation_id: "PostInvoices",
      parameters: {
        customer: "cus_1",
        collection_method: "send_invoice",
        days_until_due: 0,
        auto_advance: false,
      },
    });
    expect(() => create({ customer: "cus_1" })).toThrow(/send_invoice/);
    expect(() =>
      create({ customer: "cus_1", collection_method: "charge_automatically" }),
    ).toThrow(/send_invoice/);
    expect(() =>
      create({
        customer: "cus_1",
        collection_method: "send_invoice",
        auto_advance: true,
      }),
    ).toThrow(/auto_advance/);
  });

  test("adds invoice items only to a draft this run created", () => {
    const drafts = new Set<string>();
    const item = (invoice?: string) => ({
      stripe_api_operation_id: "PostInvoiceitems",
      parameters: { customer: "cus_1", amount: 2500, currency: "usd", invoice },
    });
    const created = (invoice: Record<string, unknown>) =>
      recordStripeDraftInvoice(
        write,
        { stripe_api_operation_id: "PostInvoices" },
        [{ type: "text", text: JSON.stringify(invoice) }],
        drafts,
      );

    expect(() => guardStripeApprovalCall(write, item(), URL, drafts)).toThrow(
      /draft invoice this run created/,
    );
    created({
      id: "in_charges",
      object: "invoice",
      status: "draft",
      collection_method: "charge_automatically",
    });
    created({
      id: "in_open",
      object: "invoice",
      status: "open",
      collection_method: "send_invoice",
    });
    created({
      id: "in_draft",
      object: "invoice",
      status: "draft",
      collection_method: "send_invoice",
    });
    expect([...drafts]).toEqual(["in_draft"]);
    for (const invoice of ["in_charges", "in_open", "in_other"])
      expect(() =>
        guardStripeApprovalCall(write, item(invoice), URL, drafts),
      ).toThrow(/draft invoice this run created/);
    expect(
      guardStripeApprovalCall(write, item("in_draft"), URL, drafts),
    ).toEqual(item("in_draft"));
  });

  test("stamps the session link onto approval-request reasons", () => {
    const out = guardStripeApprovalCall(
      write,
      {
        stripe_api_operation_id: "PostV2CoreApprovalRequestsId",
        parameters: { id: "apreq_1", reason: "Refund $10 test" },
      },
      URL,
    ) as { parameters: { reason: string; id: string } };
    expect(out.parameters.id).toBe("apreq_1");
    expect(out.parameters.reason).toBe(
      `Refund $10 test\n\n${STRIPE_APPROVAL_SESSION_MARKER} ${URL}`,
    );
  });

  test("leaves other servers and read tools alone", () => {
    const args = { stripe_api_operation_id: "PostCharges" };
    expect(
      guardStripeApprovalCall(
        { server: "acme", name: "stripe_api_write" },
        args,
        URL,
      ),
    ).toBe(args);
    expect(
      guardStripeApprovalCall(
        { server: "stripe", name: "stripe_api_read" },
        args,
        URL,
      ),
    ).toBe(args);
  });
});

describe("stampApprovalReason", () => {
  test("is idempotent and stays within Stripe's 1000 characters", () => {
    const once = stampApprovalReason("x".repeat(2000), URL);
    expect(once.length).toBeLessThanOrEqual(1000);
    expect(once.endsWith(URL)).toBe(true);
    expect(stampApprovalReason(once, URL)).toBe(once);
    expect(stampApprovalReason(undefined, URL)).toBe(
      `${STRIPE_APPROVAL_SESSION_MARKER} ${URL}`,
    );
  });
});

describe("runToolPolicy stripeApprovals", () => {
  const denied = Object.fromEntries(
    Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [name, "no money here"]),
  );

  test("strips every money mover when approvals are off", () => {
    const policy = runToolPolicy({
      deniedTools: denied,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      journalKind: "automation",
    });
    expect(policy.disables.stripe_stripe_api_write).toBe(false);
    expect(policy.disables.stripe_create_refund).toBe(false);
  });

  test("keeps the held tools for every run kind, never update_subscription", () => {
    for (const journalKind of ["prompt", "automation", "plain", "goal"]) {
      const policy = runToolPolicy({
        deniedTools: denied,
        confirmTools: STRIPE_CONFIRM_TOOLS,
        journalKind,
        stripeApprovals: true,
      });
      expect(policy.unattended).toBe(true);
      expect(policy.disables.stripe_stripe_api_write).toBeUndefined();
      expect(policy.disables.stripe_create_refund).toBeUndefined();
      expect(policy.disables.stripe_cancel_subscription).toBeUndefined();
      expect(policy.disables.stripe_update_subscription).toBe(false);
    }
  });
});
