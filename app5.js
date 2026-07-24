// ============================================================
// Galaxy Music — app.js
// Supabase-backed player: library, likes, playlists, search->request,
// live song feed, mixes. Requires config.js (SUPABASE_URL/ANON_KEY)
// loaded before this file, and the Supabase JS CDN script.
// ============================================================


const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- State ----------
let songs = [];                 // all songs from the songs table
let likedIds = new Set();       // song ids the user has liked
let playlists = [];             // [{id, name}]
let playlistSongIds = {};       // { playlistId: Set(songId) }
let activeRequests = [];        // pending/processing rows from requests table

let currentView = "all";        // all | artists | liked | playlist
let currentPlaylistId = null;
let currentArtist = null;

let searchQuery = "";
let sortMode = "none";
let searchResults = [];         // live YouTube results for the current query
let searching = false;
let searchDebounceTimer = null;
let pendingPlay = null;         // { youtube_id, title, artist, thumbnail } — auto-play once it lands in songs

let queue = [];                 // ordered list of song ids for current context
let currentIndex = -1;
let shuffleOn = false;
let autoplayOn = true;

let pendingAddSongId = null;
let pendingDeletePlaylistId = null;

const audio = document.getElementById("audio");
let audioCtx = null, analyser = null, sourceNode = null;

// ============================================================
// Init
// ============================================================

async function init() {
  setConnectionStatus(navigator.onLine);
  window.addEventListener("online", () => setConnectionStatus(true));
  window.addEventListener("offline", () => setConnectionStatus(false));

  buildBeatVisualizer();
  bindAudioEvents();
  bindSliderEvents();

  await Promise.all([loadSongs(), loadLikes(), loadPlaylists(), loadActiveRequests()]);
  renderPlaylistSidebar();
  renderCurrentView();
  renderRequestQueue();

  subscribeRealtime();
}

async function loadSongs() {
  const { data, error } = await sb.from("songs").select("*").order("uploaded_at", { ascending: false });
  if (error) { toast("Couldn't load songs: " + error.message, "error"); return; }
  songs = data || [];
}

async function loadLikes() {
  const { data, error } = await sb.from("likes").select("song_id");
  if (error) return;
  likedIds = new Set((data || []).map((r) => r.song_id));
}

async function loadPlaylists() {
  const { data, error } = await sb.from("playlists").select("*").order("created_at");
  if (error) return;
  playlists = data || [];

  const { data: links } = await sb.from("playlist_songs").select("*");
  playlistSongIds = {};
  for (const p of playlists) playlistSongIds[p.id] = new Set();
  for (const row of links || []) {
    if (!playlistSongIds[row.playlist_id]) playlistSongIds[row.playlist_id] = new Set();
    playlistSongIds[row.playlist_id].add(row.song_id);
  }
}

async function loadActiveRequests() {
  const { data, error } = await sb
    .from("requests")
    .select("*")
    .in("status", ["pending", "processing"])
    .order("requested_at", { ascending: false });
  if (error) return;
  activeRequests = data || [];
}

// ============================================================
// Realtime
// ============================================================

function subscribeRealtime() {
  sb
    .channel("songs-feed")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "songs" }, (payload) => {
      songs.unshift(payload.new);
      toast(`Added: ${payload.new.artist} - ${payload.new.title}`, "success");

      if (pendingPlay && payload.new.youtube_id === pendingPlay.youtube_id) {
        pendingPlay = null;
        queue = [payload.new.id, ...queue.filter((id) => id !== payload.new.id)];
        playSong(payload.new.id);
      }

      renderCurrentView();
    })
    .subscribe();

  sb
    .channel("requests-feed")
    .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, (payload) => {
      if (payload.eventType === "INSERT" && ["pending", "processing"].includes(payload.new.status)) {
        activeRequests.unshift(payload.new);
      } else if (payload.eventType === "UPDATE") {
        const idx = activeRequests.findIndex((r) => r.id === payload.new.id);
        if (["done", "failed"].includes(payload.new.status)) {
          if (payload.new.status === "failed") {
            toast(`Couldn't find a match for "${payload.new.query}"`, "error");
          }
          if (idx !== -1) activeRequests.splice(idx, 1);
        } else if (idx !== -1) {
          activeRequests[idx] = payload.new;
        }
      }
      renderRequestQueue();
    })
    .subscribe();
}

