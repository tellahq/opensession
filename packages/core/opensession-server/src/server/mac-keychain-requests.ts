import { z } from "zod";

// This store contains intent and fixed outcomes only, never credentials or API
// responses. Requests are deliberately ephemeral: a restart revokes all of them.
const printable = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+$/);

export const macKeychainRequestSchema = z
  .object({
    service: printable(300).describe(
      "Exact generic-password service name in macOS Keychain, not a 1Password reference.",
    ),
    account: printable(300).describe(
      "Exact account name of that Keychain item.",
    ),
    purpose: printable(240),
    url: printable(500)
      .url()
      .refine((s) => {
        try {
          const u = new URL(s);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.hash &&
            (!u.port || u.port === "443")
          );
        } catch {
          return false;
        }
      }, "Use an HTTPS URL without credentials, fragment, or custom port"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    injection: z.enum(["bearer", "x-api-key"]),
    body: z.string().max(512).optional(),
  })
  .strict()
  .refine((r) => !(r.body && ["GET", "HEAD"].includes(r.method)), {
    message: "GET and HEAD cannot have a body",
  });

export type MacKeychainIntent = z.infer<typeof macKeychainRequestSchema>;
export const macKeychainOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      httpStatus: z.number().int().min(100).max(599),
    })
    .strict(),
  z.object({ status: z.enum(["declined", "failed"]) }).strict(),
]);
type Outcome = z.infer<typeof macKeychainOutcomeSchema>;
type Record = {
  id: string;
  sessionId: string;
  login: string;
  intent: MacKeychainIntent;
  expiresAt: number;
  status: "pending" | "claimed" | Outcome["status"];
  claim?: string;
  httpStatus?: number;
};

export class MacKeychainRequests {
  private records = new Map<string, Record>();
  constructor(private now = Date.now) {}

  private prune() {
    for (const [id, r] of this.records) {
      if (r.expiresAt <= this.now()) this.records.delete(id);
    }
  }

  request(sessionId: string, login: string, input: unknown) {
    this.prune();
    if (!sessionId || !login)
      throw new Error("A verified teammate is required");
    const intent = macKeychainRequestSchema.parse(input);
    if (this.records.size >= 100) throw new Error("Too many pending requests");
    if (
      [...this.records.values()].some(
        (r) =>
          r.sessionId === sessionId &&
          ["pending", "claimed"].includes(r.status),
      )
    ) {
      throw new Error(
        "This session already has a pending macOS Keychain request",
      );
    }
    const record: Record = {
      id: crypto.randomUUID(),
      sessionId,
      login: login.toLowerCase(),
      intent,
      expiresAt: this.now() + 10 * 60_000,
      status: "pending",
    };
    this.records.set(record.id, record);
    return this.status(record.id, sessionId, login)!;
  }

  pending(sessionId: string, login: string) {
    this.prune();
    const r = [...this.records.values()].find(
      (r) =>
        r.sessionId === sessionId &&
        r.login === login.toLowerCase() &&
        r.status === "pending",
    );
    return r
      ? {
          id: r.id,
          sessionId: r.sessionId,
          login: r.login,
          intent: { ...r.intent },
          expiresAt: r.expiresAt,
        }
      : null;
  }

  // Claim is atomic and precedes the native helper invocation. A second Mac, retry, or
  // double-click cannot execute the same approval twice, even after failure.
  claim(id: string, login: string) {
    this.prune();
    const r = this.records.get(id);
    if (!r || r.login !== login.toLowerCase() || r.status !== "pending")
      return null;
    r.status = "claimed";
    r.claim = crypto.randomUUID();
    return { claim: r.claim };
  }

  finish(id: string, login: string, claim: string, input: unknown): boolean {
    this.prune();
    const outcome = macKeychainOutcomeSchema.safeParse(input);
    const r = this.records.get(id);
    if (
      !outcome.success ||
      !r ||
      r.login !== login.toLowerCase() ||
      r.status !== "claimed" ||
      r.claim !== claim
    )
      return false;
    r.status = outcome.data.status;
    if (outcome.data.status === "completed")
      r.httpStatus = outcome.data.httpStatus;
    delete r.claim;
    return true;
  }

  status(id: string, sessionId: string, login: string) {
    this.prune();
    const r = this.records.get(id);
    if (!r || r.sessionId !== sessionId || r.login !== login.toLowerCase())
      return null;
    // An explicit projection: neither the execution claim nor arbitrary Mac
    // output can enter an MCP result, transcript, or provider request.
    return {
      id: r.id,
      status: r.status,
      expiresAt: r.expiresAt,
      ...(r.httpStatus === undefined ? {} : { httpStatus: r.httpStatus }),
    };
  }
}

export const macKeychainRequests = new MacKeychainRequests();
