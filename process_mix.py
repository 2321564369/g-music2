"""
process_mix.py
Runs in GitHub Actions when a `mixes` row is inserted.
Looks up YouTube Music's own "watch next" mix for the seed song, and
inserts one `requests` row per track (capped at track_limit) so the
existing per-song pipeline (process_request.py) picks each one up.

Required env vars:
  MIX_ID                - uuid of the row in the `mixes` table
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
"""

import os
import sys
from ytmusicapi import YTMusic
from supabase import create_client

MIX_ID = os.environ["MIX_ID"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
ytmusic = YTMusic()  # unauthenticated is fine for public watch playlists


def mark_failed(reason: str):
    supabase.table("mixes").update({"status": "failed"}).eq("id", MIX_ID).execute()
    print(f"Failed: {reason}")
    sys.exit(1)


def main():
    mix_row = supabase.table("mixes").select("*").eq("id", MIX_ID).single().execute().data
    seed_song = (
        supabase.table("songs").select("*").eq("id", mix_row["seed_song_id"]).single().execute().data
    )
    seed_video_id = seed_song["youtube_id"]
    track_limit = mix_row.get("track_limit", 8)

    supabase.table("mixes").update({"status": "processing"}).eq("id", MIX_ID).execute()

    watch_playlist = ytmusic.get_watch_playlist(videoId=seed_video_id, limit=track_limit + 1)
    tracks = watch_playlist.get("tracks", [])[1:]  # skip the seed song itself
    tracks = tracks[:track_limit]

    if not tracks:
        mark_failed("no mix tracks returned")

    for t in tracks:
        query = f"{t.get('artists', [{}])[0].get('name', '')} {t.get('title', '')}".strip()
        supabase.table("requests").insert(
            {"query": query, "status": "pending", "source": "mix", "mix_id": MIX_ID}
        ).execute()

    supabase.table("mixes").update({"status": "done"}).eq("id", MIX_ID).execute()
    print(f"Queued {len(tracks)} tracks for mix {MIX_ID}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        mark_failed(str(e))