// ============================================================
// View switching
// ============================================================

function setActiveNav(id) {
  document.querySelectorAll("#playlists li, #userPlaylists li").forEach((li) => li.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function loadAll() {
  currentView = "all";
  currentArtist = null;
  setActiveNav("allSongsLi");
  document.getElementById("viewTitle").textContent = "All Songs";
  renderCurrentView();
}

function loadArtists() {
  currentView = "artists";
  currentArtist = null;
  setActiveNav("artistsLi");
  document.getElementById("viewTitle").textContent = "Artists";
  renderCurrentView();
}

function loadLiked() {
  currentView = "liked";
  currentArtist = null;
  setActiveNav("likedLi");
  document.getElementById("viewTitle").textContent = "Liked";
  renderCurrentView();
}

function loadPlaylist(id) {
  currentView = "playlist";
  currentPlaylistId = id;
  const p = playlists.find((pl) => pl.id === id);
  setActiveNav("playlist-li-" + id);
  document.getElementById("viewTitle").textContent = p ? p.name : "Playlist";
  renderCurrentView();
}

// ============================================================
// Rendering
// ============================================================

function getFilteredSongs() {
  let list = songs;

  if (currentView === "liked") {
    list = list.filter((s) => likedIds.has(s.id));
  } else if (currentView === "playlist") {
    const ids = playlistSongIds[currentPlaylistId] || new Set();
    list = list.filter((s) => ids.has(s.id));
  }

  if (sortMode === "artist") {
    list = [...list].sort((a, b) => (a.artist || "").localeCompare(b.artist || ""));
  } else if (sortMode === "album") {
    list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  return list;
}

function renderCurrentView() {
  sortMode = document.getElementById("sortSelect").value;
  const container = document.getElementById("songList");

  if (searchQuery.trim()) {
    renderSearchResults(container);
    return;
  }

  if (currentView === "artists" && !currentArtist) {
    renderArtistsGrid(container);
    return;
  }

  if (currentView === "artists" && currentArtist) {
    renderArtistDetail(container);
    return;
  }

  const list = getFilteredSongs();

  if (list.length === 0 && activeRequests.length === 0) {
    container.innerHTML = `<div class="empty"><p>Nothing here yet.</p></div>`;
    queue = [];
    return;
  }

  container.innerHTML = "";
  for (const song of list) container.appendChild(renderSongRow(song));

  // ghost rows for in-flight requests while browsing All Songs (not searching)
  if (currentView === "all") {
    for (const req of activeRequests) container.appendChild(renderGhostRow(req));
  }

  queue = list.map((s) => s.id);
}

function renderSearchResults(container) {
  document.getElementById("requestPrompt").style.display = "none";

  if (searching && searchResults.length === 0) {
    container.innerHTML = `<div class="empty"><p>Searching YouTube Music...</p></div>`;
    return;
  }
  if (searchResults.length === 0) {
    container.innerHTML = `<div class="empty"><p>No results for "${escapeHtml(searchQuery)}".</p></div>`;
    return;
  }

  container.innerHTML = "";
  for (const result of searchResults) container.appendChild(renderSearchResultRow(result));
  queue = [];
}

function renderSearchResultRow(result) {
  const cached = songs.find((s) => s.youtube_id === result.youtube_id);
  const isPending = pendingPlay && pendingPlay.youtube_id === result.youtube_id;

  const div = document.createElement("div");
  div.className = "song search-result";
  div.onclick = (e) => {
    if (e.target.closest(".songControls")) return;
    playSearchResult(result, cached);
  };

  const thumbStyle = result.thumbnail ? `background-image:url('${result.thumbnail}')` : "";
  const liked = cached && likedIds.has(cached.id);

  div.innerHTML = `
    <div class="thumb" style="${thumbStyle}">${isPending ? '<div class="mini-spinner"></div>' : ""}</div>
    <div class="songInfo">
      <div class="songTitle">${escapeHtml(result.title)}</div>
      <div class="songMeta">${escapeHtml(result.artist)}${cached ? " · downloaded" : ""}</div>
    </div>
    <div class="songControls">
      ${cached ? `<button class="likeBtn ${liked ? "liked" : ""}" title="Like"></button><button class="addBtn" title="Add to playlist">+</button>` : ""}
    </div>
  `;

  if (cached) {
    div.querySelector(".likeBtn").onclick = (e) => { e.stopPropagation(); toggleLikeSong(cached.id); };
    div.querySelector(".addBtn").onclick = (e) => { e.stopPropagation(); openAddToPlaylistModal(cached.id); };
  }

  return div;
}

function renderSongRow(song) {
  const div = document.createElement("div");
  div.className = "song";
  if (queue[currentIndex] === song.id && !audio.paused) div.classList.add("playing");
  div.onclick = (e) => {
    if (e.target.closest(".songControls")) return;
    playSong(song.id);
  };

  const thumbStyle = song.cover_path ? `background-image:url('${song.cover_path}')` : "";
  const liked = likedIds.has(song.id);

  div.innerHTML = `
    <div class="thumb" style="${thumbStyle}"></div>
    <div class="songInfo">
      <div class="songTitle">${escapeHtml(song.title || song.filename)}</div>
      <div class="songMeta">${escapeHtml(song.artist || "Unknown Artist")}</div>
    </div>
    <div class="songControls">
      <button class="likeBtn ${liked ? "liked" : ""}" title="Like"></button>
      <button class="addBtn" title="Add to playlist">+</button>
    </div>
  `;

  div.querySelector(".likeBtn").onclick = (e) => {
    e.stopPropagation();
    toggleLikeSong(song.id);
  };
  div.querySelector(".addBtn").onclick = (e) => {
    e.stopPropagation();
    openAddToPlaylistModal(song.id);
  };

  return div;
}

function renderGhostRow(req) {
  const div = document.createElement("div");
  div.className = "song ghost";
  div.innerHTML = `
    <div class="thumb"><div class="mini-spinner"></div></div>
    <div class="songInfo">
      <div class="songTitle">${escapeHtml(req.query)}</div>
      <div class="songMeta">${req.status === "processing" ? "Downloading..." : "Queued..."}</div>
    </div>
  `;
  return div;
}

function renderArtistsGrid(container) {
  const byArtist = {};
  for (const s of songs) {
    const a = s.artist || "Unknown Artist";
    if (!byArtist[a]) byArtist[a] = [];
    byArtist[a].push(s);
  }
  const names = Object.keys(byArtist).sort();

  if (names.length === 0) {
    container.innerHTML = `<div class="empty"><p>No artists yet — search for a song to get started.</p></div>`;
    return;
  }

  const grid = document.createElement("div");
  grid.className = "artists-grid";
  for (const name of names) {
    const card = document.createElement("div");
    card.className = "artist-card";
    card.onclick = () => {
      currentArtist = name;
      renderCurrentView();
    };
    card.innerHTML = `
      <div class="artist-avatar">${escapeHtml(name[0] || "?").toUpperCase()}</div>
      <div class="artist-name">${escapeHtml(name)}</div>
      <div class="artist-song-count">${byArtist[name].length} song${byArtist[name].length === 1 ? "" : "s"}</div>
      <div class="artist-play-icon">▶</div>
    `;
    grid.appendChild(card);
  }
  container.innerHTML = "";
  container.appendChild(grid);
}

function renderArtistDetail(container) {
  const list = songs.filter((s) => (s.artist || "Unknown Artist") === currentArtist);
  container.innerHTML = "";

  const back = document.createElement("div");
  back.className = "back-to-artists";
  back.textContent = "← Back to Artists";
  back.onclick = () => { currentArtist = null; renderCurrentView(); };
  container.appendChild(back);

  const header = document.createElement("div");
  header.className = "artist-detail-header";
  header.innerHTML = `
    <div class="artist-detail-avatar">${escapeHtml(currentArtist[0] || "?").toUpperCase()}</div>
    <div class="artist-detail-info">
      <div class="artist-name">${escapeHtml(currentArtist)}</div>
      <div class="artist-song-count">${list.length} song${list.length === 1 ? "" : "s"}</div>
      <button class="artist-play-all">▶ Play all</button>
    </div>
  `;
  header.querySelector(".artist-play-all").onclick = () => {
    queue = list.map((s) => s.id);
    playSong(queue[0]);
  };
  container.appendChild(header);

  const wrap = document.createElement("div");
  wrap.className = "songs-list";
  for (const song of list) wrap.appendChild(renderSongRow(song));
  container.appendChild(wrap);

  queue = list.map((s) => s.id);
}

function renderPlaylistSidebar() {
  const ul = document.getElementById("userPlaylists");
  ul.innerHTML = "";
  for (const p of playlists) {
    const li = document.createElement("li");
    li.className = "playlist-item";
    li.id = "playlist-li-" + p.id;
    li.innerHTML = `
      <span class="playlist-name" onclick="loadPlaylist('${p.id}')">${escapeHtml(p.name)}</span>
      <button class="delete-playlist-btn" title="Delete playlist">🗑</button>
    `;
    li.querySelector(".delete-playlist-btn").onclick = (e) => {
      e.stopPropagation();
      openDeletePlaylistModal(p.id);
    };
    ul.appendChild(li);
  }
}

function renderRequestQueue() {
  const box = document.getElementById("requestQueue");
  const list = document.getElementById("requestQueueList");
  if (activeRequests.length === 0) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  list.innerHTML = "";
  for (const r of activeRequests) {
    const div = document.createElement("div");
    div.className = "request-item";
    div.innerHTML = `<div class="mini-spinner"></div><span class="query-text">${escapeHtml(r.query || "mix track")}</span>`;
    list.appendChild(div);
  }
  if (currentView === "all") renderCurrentView();
}

// ============================================================
// Search -> request flow
// ============================================================

function searchSongs() {
  searchQuery = document.getElementById("searchInput").value;
  document.getElementById("clearSearchBtn").style.display = searchQuery ? "inline-block" : "none";

  clearTimeout(searchDebounceTimer);
  const q = searchQuery.trim();

  if (!q) {
    searchResults = [];
    searching = false;
    renderCurrentView();
    return;
  }

  searching = true;
  renderCurrentView();

  searchDebounceTimer = setTimeout(() => runYoutubeSearch(q), 400);
}

async function runYoutubeSearch(q) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/search-youtube?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } }
    );
    const data = await res.json();
    if (searchQuery.trim() !== q) return; // a newer keystroke superseded this search
    searchResults = data.results || [];
  } catch (e) {
    toast("YouTube search failed: " + e.message, "error");
    searchResults = [];
  }
  searching = false;
  renderCurrentView();
}

