const crypto = require("crypto");
const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
];

let accessToken = null;
let refreshToken = null;
let accessTokenExpiresAt = 0;
let oauthState = null;

app.use(express.json());
app.use(express.static(FRONTEND_DIR));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn(
    "Missing Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env"
  );
}

function hasValidAccessToken() {
  return accessToken && Date.now() < accessTokenExpiresAt - 60_000;
}

async function spotifyFetch(endpoint, token, options = {}) {
  const response = await fetch(`https://api.spotify.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(text || response.statusText);
    error.status = response.status;
    throw error;
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (parseError) {
    return text;
  }
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || "Failed to exchange code for token");
  }

  return JSON.parse(text);
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || "Failed to refresh token");
  }

  return JSON.parse(text);
}

async function getAccessToken() {
  if (hasValidAccessToken()) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  const data = await refreshAccessToken();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;

  return accessToken;
}

app.get("/login", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .send("Missing Spotify credentials. Check your .env file.");
  }

  oauthState = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    redirect_uri: REDIRECT_URI,
    state: oauthState,
    show_dialog: "true",
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== oauthState) {
    return res.status(400).send("Invalid OAuth state. Try logging in again.");
  }

  try {
    const data = await exchangeCodeForToken(code);
    accessToken = data.access_token;
    refreshToken = data.refresh_token || refreshToken;
    accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
    res.redirect("/");
  } catch (error) {
    console.error("Token exchange failed", error);
    res.status(500).send("Failed to authenticate with Spotify.");
  }
});

app.get("/token", async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ access_token: token, expires_at: accessTokenExpiresAt });
  } catch (error) {
    res.status(401).json({ error: "not_authenticated" });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const token = await getAccessToken();
    const profile = await spotifyFetch("/v1/me", token);
    res.json(profile);
  } catch (error) {
    res.status(401).json({ error: "not_authenticated" });
  }
});

app.get("/api/search", async (req, res) => {
  const query = req.query.query;

  if (!query) {
    return res.status(400).json({ error: "missing_query" });
  }

  try {
    const token = await getAccessToken();
    const data = await spotifyFetch(
      `/v1/search?type=track&limit=12&q=${encodeURIComponent(query)}`,
      token
    );

    const tracks = (data.tracks?.items || []).map((track) => ({
      id: track.id,
      name: track.name,
      artists: track.artists.map((artist) => artist.name).join(", "),
      album: track.album.name,
      image: track.album.images[1]?.url || track.album.images[0]?.url || null,
      uri: track.uri,
    }));

    res.json({ tracks });
  } catch (error) {
    console.error("Search failed", error);
    res.status(error.status || 500).json({ error: "search_failed" });
  }
});

app.put("/api/transfer", async (req, res) => {
  const { device_id: deviceId } = req.body || {};

  if (!deviceId) {
    return res.status(400).json({ error: "missing_device_id" });
  }

  try {
    const token = await getAccessToken();
    await spotifyFetch("/v1/me/player", token, {
      method: "PUT",
      body: JSON.stringify({ device_ids: [deviceId], play: false }),
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Transfer failed", error);
    res.status(error.status || 500).json({ error: "transfer_failed" });
  }
});

app.post("/api/play", async (req, res) => {
  const { uris, device_id: deviceId } = req.body || {};

  if (!Array.isArray(uris) || uris.length === 0) {
    return res.status(400).json({ error: "missing_uris" });
  }

  try {
    const token = await getAccessToken();
    const params = new URLSearchParams();

    if (deviceId) {
      params.set("device_id", deviceId);
    }

    const endpoint = params.toString()
      ? `/v1/me/player/play?${params.toString()}`
      : "/v1/me/player/play";

    await spotifyFetch(endpoint, token, {
      method: "PUT",
      body: JSON.stringify({ uris }),
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Play failed", error);
    res.status(error.status || 500).json({ error: "play_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Spotify Web UI running on http://localhost:${PORT}`);
});
