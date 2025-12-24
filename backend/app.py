import base64
import os
import secrets
import time
from urllib.parse import urlencode

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

PUBLIC_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
PORT = int(os.getenv("PORT", "3000"))
REDIRECT_URI = os.getenv(
    "SPOTIFY_REDIRECT_URI", f"http://localhost:{PORT}/callback"
)

SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
]

access_token = None
refresh_token = None
access_token_expires_at = 0
oauth_state = None

app = Flask(__name__)


class SpotifyError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def has_valid_access_token():
    return bool(access_token) and time.time() * 1000 < access_token_expires_at - 60_000


def spotify_fetch(endpoint, token, method="GET", params=None, json_body=None):
    response = requests.request(
        method,
        f"https://api.spotify.com{endpoint}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        params=params,
        json=json_body,
        timeout=15,
    )

    if not response.ok:
        raise SpotifyError(response.text or response.reason, response.status_code)

    if response.status_code == 204 or not response.text:
        return None

    try:
        return response.json()
    except ValueError:
        return response.text


def exchange_code_for_token(code):
    body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }

    credentials = f"{CLIENT_ID}:{CLIENT_SECRET}".encode("utf-8")
    auth_header = base64.b64encode(credentials).decode("utf-8")

    response = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=body,
        timeout=15,
    )

    if not response.ok:
        raise SpotifyError(response.text or "Failed to exchange code for token", 500)

    return response.json()


def refresh_access_token():
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    credentials = f"{CLIENT_ID}:{CLIENT_SECRET}".encode("utf-8")
    auth_header = base64.b64encode(credentials).decode("utf-8")

    response = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=body,
        timeout=15,
    )

    if not response.ok:
        raise SpotifyError(response.text or "Failed to refresh token", response.status_code)

    return response.json()


def update_tokens(data):
    global access_token, refresh_token, access_token_expires_at

    access_token = data.get("access_token")
    if data.get("refresh_token"):
        refresh_token = data.get("refresh_token")

    expires_in = int(data.get("expires_in", 0))
    access_token_expires_at = int(time.time() * 1000) + expires_in * 1000


def get_access_token():
    if has_valid_access_token():
        return access_token

    if not refresh_token:
        raise SpotifyError("Missing refresh token", 401)

    data = refresh_access_token()
    update_tokens(data)
    return access_token


@app.get("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/login")
def login():
    global oauth_state

    if not CLIENT_ID or not CLIENT_SECRET:
        return "Missing Spotify credentials. Check your .env file.", 500

    oauth_state = secrets.token_hex(16)

    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "scope": " ".join(SCOPES),
        "redirect_uri": REDIRECT_URI,
        "state": oauth_state,
        "show_dialog": "true",
    }

    return redirect(f"https://accounts.spotify.com/authorize?{urlencode(params)}")


@app.get("/callback")
def callback():
    global oauth_state

    code = request.args.get("code")
    state = request.args.get("state")

    if not code or state != oauth_state:
        return "Invalid OAuth state. Try logging in again.", 400

    try:
        data = exchange_code_for_token(code)
        update_tokens(data)
    except SpotifyError:
        return "Failed to authenticate with Spotify.", 500

    return redirect("/")


@app.get("/token")
def token():
    try:
        token_value = get_access_token()
        return jsonify(
            {"access_token": token_value, "expires_at": access_token_expires_at}
        )
    except SpotifyError:
        return jsonify({"error": "not_authenticated"}), 401


@app.get("/api/me")
def me():
    try:
        token_value = get_access_token()
        profile = spotify_fetch("/v1/me", token_value)
        return jsonify(profile)
    except SpotifyError:
        return jsonify({"error": "not_authenticated"}), 401


@app.get("/api/search")
def search():
    query = request.args.get("query")

    if not query:
        return jsonify({"error": "missing_query"}), 400

    try:
        token_value = get_access_token()
        data = spotify_fetch(
            "/v1/search",
            token_value,
            params={"type": "track", "limit": 12, "q": query},
        )

        tracks = []
        for track in data.get("tracks", {}).get("items", []):
            images = track.get("album", {}).get("images", [])
            image_url = None
            if len(images) > 1:
                image_url = images[1].get("url")
            elif images:
                image_url = images[0].get("url")

            tracks.append(
                {
                    "id": track.get("id"),
                    "name": track.get("name"),
                    "artists": ", ".join(
                        artist.get("name") for artist in track.get("artists", [])
                    ),
                    "album": track.get("album", {}).get("name"),
                    "image": image_url,
                    "uri": track.get("uri"),
                }
            )

        return jsonify({"tracks": tracks})
    except SpotifyError as error:
        return jsonify({"error": "search_failed"}), error.status


@app.put("/api/transfer")
def transfer():
    payload = request.get_json(silent=True) or {}
    device_id = payload.get("device_id")

    if not device_id:
        return jsonify({"error": "missing_device_id"}), 400

    try:
        token_value = get_access_token()
        spotify_fetch(
            "/v1/me/player",
            token_value,
            method="PUT",
            json_body={"device_ids": [device_id], "play": False},
        )
        return jsonify({"ok": True})
    except SpotifyError as error:
        return jsonify({"error": "transfer_failed"}), error.status


@app.post("/api/play")
def play():
    payload = request.get_json(silent=True) or {}
    uris = payload.get("uris")
    device_id = payload.get("device_id")

    if not isinstance(uris, list) or not uris:
        return jsonify({"error": "missing_uris"}), 400

    params = {"device_id": device_id} if device_id else None

    try:
        token_value = get_access_token()
        spotify_fetch(
            "/v1/me/player/play",
            token_value,
            method="PUT",
            params=params,
            json_body={"uris": uris},
        )
        return jsonify({"ok": True})
    except SpotifyError as error:
        return jsonify({"error": "play_failed"}), error.status


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(PUBLIC_DIR, filename)


if __name__ == "__main__":
    if not CLIENT_ID or not CLIENT_SECRET:
        print("Missing Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.")
    app.run(host="0.0.0.0", port=PORT)
