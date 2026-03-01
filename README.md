# Voice Scheduling Assistant

A real-time voice assistant that schedules Google Calendar events through natural conversation. Sign in with Google, speak naturally — the assistant collects your name, preferred date and time, and an optional meeting title, confirms the details, then creates the event directly on **your own Google Calendar**.

**Live demo:** _[URL will be added after deployment]_

---

## How to Test

1. Open the deployed URL in **Chrome or Edge** (required for Web Audio API)
2. Click **"Sign in with Google"**
3. On the Google auth screen, if you see "This app isn't verified":
   - Click **"Advanced"** → **"Go to Voice Scheduler (unsafe)"**
   - This is expected for apps pending verification — the app is safe
4. Grant **Google Calendar** permission
5. Click the **Start** orb button and allow microphone access
6. Speak naturally — the assistant will guide you:
   - Asks for your **name**
   - Asks for your **preferred date and time**
   - Asks for an optional **meeting title**
   - Reads back all details and asks you to **confirm**
   - Creates the event and shows a success banner
7. Open **Google Calendar** — the event will be there

> Events are created on your own Google Calendar. You own and control them.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Voice AI | [Gemini 2.5 Flash Native Audio](https://deepmind.google/technologies/gemini/) — bidirectional real-time audio |
| Calendar | Google Calendar API (OAuth 2.0 — user's own calendar) |
| Backend | Node.js · Express · WebSocket relay · express-session |
| Frontend | Vanilla JS · Web Audio API |
| Deployment | Railway |

---

## Architecture

```
Browser (public/app.js)
  │  Google OAuth sign-in → access token stored in server session
  │  getUserMedia → AudioContext @16kHz → PCM16 → base64
  │  WebSocket (/ws?timezone=...)
  ▼
Node.js Server (server.js)
  │  OAuth routes: /auth/login  /auth/callback  /auth/status  /auth/logout
  │  Session middleware: user token stored server-side (express-session)
  │  Relay: browser WS ↔ Gemini Live API WS
  │  Intercept toolCall → calendar.js → Google Calendar API (user token)
  ▼
Gemini Live API                    Google Calendar API
(bidirectional audio + function    (creates event on user's own
 calling over WebSocket)            primary calendar)
```

**Audio pipeline:**
- Capture: browser mic → 16 kHz PCM16 → base64 → backend → Gemini `realtimeInput`
- Playback: Gemini output (24 kHz PCM16) → browser → AudioContext timeline scheduling (gapless)
- Barge-in: user speech stops assistant playback immediately
- Timezone: auto-detected in browser via `Intl.DateTimeFormat`, sent as WS query param

---

## Calendar Integration

Events are created using the signed-in user's **Google OAuth 2.0 access token**:

1. User clicks "Sign in with Google" → grants `calendar.events` permission
2. Server exchanges the auth code for an access token (stored in server session)
3. When Gemini calls `create_calendar_event`, the backend uses that token to call the Google Calendar API
4. Event is created on `calendarId: 'primary'` — the user's own calendar
5. The event link is returned and shown in the success banner

No service account is used. Each user's events go to their own calendar.

---

## Running Locally

### Prerequisites
- Node.js 18+
- Gemini API key (free at [aistudio.google.com](https://aistudio.google.com/apikey))
- Google Cloud project with Calendar API enabled and OAuth 2.0 credentials

### Setup

```bash
# 1. Clone
git clone https://github.com/panam-dodia/VoiceSchedulingAgent.git
cd VoiceSchedulingAgent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and fill in GEMINI_API_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, SESSION_SECRET

# 4. Start
npm start
# or with auto-reload:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in Chrome or Edge.

### Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → **Enable Google Calendar API**
3. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs:
     - `http://localhost:3000/auth/callback` (local)
     - `https://your-app.up.railway.app/auth/callback` (production)
4. Copy the **Client ID** and **Client Secret** into `.env`
5. **OAuth consent screen** → set to **External** → click **Publish App**
   - This allows any Google user to sign in (with a one-time warning screen)

### Environment Variables

```env
GEMINI_API_KEY=AIzaSy...
GOOGLE_OAUTH_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
SESSION_SECRET=some-long-random-string
REDIRECT_URI=                          # optional — auto-detected if blank
PORT=3000
```

---

## Project Structure

```
├── server.js          # Express + WebSocket relay + Gemini Live API + OAuth routes
├── calendar.js        # Google Calendar API (OAuth user token)
├── package.json
├── railway.toml       # Railway deployment config
├── .env.example       # Environment variable template
└── public/
    ├── index.html     # UI: login screen + voice assistant (dark theme)
    └── app.js         # Auth check, audio capture/playback, WebSocket, transcript
```
