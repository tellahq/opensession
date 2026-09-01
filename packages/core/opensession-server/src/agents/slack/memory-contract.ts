import { z } from "zod";

export const MEMORY_SUMMARY_MAX_CHARS = 400;
export const MEMORY_PAGE_MAX = 50;

export const MemoryKindSchema = z.enum([
  "preference",
  "constraint",
  "decision",
  "gotcha",
  "reference",
  "status",
]);

export const MemoryScopeKindSchema = z.enum(["repo", "user", "team"]);

export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export type MemoryScopeKind = z.infer<typeof MemoryScopeKindSchema>;

function sentenceCount(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  return normalized.split(/[.!?]+(?:\s+|$)/).filter((part) => part.trim())
    .length;
}

export const MemorySummarySchema = z
  .string()
  .trim()
  .min(1, "summary is required")
  .max(
    MEMORY_SUMMARY_MAX_CHARS,
    `summary must be ${MEMORY_SUMMARY_MAX_CHARS} characters or fewer`,
  )
  .refine(
    (value) => sentenceCount(value) <= 2,
    "summary must be one or two sentences",
  );

const IsoDateSchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO 8601 timestamp with a timezone offset.");

export const StoreMemoryInputSchema = z
  .object({
    summary: MemorySummarySchema.describe(
      "One atomic, durable fact. Put supporting evidence in details.",
    ),
    kind: MemoryKindSchema.describe("What sort of durable knowledge this is."),
    scope: MemoryScopeKindSchema.describe(
      "Where future sessions should retrieve it.",
    ),
    repo: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Repo id for a repo-scoped memory. Defaults to the primary repo.",
      ),
    details: z
      .string()
      .trim()
      .max(20_000)
      .optional()
      .describe("Optional evidence or explanation. Never injected ambiently."),
    tags: z
      .array(z.string().trim().min(1).max(80))
      .max(12)
      .optional()
      .describe(
        "Searchable identifiers such as symbols, paths, flags, or product areas.",
      ),
    expiresAt: IsoDateSchema.optional().describe(
      "When a temporary status stops being current. Required for status memories.",
    ),
    supersedes: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe("Existing ids this record replaces."),
  })
  .superRefine((value, context) => {
    if (value.kind === "status" && !value.expiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "status memories require expiresAt",
      });
    }
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be in the future",
      });
    }
  });

export const MemoryListInputSchema = z.object({
  query: z.string().trim().max(500).optional(),
  kind: MemoryKindSchema.optional(),
  scope: MemoryScopeKindSchema.optional(),
  state: z.enum(["active", "archived", "expired", "all"]).optional(),
  review: z.enum(["needs_review", "confirmed", "all"]).optional(),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from the previous page."),
  limit: z.number().int().min(1).max(MEMORY_PAGE_MAX).optional(),
});

export const MemoryReadInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(20),
});

export const MemoryUpdateInputSchema = z
  .object({
    id: z.string().trim().min(1),
    summary: MemorySummarySchema.optional(),
    kind: MemoryKindSchema.optional(),
    details: z.string().trim().max(20_000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    expiresAt: IsoDateSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.summary !== undefined ||
      value.kind !== undefined ||
      value.details !== undefined ||
      value.tags !== undefined ||
      value.expiresAt !== undefined,
    "include at least one field to update",
  )
  .superRefine((value, context) => {
    if (value.kind === "status" && !value.expiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "status memories require expiresAt",
      });
    }
  });

export const MemoryIdsInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(50),
});

export const ForgetMemoryInputSchema = z.object({
  id: z.string().trim().min(1),
  confirm: z
    .literal(true)
    .describe("Must be true. Archive instead when recovery is useful."),
});

export function memoryContractError(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
    )
    .join("; ");
}
