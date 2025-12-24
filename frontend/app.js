const loginSection = document.getElementById("login");
const appSection = document.getElementById("app");
const statusEl = document.getElementById("status");
const nowPlayingEl = document.getElementById("now-playing");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultsEl = document.getElementById("results");
const transferButton = document.getElementById("transfer");
const toggleButton = document.getElementById("toggle");

const state = {
  deviceId: null,
  player: null,
  authenticated: false,
  sdkReady: false,
};

function setStatus(message, tone = "info") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function showLogin() {
  loginSection.classList.remove("hidden");
  appSection.classList.add("hidden");
}

function showApp() {
  loginSection.classList.add("hidden");
  appSection.classList.remove("hidden");
}

async function apiGet(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || response.statusText);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function apiSend(path, method, body) {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || response.statusText);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function fetchAccessToken() {
  const data = await apiGet("/token");
  return data.access_token;
}

async function checkSession() {
  try {
    const profile = await apiGet("/api/me");
    state.authenticated = true;
    showApp();
    setStatus(`Connected as ${profile.display_name || profile.id}`, "ok");
    if (state.sdkReady) {
      initPlayer();
    }
  } catch (error) {
    state.authenticated = false;
    showLogin();
    setStatus("Not connected", "info");
  }
}

async function transferPlayback() {
  if (!state.deviceId) {
    setStatus("Player not ready yet", "warn");
    return;
  }

  try {
    await apiSend("/api/transfer", "PUT", { device_id: state.deviceId });
    setStatus("Playback transferred to browser", "ok");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("Please connect to Spotify", "warn");
      return;
    }
    setStatus("Transfer failed. Try again.", "error");
  }
}

async function playTrack(uri) {
  const payload = { uris: [uri] };

  if (state.deviceId) {
    payload.device_id = state.deviceId;
  } else {
    setStatus("Web player not ready; trying active device", "warn");
  }

  try {
    await apiSend("/api/play", "POST", payload);
    setStatus("Playing", "ok");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("Please connect to Spotify", "warn");
      return;
    }
    if (error.status === 404) {
      setStatus(
        "No active device found. Open Spotify on any device and start playback once.",
        "warn"
      );
      return;
    }
    if (error.status === 403) {
      setStatus("Spotify Premium required for playback", "error");
      return;
    }
    setStatus("Playback failed", "error");
  }
}

function renderResults(tracks) {
  resultsEl.innerHTML = "";

  if (!tracks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tracks found";
    resultsEl.appendChild(empty);
    return;
  }

  tracks.forEach((track) => {
    const row = document.createElement("div");
    row.className = "result";

    const art = document.createElement("div");
    art.className = "result-art";

    if (track.image) {
      const img = document.createElement("img");
      img.src = track.image;
      img.alt = track.name;
      art.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "result-placeholder";
      art.appendChild(placeholder);
    }

    const info = document.createElement("div");
    info.className = "result-info";

    const title = document.createElement("div");
    title.className = "result-title";
    title.textContent = track.name;

    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.textContent = `${track.artists} - ${track.album}`;

    info.appendChild(title);
    info.appendChild(meta);

    const action = document.createElement("div");
    action.className = "result-action";

    const button = document.createElement("button");
    button.className = "button ghost";
    button.type = "button";
    button.textContent = "Play";
    button.addEventListener("click", () => {
      playTrack(track.uri);
    });

    action.appendChild(button);
    row.appendChild(art);
    row.appendChild(info);
    row.appendChild(action);

    resultsEl.appendChild(row);
  });
}

async function handleSearch(event) {
  event.preventDefault();

  const query = searchInput.value.trim();
  if (!query) {
    return;
  }

  setStatus("Searching...", "info");

  try {
    const data = await apiGet(`/api/search?query=${encodeURIComponent(query)}`);
    renderResults(data.tracks || []);
    setStatus("Search complete", "ok");
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      setStatus("Please connect to Spotify", "warn");
      return;
    }
    setStatus("Search failed", "error");
  }
}

function formatNowPlaying(track) {
  if (!track) {
    return "No track selected";
  }
  const artists = track.artists.map((artist) => artist.name).join(", ");
  return `${track.name} - ${artists}`;
}

async function initPlayer() {
  if (state.player) {
    return;
  }

  if (!state.authenticated) {
    return;
  }

  try {
    await fetchAccessToken();
  } catch (error) {
    return;
  }

  const player = new Spotify.Player({
    name: "Affective Web UI Player",
    getOAuthToken: async (callback) => {
      try {
        const token = await fetchAccessToken();
        callback(token);
      } catch (error) {
        setStatus("Authentication required", "warn");
      }
    },
    volume: 0.6,
  });

  player.addListener("ready", ({ device_id: deviceId }) => {
    state.deviceId = deviceId;
    setStatus("Web player ready", "ok");
    transferPlayback();
  });

  player.addListener("initialization_error", ({ message }) => {
    setStatus(`Player init error: ${message}`, "error");
  });

  player.addListener("authentication_error", ({ message }) => {
    showLogin();
    setStatus(`Player auth error: ${message}`, "error");
  });

  player.addListener("account_error", ({ message }) => {
    setStatus(`Account error: ${message}`, "error");
  });

  player.addListener("playback_error", ({ message }) => {
    setStatus(`Playback error: ${message}`, "error");
  });

  player.addListener("not_ready", () => {
    setStatus("Web player disconnected", "warn");
  });

  player.addListener("player_state_changed", (playerState) => {
    if (!playerState) {
      return;
    }
    const current = playerState.track_window.current_track;
    nowPlayingEl.textContent = formatNowPlaying(current);
  });

  player.connect();
  state.player = player;
}

searchForm.addEventListener("submit", handleSearch);
transferButton.addEventListener("click", transferPlayback);

toggleButton.addEventListener("click", () => {
  if (!state.player) {
    setStatus("Player not ready yet", "warn");
    return;
  }
  state.player.togglePlay();
});

window.onSpotifyWebPlaybackSDKReady = () => {
  state.sdkReady = true;
  initPlayer();
};

document.addEventListener("DOMContentLoaded", () => {
  checkSession();
});
