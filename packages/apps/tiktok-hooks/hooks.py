#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["yt-dlp[default,curl-cffi]>=2026.8", "faster-whisper>=1.2"]
# ///
"""Pull TikTok opening hooks from a collection into the local SQLite store.

Subcommands: sync, add, pending, classify, stats. Run with `uv run --script`.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME_DIR = Path(
    os.environ.get("TIKTOK_HOOKS_HOME", Path.home() / ".local" / "share" / "tiktok-hooks")
)
COLLECTION_URL = os.environ.get(
    "TIKTOK_HOOKS_COLLECTION",
    "https://www.tiktok.com/@louisedesadeleer/collection/Hooks-7573794504407386912",
)
DB_PATH = HOME_DIR / "hooks.sqlite"
FRAMES_DIR = HOME_DIR / "frames"
COOKIES_PATH = HOME_DIR / "cookies.txt"
LOCK_PATH = HOME_DIR / "sync.lock"
KINDS = json.loads((HERE / "kinds.json").read_text())
SCHEMA = (HERE / "schema.sql").read_text()

MAX_TRANSCRIPT_SECONDS = 60
MAX_FAILURE_ATTEMPTS = 5
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
MIN_HOOK_WORDS = 12


class SyncError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def extract_hook(transcript: str) -> str:
    """First two spoken sentences, or three when the first two are unusually short."""
    text = " ".join(transcript.split())
    if not text:
        return "No speech detected."

    sentences = SENTENCE_END.split(text)
    hook = sentences[:2]
    if len(sentences) > 2 and len(" ".join(hook).split()) < MIN_HOOK_WORDS:
        hook = sentences[:3]
    return " ".join(hook).strip()


def open_db(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db


@contextmanager
def sync_lock():
    HOME_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SyncError("Another sync is already running.") from error
        yield


def run(command: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired as error:
        raise SyncError(f"Command timed out: {command[0]}") from error


def yt_dlp(*arguments: str) -> list[str]:
    command = [sys.executable, "-m", "yt_dlp", "--impersonate", "chrome"]
    if COOKIES_PATH.exists():
        command += ["--cookies", str(COOKIES_PATH)]
    return command + list(arguments)


def video_from_entry(entry: dict) -> dict | None:
    if not entry or not entry.get("id"):
        return None

    video_id = str(entry["id"])
    url = entry.get("webpage_url") or entry.get("url") or ""
    if not str(url).startswith("http"):
        url = f"https://www.tiktok.com/@_/video/{video_id}"
    return {
        "id": video_id,
        "title": " ".join((entry.get("title") or "").split()) or "Untitled TikTok",
        "creator": (entry.get("uploader") or entry.get("channel") or "unknown").lstrip("@"),
        "url": url,
    }


def list_collection(check_count: int) -> list[dict]:
    result = run(
        yt_dlp(
            "--flat-playlist",
            "--playlist-items",
            f"1:{check_count}",
            "--dump-single-json",
            COLLECTION_URL,
        ),
        timeout=180,
    )
    if result.returncode != 0:
        raise SyncError(f"Could not list the collection:\n{result.stderr[-800:]}")

    entries = json.loads(result.stdout).get("entries") or []
    videos = [video for video in map(video_from_entry, entries) if video]
    if not videos:
        hint = "" if COOKIES_PATH.exists() else f" (no cookie file at {COOKIES_PATH})"
        raise SyncError(f"TikTok returned an empty collection{hint}.")
    return videos


def inspect_url(url: str) -> dict:
    result = run(
        yt_dlp("--no-playlist", "--skip-download", "--dump-single-json", url), timeout=120
    )
    if result.returncode != 0:
        raise SyncError(f"Could not read that TikTok:\n{result.stderr[-800:]}")

    video = video_from_entry(json.loads(result.stdout))
    if not video:
        raise SyncError("TikTok returned no video metadata.")
    return video


def download(video: dict, destination: Path) -> Path:
    result = run(
        yt_dlp(
            "--no-playlist",
            "--format",
            "bv*+ba/b",
            "--merge-output-format",
            "mp4",
            "--remux-video",
            "mp4",
            "--output",
            str(destination / "video.%(ext)s"),
            video["url"],
        )
    )
    media = destination / "video.mp4"
    if result.returncode != 0 or not media.exists():
        raise SyncError(f"Download failed:\n{result.stderr[-600:]}")
    return media


def ffmpeg(*arguments: str) -> None:
    result = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments])
    if result.returncode != 0:
        raise SyncError(f"ffmpeg failed:\n{result.stderr[-400:]}")


def transcribe(model, audio: Path) -> tuple[str, str | None]:
    segments, info = model.transcribe(str(audio), beam_size=1)
    text = " ".join(segment.text.strip() for segment in segments)
    return " ".join(text.split()), info.language


def process(video: dict, model, workdir: Path, source: str) -> dict:
    safe_id = re.sub(r"[^0-9]", "", video["id"])
    if not safe_id:
        raise SyncError("TikTok returned an invalid video ID.")

    destination = workdir / safe_id
    destination.mkdir(parents=True, exist_ok=True)
    media = download(video, destination)
    frame = destination / "opening.jpg"
    audio = destination / "opening.wav"

    ffmpeg("-i", str(media), "-frames:v", "1", "-q:v", "2", str(frame))
    ffmpeg(
        "-i", str(media), "-t", str(MAX_TRANSCRIPT_SECONDS),
        "-vn", "-ac", "1", "-ar", "16000", str(audio),
    )
    transcript, language = transcribe(model, audio)

    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(frame, FRAMES_DIR / f"{safe_id}.jpg")
    return {
        **video,
        "id": safe_id,
        "hook": extract_hook(transcript),
        "transcript": transcript,
        "language": language,
        "source": source,
        "saved_at": now(),
    }


def insert_hook(db: sqlite3.Connection, hook: dict) -> None:
    db.execute(
        """INSERT INTO hooks
           (id, url, creator, title, hook, transcript, language, source, saved_at)
           VALUES (:id, :url, :creator, :title, :hook, :transcript, :language, :source, :saved_at)
           ON CONFLICT(id) DO UPDATE SET
             url = excluded.url,
             creator = excluded.creator,
             title = excluded.title,
             hook = excluded.hook,
             transcript = excluded.transcript,
             language = excluded.language,
             source = excluded.source,
             saved_at = excluded.saved_at""",
        hook,
    )
    db.execute("DELETE FROM failures WHERE id = ?", (hook["id"],))
    db.commit()


def record_failure(db: sqlite3.Connection, video: dict, error: str) -> None:
    db.execute(
        """INSERT INTO failures (id, url, error, attempts, last_attempt_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             error = excluded.error,
             attempts = attempts + 1,
             last_attempt_at = excluded.last_attempt_at""",
        (video["id"], video["url"], error, now()),
    )
    db.commit()


def select_unseen(db: sqlite3.Connection, videos: list[dict], limit: int) -> list[dict]:
    saved = {row["id"] for row in db.execute("SELECT id FROM hooks")}
    exhausted = {
        row["id"]
        for row in db.execute(
            "SELECT id FROM failures WHERE attempts >= ?", (MAX_FAILURE_ATTEMPTS,)
        )
    }
    unseen = [video for video in videos if video["id"] not in saved | exhausted]
    return unseen[:limit]


def load_model():
    from faster_whisper import WhisperModel

    return WhisperModel(
        os.environ.get("TIKTOK_HOOKS_WHISPER_MODEL", "base"),
        device="cpu",
        compute_type="int8",
    )


def process_all(db: sqlite3.Connection, videos: list[dict], source: str) -> tuple[int, int]:
    if not videos:
        return 0, 0

    model = load_model()
    completed = failed = 0
    with tempfile.TemporaryDirectory(prefix="tiktok-hooks-") as temporary:
        for video in videos:
            print(f"Processing @{video['creator']}: {video['title'][:70]}")
            try:
                insert_hook(db, process(video, model, Path(temporary), source))
                completed += 1
            except Exception as error:  # noqa: BLE001 — record and continue
                record_failure(db, video, str(error))
                failed += 1
                print(f"warning: {video['id']} failed: {error}", file=sys.stderr)
    return completed, failed


def command_sync(arguments: argparse.Namespace) -> int:
    with sync_lock():
        db = open_db()
        videos = select_unseen(db, list_collection(arguments.check_count), arguments.max)
        completed, failed = process_all(db, videos, "collection")

    print(f"Saved {completed} new hook(s), {failed} failed. Store: {DB_PATH}")
    return 1 if failed else 0


def command_add(arguments: argparse.Namespace) -> int:
    with sync_lock():
        db = open_db()
        video = inspect_url(arguments.url)
        if not arguments.force and db.execute(
            "SELECT 1 FROM hooks WHERE id = ?", (video["id"],)
        ).fetchone():
            print(f"Already saved: {video['id']}")
            return 0
        completed, failed = process_all(db, [video], "manual")

    print(f"Saved {completed} hook(s), {failed} failed. Store: {DB_PATH}")
    return 1 if failed else 0


def command_pending(_arguments: argparse.Namespace) -> int:
    db = open_db()
    rows = db.execute(
        "SELECT id, creator, title, hook, transcript, language FROM hooks "
        "WHERE kind IS NULL ORDER BY saved_at"
    ).fetchall()
    print(json.dumps([dict(row) for row in rows], indent=2, ensure_ascii=False))
    return 0


def command_classify(arguments: argparse.Namespace) -> int:
    if arguments.kind not in KINDS:
        sys.exit(f"error: unknown kind {arguments.kind!r}; choose from {', '.join(KINDS)}")

    db = open_db()
    updated = db.execute(
        "UPDATE hooks SET kind = ?, kind_reason = ?, classified_at = ? WHERE id = ?",
        (arguments.kind, arguments.reason, now(), arguments.id),
    ).rowcount
    db.commit()
    if not updated:
        sys.exit(f"error: no hook with id {arguments.id}")
    print(f"{arguments.id} → {arguments.kind}")
    return 0


def command_stats(_arguments: argparse.Namespace) -> int:
    db = open_db()
    total = db.execute("SELECT COUNT(*) FROM hooks").fetchone()[0]
    pending = db.execute("SELECT COUNT(*) FROM hooks WHERE kind IS NULL").fetchone()[0]
    by_kind = db.execute(
        "SELECT kind, COUNT(*) AS n FROM hooks WHERE kind IS NOT NULL GROUP BY kind ORDER BY n DESC"
    ).fetchall()
    failures = db.execute(
        "SELECT id, attempts, error FROM failures ORDER BY last_attempt_at DESC"
    ).fetchall()

    print(f"{total} hooks, {pending} unclassified, {len(failures)} failing")
    for row in by_kind:
        print(f"  {row['kind']:<14} {row['n']}")
    for row in failures:
        print(f"  failed {row['id']} ({row['attempts']}x): {row['error'].splitlines()[-1][:120]}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    sync = commands.add_parser("sync", help="import unseen collection videos")
    sync.add_argument("--check-count", type=int, default=200, help="newest entries to scan")
    sync.add_argument("--max", type=int, default=25, help="videos to process per run")
    sync.set_defaults(handler=command_sync)

    add = commands.add_parser("add", help="save one TikTok by URL")
    add.add_argument("url")
    add.add_argument("--force", action="store_true", help="reprocess an already-saved video")
    add.set_defaults(handler=command_add)

    commands.add_parser("pending", help="unclassified hooks as JSON").set_defaults(
        handler=command_pending
    )

    classify = commands.add_parser("classify", help="set a hook's kind")
    classify.add_argument("--id", required=True)
    classify.add_argument("--kind", required=True)
    classify.add_argument("--reason", default="")
    classify.set_defaults(handler=command_classify)

    commands.add_parser("stats", help="store summary").set_defaults(handler=command_stats)

    arguments = parser.parse_args()
    try:
        raise SystemExit(arguments.handler(arguments))
    except SyncError as error:
        sys.exit(f"error: {error}")


if __name__ == "__main__":
    main()