function clearSearch() {
  document.getElementById("searchInput").value = "";
  searchQuery = "";
  searchResults = [];
  searching = false;
  document.getElementById("clearSearchBtn").style.display = "none";
  renderCurrentView();
}

async function playSearchResult(result, cachedSong) {
  if (cachedSong) {
    if (!queue.includes(cachedSong.id)) queue = [cachedSong.id, ...queue];
    playSong(cachedSong.id);
    return;
  }

  if (pendingPlay && pendingPlay.youtube_id === result.youtube_id) return; // already requested

  pendingPlay = result;
  renderCurrentView();

  const { error } = await sb.from("requests").insert({
    youtube_id: result.youtube_id,
    title: result.title,
    artist: result.artist,
    thumbnail: result.thumbnail,
    query: `${result.artist} - ${result.title}`,
  });

  if (error) {
    pendingPlay = null;
    toast("Couldn't start download: " + error.message, "error");
    renderCurrentView();
  } else {
    toast(`Downloading "${result.title}" — it'll play automatically.`, "success");
  }
}

// ============================================================
// Likes
// ============================================================

async function toggleLikeSong(songId) {
  if (likedIds.has(songId)) {
    likedIds.delete(songId);
    await sb.from("likes").delete().eq("song_id", songId);
  } else {
    likedIds.add(songId);
    await sb.from("likes").upsert({ song_id: songId });
  }
  renderCurrentView();
  updatePlayerHeart();
}

