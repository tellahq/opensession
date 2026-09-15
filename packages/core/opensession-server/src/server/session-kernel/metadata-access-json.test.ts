import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  migrateSessionMetadataSchema33,
  seedSessionMetadataCatalog,
  settleSessionMetadataCatalog,
  sessionMetadataCatalogRead,
} from "./metadata-store";
import { migrateRepositoryCatalogSchema35 } from "./repository-access-store";

const ambiguous = [
  '{"id":"x","accessScope":{"kind":"shared"},"accessScope":{"kind":"personal","ownerGithubAccountId":101}}',
  '{"id":"x","accessScope":{"kind":"personal","ownerGithubAccountId":101},"accessScope":{"kind":"shared"}}',
  '{"id":"x","accessScope":{"kind":"shared","kind":"personal","ownerGithubAccountId":101}}',
  '{"id":"x","accessScope":{"kind":"personal","ownerGithubAccountId":202,"ownerGithubAccountId":101}}',
  String.raw`{"id":"x","accessScope":{"kind":"shared"},"access\u0053cope":{"kind":"personal","ownerGithubAccountId":101}}`,
];

for (const path of ["seed", "settle", "migration"] as const) {
  test(`${path} denies duplicate top-level/nested/escaped ownership keys`, () => {
    for (const doc of ambiguous) {
      const db = new Database(":memory:");
      try {
        migrateSessionMetadataSchema33(db, 0);
        if (path === "seed")
          seedSessionMetadataCatalog(db, [
            { sessionId: "x", doc, rev: 1, archived: false, lastActivityMs: 1 },
          ]);
        else if (path === "settle")
          settleSessionMetadataCatalog(db, "x", {
            sessionId: "x",
            doc,
            rev: 1,
            archived: false,
            lastActivityMs: 1,
            updatedAt: 1,
          });
        else {
          db.run(
            "INSERT INTO session_kernel_metadata_catalog(rowid, session_id, doc, rev, exported_rev, archived, last_activity_ms, updated_at) VALUES (-1, 'x', ?, 1, 1, 0, 1, 1)",
            [doc],
          );
          db.run(
            "INSERT INTO session_kernel_metadata VALUES ('x', ?, 1, 'seed', 0, 1, 1)",
            [doc],
          );
          migrateRepositoryCatalogSchema35(db, 33);
          expect(
            JSON.parse(
              (
                db.query("SELECT doc FROM session_kernel_metadata").get() as {
                  doc: string;
                }
              ).doc,
            ).accessScope,
          ).toBeNull();
        }
        for (const principal of [
          undefined,
          { githubAccountId: 101 },
          { githubAccountId: 202 },
        ])
          expect(sessionMetadataCatalogRead(db, "x", principal)).toEqual({
            status: "denied",
          });
      } finally {
        db.close();
      }
    }
  });
}

test("JSON numeric exponents and decimal integer encodings have identical JS/SQL scope", () => {
  for (const [encoding, id] of [
    ["1.0", 1],
    ["1e2", 100],
    ["101.00", 101],
  ] as const) {
    const db = new Database(":memory:");
    try {
      migrateSessionMetadataSchema33(db, 0);
      const doc = `{"id":"x","accessScope":{"kind":"personal","ownerGithubAccountId":${encoding}}}`;
      seedSessionMetadataCatalog(db, [
        { sessionId: "x", doc, rev: 1, archived: false, lastActivityMs: 1 },
      ]);
      expect(sessionMetadataCatalogRead(db, "x")).toEqual({ status: "denied" });
      const owner = sessionMetadataCatalogRead(db, "x", {
        githubAccountId: id,
      });
      expect(owner.status).toBe("found");
      if (owner.status === "found")
        expect(
          JSON.parse(owner.record.doc).accessScope.ownerGithubAccountId,
        ).toBe(id);
    } finally {
      db.close();
    }
  }
});
