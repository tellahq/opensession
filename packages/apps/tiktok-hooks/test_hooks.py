"""Run with: python3 -m unittest packages/apps/tiktok-hooks/test_hooks.py"""

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ["TIKTOK_HOOKS_HOME"] = tempfile.mkdtemp(prefix="tiktok-hooks-test-")

import hooks


def memory_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(hooks.SCHEMA)
    return db


def video(video_id: str) -> dict:
    return {
        "id": video_id,
        "url": f"https://www.tiktok.com/@creator/video/{video_id}",
        "creator": "creator",
        "title": f"Video {video_id}",
    }


class HookExtractionTests(unittest.TestCase):
    def test_keeps_first_two_sentences(self):
        self.assertEqual(
            hooks.extract_hook(
                "This is a useful first sentence with a promise. "
                "This second sentence explains what comes next. Ignore this."
            ),
            "This is a useful first sentence with a promise. "
            "This second sentence explains what comes next.",
        )

    def test_adds_third_sentence_after_short_opening(self):
        self.assertEqual(
            hooks.extract_hook("Wait. Listen. This third sentence completes the hook."),
            "Wait. Listen. This third sentence completes the hook.",
        )

    def test_silent_video(self):
        self.assertEqual(hooks.extract_hook("   "), "No speech detected.")


class KindsTests(unittest.TestCase):
    def test_every_kind_has_label_and_description(self):
        for kind, meta in hooks.KINDS.items():
            self.assertRegex(kind, r"^[a-z-]+$")
            self.assertTrue(meta["label"])
            self.assertTrue(meta["description"])

    def test_other_is_the_fallback_kind(self):
        self.assertIn("other", hooks.KINDS)


class SelectionTests(unittest.TestCase):
    def test_skips_saved_and_exhausted_failures(self):
        db = memory_db()
        hooks.insert_hook(
            db,
            {
                **video("1"),
                "hook": "h",
                "transcript": "t",
                "language": "en",
                "source": "collection",
                "saved_at": "2026-09-11T00:00:00+00:00",
            },
        )
        for _ in range(hooks.MAX_FAILURE_ATTEMPTS):
            hooks.record_failure(db, video("2"), "boom")
        hooks.record_failure(db, video("3"), "flaky once")

        selected = hooks.select_unseen(db, [video(i) for i in "1234"], limit=10)

        self.assertEqual([v["id"] for v in selected], ["3", "4"])

    def test_reprocessing_preserves_classification(self):
        db = memory_db()
        original = {
            **video("1"),
            "hook": "Original hook",
            "transcript": "Original transcript",
            "language": "en",
            "source": "collection",
            "saved_at": "2026-09-11T00:00:00+00:00",
        }
        hooks.insert_hook(db, original)
        classification = ("question", "Set by hand in the dashboard", "2026-09-12")
        db.execute(
            "UPDATE hooks SET kind = ?, kind_reason = ?, classified_at = ? WHERE id = '1'",
            classification,
        )
        refreshed = {
            **original,
            "hook": "Refreshed hook",
            "transcript": "Refreshed transcript",
            "language": "fr",
            "source": "manual",
            "saved_at": "2026-09-13T00:00:00+00:00",
        }

        hooks.insert_hook(db, refreshed)

        row = db.execute("SELECT * FROM hooks WHERE id = '1'").fetchone()
        self.assertEqual(
            (row["kind"], row["kind_reason"], row["classified_at"]), classification
        )
        for field, value in refreshed.items():
            self.assertEqual(row[field], value)
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM hooks WHERE kind IS NULL").fetchone()[0], 0
        )

    def test_limit_bounds_a_run(self):
        db = memory_db()
        selected = hooks.select_unseen(db, [video(str(i)) for i in range(10)], limit=3)
        self.assertEqual(len(selected), 3)

    def test_success_clears_failure(self):
        db = memory_db()
        hooks.record_failure(db, video("9"), "boom")
        hooks.insert_hook(
            db,
            {
                **video("9"),
                "hook": "h",
                "transcript": "t",
                "language": None,
                "source": "manual",
                "saved_at": "2026-09-11T00:00:00+00:00",
            },
        )
        self.assertEqual(db.execute("SELECT COUNT(*) FROM failures").fetchone()[0], 0)


class EntryTests(unittest.TestCase):
    def test_flat_entry_without_url_gets_a_canonical_link(self):
        entry = hooks.video_from_entry({"id": 123, "title": "  Two   words ", "uploader": "@lou"})
        self.assertEqual(entry["url"], "https://www.tiktok.com/@_/video/123")
        self.assertEqual(entry["title"], "Two words")
        self.assertEqual(entry["creator"], "lou")

    def test_entry_without_id_is_dropped(self):
        self.assertIsNone(hooks.video_from_entry({"title": "x"}))


if __name__ == "__main__":
    unittest.main()