function toggleLike() {
  const songId = queue[currentIndex];
  if (!songId) return;
  toggleLikeSong(songId);
}

function updatePlayerHeart() {
  const songId = queue[currentIndex];
  const btn = document.getElementById("playerHeartBtn");
  btn.classList.toggle("liked", !!songId && likedIds.has(songId));
}

// ============================================================
// Playlists
// ============================================================

function newPlaylist() {
  document.getElementById("playlistName").value = "";
  document.getElementById("playlistModal").style.display = "flex";
}

function closeModal() {
  document.getElementById("playlistModal").style.display = "none";
}

async function createPlaylist() {
  const name = document.getElementById("playlistName").value.trim();
  if (!name) return;
  const { data, error } = await sb.from("playlists").insert({ name }).select().single();
  if (error) { toast("Couldn't create playlist: " + error.message, "error"); return; }
  playlists.push(data);
  playlistSongIds[data.id] = new Set();
  renderPlaylistSidebar();
  closeModal();
  toast(`Created playlist "${name}"`, "success");
}

function openAddToPlaylistModal(songId) {
  pendingAddSongId = songId;
  const box = document.getElementById("playlistOptions");
  box.innerHTML = "";
  if (playlists.length === 0) {
    box.innerHTML = `<p>No playlists yet — create one first.</p>`;
  }
  for (const p of playlists) {
    const row = document.createElement("div");
    row.className = "playlist-option";
    const already = playlistSongIds[p.id]?.has(songId);
    row.innerHTML = `<span>${escapeHtml(p.name)}</span><button>${already ? "Added" : "Add"}</button>`;
    row.querySelector("button").onclick = () => addSongToPlaylist(p.id, songId, row.querySelector("button"));
    box.appendChild(row);
  }
  document.getElementById("addToPlaylistModal").style.display = "flex";
}

