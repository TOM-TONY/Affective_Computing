# Spotify Web UI Player

A minimal Express + Spotify Web Playback SDK app that lets you search and play tracks from a browser UI.

## Prerequisites
- A Spotify Premium account (required by the Web Playback SDK)
- A Spotify Developer app with a redirect URI
- Either Node.js 18+ or Python 3.9+

## Setup
1. Create a Spotify app at https://developer.spotify.com/dashboard
2. Add this redirect URI in the app settings:
   - http://localhost:3000/callback
3. Copy `.env.example` to `.env` and fill in your credentials.

## Run (Node.js)
```bash
npm install
npm start
```
Then open http://localhost:3000

## Run (Python)
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
Then open http://localhost:3000

## Notes
- If playback does not start, click "Transfer to Browser" or keep another Spotify device open.
- Tokens are stored in memory for a single user. Restarting the server clears them.
