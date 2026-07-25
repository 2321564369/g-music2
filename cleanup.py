"""
cleanup.py
Run on a schedule (see cleanup.yml). Deletes songs that are past the TTL
and are not liked and not in any playlist, from both Storage and the DB.

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  TTL_HOURS  (optional, default 1)
"""

import os
from datetime import datetime, timedelta, timezone
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
TTL_HOURS = float(os.environ.get("TTL_HOURS", 1))

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def main():
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=TTL_HOURS)).isoformat()

    old_songs = (
        supabase.table("songs").select("*").lt("uploaded_at", cutoff).execute().data
    )
    liked_ids = {row["song_id"] for row in supabase.table("likes").select("song_id").execute().data}

    # Only real, user-made playlists protect a song from cleanup. Auto-generated
    # mix playlists (named "Mix — <song>") don't count — mixes are meant to be
    # temporary listening sessions, not permanent collections.
    playlist_rows = (
        supabase.table("playlist_songs").select("song_id, playlists(name)").execute().data
    )
    playlisted_ids = {
        row["song_id"]
        for row in playlist_rows
        if row.get("playlists") and not row["playlists"]["name"].startswith("Mix — ")
    }

    keep_ids = liked_ids | playlisted_ids

    deleted = 0
    for song in old_songs:
        if song["id"] in keep_ids:
            continue
        try:
            supabase.storage.from_("songs").remove([song["filename"]])
            if song.get("cover_path"):
                cover_name = song["filename"].replace(".mp3", ".jpg")
                supabase.storage.from_("covers").remove([cover_name])
        except Exception as e:
            print(f"Storage delete failed for {song['filename']}: {e}")
        supabase.table("songs").delete().eq("id", song["id"]).execute()
        deleted += 1

    print(f"Cleanup done. Checked {len(old_songs)}, deleted {deleted}, kept {len(old_songs) - deleted}.")


if __name__ == "__main__":
    main()