function closeAddModal() {
  document.getElementById("addToPlaylistModal").style.display = "none";
}

async function addSongToPlaylist(playlistId, songId, btnEl) {
  if (playlistSongIds[playlistId]?.has(songId)) return;
  const { error } = await sb.from("playlist_songs").insert({ playlist_id: playlistId, song_id: songId });
  if (error) { toast("Couldn't add song: " + error.message, "error"); return; }
  if (!playlistSongIds[playlistId]) playlistSongIds[playlistId] = new Set();
  playlistSongIds[playlistId].add(songId);
  if (btnEl) btnEl.textContent = "Added";
}

function openDeletePlaylistModal(playlistId) {
  pendingDeletePlaylistId = playlistId;
  const p = playlists.find((pl) => pl.id === playlistId);
  document.getElementById("deletePlaylistMessage").textContent =
    `Are you sure you want to delete "${p ? p.name : "this playlist"}"?`;
  document.getElementById("deletePlaylistModal").style.display = "flex";
}

function closeDeleteModal() {
  document.getElementById("deletePlaylistModal").style.display = "none";
}

async function confirmDeletePlaylist() {
  if (!pendingDeletePlaylistId) return;
  const { error } = await sb.from("playlists").delete().eq("id", pendingDeletePlaylistId);
  if (error) { toast("Couldn't delete playlist: " + error.message, "error"); return; }
  playlists = playlists.filter((p) => p.id !== pendingDeletePlaylistId);
  delete playlistSongIds[pendingDeletePlaylistId];
  if (currentView === "playlist" && currentPlaylistId === pendingDeletePlaylistId) loadAll();
  renderPlaylistSidebar();
  closeDeleteModal();
}

// ============================================================
// Mixes
// ============================================================

async function startMix(songId) {
  const song = songs.find((s) => s.id === songId);
  if (!song) return;
  const { error } = await sb.from("mixes").insert({ seed_song_id: songId, track_limit: 8 });
  if (error) { toast("Couldn't start mix: " + error.message, "error"); return; }
  toast(`Building a mix from "${song.title}"...`, "success");
}

function startMixFromCurrent() {
  const songId = queue[currentIndex];
  if (!songId) { toast("Play a song first, then start a mix from it.", "error"); return; }
  startMix(songId);
}

