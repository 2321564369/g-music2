"""
process_request.py
Runs inside a GitHub Actions job (or locally for testing).
Reads a search query + request id from env vars, downloads the top match,
uploads it to Supabase Storage, and records it in the songs table.

Required env vars:
  QUERY                 - search text, e.g. "Radiohead Karma Police"
  REQUEST_ID            - uuid of the row in the `requests` table
  SUPABASE_URL          - https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  - service_role key (NEVER the anon key, NEVER in browser code)
"""

import os
import re
import sys
import yt_dlp
import requests as http
from supabase import create_client

QUERY = os.environ["QUERY"]
REQUEST_ID = os.environ["REQUEST_ID"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

WORKDIR = "/tmp/galaxy-music"
os.makedirs(WORKDIR, exist_ok=True)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def clean_filename(name: str) -> str:
    name = "".join(c for c in name if c.isalnum() or c in " -_")
    return name.replace(" ", "_")[:100]


def mark_failed(reason: str):
    supabase.table("requests").update(
        {"status": "failed", "error": reason}
    ).eq("id", REQUEST_ID).execute()
    print(f"Failed: {reason}")
    sys.exit(1)


def main():
    supabase.table("requests").update({"status": "processing"}).eq(
        "id", REQUEST_ID
    ).execute()

    search_term = f"ytsearch1:{QUERY}"

    ydl_opts = {
        "format": "bestaudio/best",
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
        ],
        "outtmpl": os.path.join(WORKDIR, "%(id)s.%(ext)s"),
        "quiet": False,
        "noplaylist": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(search_term, download=True)
        entry = info["entries"][0] if "entries" in info else info

    video_id = entry["id"]
    title = re.sub(r"\(Official.*?\)|\[Lyrics\]|\(Lyrics\)", "", entry.get("title", "Unknown")).strip()
    artist = entry.get("uploader", "Unknown Artist")
    mp3_path = os.path.join(WORKDIR, f"{video_id}.mp3")

    if not os.path.exists(mp3_path):
        mark_failed("mp3 not produced by yt-dlp")

    base_filename = clean_filename(f"{artist} - {title}")

    # Upload audio
    with open(mp3_path, "rb") as f:
        supabase.storage.from_("songs").upload(
            f"{base_filename}.mp3", f, {"content-type": "audio/mpeg"}
        )
    audio_url = supabase.storage.from_("songs").get_public_url(f"{base_filename}.mp3")

    # Thumbnail (best effort, don't fail the whole job over it)
    cover_url = None
    thumb_url = entry.get("thumbnail")
    if thumb_url:
        try:
            img_bytes = http.get(thumb_url, timeout=10).content
            supabase.storage.from_("covers").upload(
                f"{base_filename}.jpg", img_bytes, {"content-type": "image/jpeg"}
            )
            cover_url = supabase.storage.from_("covers").get_public_url(f"{base_filename}.jpg")
        except Exception as e:
            print(f"Thumbnail skipped: {e}")

    supabase.table("songs").insert(
        {
            "filename": f"{base_filename}.mp3",
            "title": title,
            "artist": artist,
            "youtube_id": video_id,
            "storage_path": audio_url,
            "cover_path": cover_url,
        }
    ).execute()

    supabase.table("requests").update({"status": "done"}).eq("id", REQUEST_ID).execute()
    print(f"Done: {artist} - {title}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        mark_failed(str(e))