// ============================================================
// Playback
// ============================================================

function playSong(songId) {
  const song = songs.find((s) => s.id === songId);
  if (!song) return;
  currentIndex = queue.indexOf(songId);
  audio.src = song.storage_path;
  audio.preload = document.getElementById("cachingToggle").checked ? "auto" : "none";
  audio.play();
  document.getElementById("nowPlaying").textContent = `${song.artist} - ${song.title}`;
  document.getElementById("cover").src = song.cover_path || document.getElementById("cover").src;
  updatePlayerHeart();
  renderCurrentView();
  ensureAudioGraph();
}

function toggle() {
  if (!audio.src) {
    if (queue.length > 0) playSong(queue[0]);
    return;
  }
  if (audio.paused) audio.play(); else audio.pause();
}

function next() {
  if (queue.length === 0) return;
  let idx;
  if (shuffleOn) {
    idx = Math.floor(Math.random() * queue.length);
  } else {
    idx = (currentIndex + 1) % queue.length;
  }
  playSong(queue[idx]);
}

function prev() {
  if (queue.length === 0) return;
  const idx = (currentIndex - 1 + queue.length) % queue.length;
  playSong(queue[idx]);
}

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  document.querySelector(".icon.shuffle").classList.toggle("active", shuffleOn);
}

function toggleAutoplay() {
  autoplayOn = !autoplayOn;
  document.querySelector(".icon.autoplay").classList.toggle("active", autoplayOn);
}

function bindAudioEvents() {
  audio.addEventListener("play", () => {
    document.querySelector(".icon.play").classList.add("playing");
    renderCurrentView();
  });
  audio.addEventListener("pause", () => {
    document.querySelector(".icon.play").classList.remove("playing");
    renderCurrentView();
  });
  audio.addEventListener("ended", () => {
    if (autoplayOn) next();
  });
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    document.getElementById("progress").value = pct;
    document.getElementById("progress").style.setProperty("--progress", pct + "%");
    document.getElementById("timeText").textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
  });
}

function bindSliderEvents() {
  const progress = document.getElementById("progress");
  progress.addEventListener("input", () => {
    if (!audio.duration) return;
    audio.currentTime = (progress.value / 100) * audio.duration;
  });

  const volume = document.getElementById("volume");
  volume.addEventListener("input", () => {
    audio.volume = volume.value;
    volume.style.setProperty("--volume", volume.value * 100 + "%");
  });
  audio.volume = volume.value;
}

function formatTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ============================================================
// Beat visualizer (Web Audio API analyser, real frequency data)
// ============================================================

function buildBeatVisualizer() {
  const container = document.getElementById("beatVisualizer");
  container.innerHTML = "";
  for (let i = 0; i < 40; i++) {
    const bar = document.createElement("div");
    bar.className = "beat-bar " + (i < 13 ? "low" : i < 27 ? "mid" : "high");
    container.appendChild(bar);
  }
}

function ensureAudioGraph() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    animateVisualizer();
  } catch (e) {
    // Some browsers block this until a user gesture; playSong is triggered by a click, so this is fine.
  }
}

function animateVisualizer() {
  const bars = document.querySelectorAll(".beat-bar");
  const data = new Uint8Array(analyser.frequencyBinCount);

  function frame() {
    requestAnimationFrame(frame);
    if (audio.paused) return;
    analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / bars.length) || 1;
    bars.forEach((bar, i) => {
      const v = data[i * step] || 0;
      bar.style.height = Math.max(4, (v / 255) * 25) + "px";
      bar.classList.toggle("active", v > 180);
    });
  }
  frame();
}

// ============================================================
// Misc helpers
// ============================================================

function setConnectionStatus(online) {
  const el = document.getElementById("connectionStatus");
  el.textContent = online ? "● Online" : "● Offline";
  el.className = "connection-status " + (online ? "online" : "offline");
}

function toast(message, type = "") {
  const container = document.getElementById("toastContainer");
  const div = document.createElement("div");
  div.className = "toast " + type;
  div.textContent = message;
  container.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ============================================================
document.addEventListener("DOMContentLoaded", init);
