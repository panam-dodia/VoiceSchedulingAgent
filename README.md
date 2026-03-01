# Voice Scheduling Assistant

A real-time voice assistant that schedules Google Calendar events through natural conversation.

**Live URL:** https://voice-scheduler-835493587068.us-central1.run.app

---

## How to Test

1. Open the link above in Chrome or Edge
2. Click "Sign in with Google"
3. If you see "This app isn't verified" — click Advanced then "Go to Voice Scheduler (unsafe)"
4. Grant calendar permission
5. Click Start and allow microphone access
6. Speak naturally — the assistant will ask for your name, preferred date and time, and an optional meeting title
7. Confirm the details — the event is created directly on your Google Calendar
8. The session closes automatically after booking

---

## Stack

- Voice AI: Gemini 2.5 Flash Native Audio (bidirectional real-time audio via WebSocket)
- Calendar: Google Calendar API with OAuth 2.0 (events go to the user's own calendar)
- Backend: Node.js, Express, WebSocket relay, express-session
- Frontend: Vanilla JS, Web Audio API
- Deployment: Google Cloud Run

---

## Calendar Integration

Users sign in with Google and grant calendar.events permission. The app receives an OAuth access token which is stored server-side in a session. When all scheduling details are confirmed, Gemini calls the `create_calendar_event` function and the backend uses the user's token to create the event on their primary Google Calendar. No service account is involved — each user's events go to their own calendar.

---

## Running Locally

### Prerequisites
- Node.js 18+
- Chrome or Edge (required for Web Audio API)
- A Gemini API key — free at https://aistudio.google.com/apikey
- A Google Cloud project with OAuth 2.0 credentials (steps below)

### 1. Clone and install

```bash
git clone https://github.com/panam-dodia/VoiceSchedulingAgent.git
cd VoiceSchedulingAgent
npm install
```

### 2. Set up Google OAuth credentials

1. Go to https://console.cloud.google.com and create a project
2. Enable the Google Calendar API for the project
3. Go to APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
4. Application type: Web application
5. Add `http://localhost:3000` under Authorized JavaScript origins
6. Add `http://localhost:3000/auth/callback` under Authorized redirect URIs
7. Save and copy the Client ID and Client Secret
8. Go to Google Auth Platform → Audience → set user type to External → Publish App

### 3. Configure environment

Copy `.env.example` to `.env` and fill in:

```
GEMINI_API_KEY=          # from aistudio.google.com
GOOGLE_OAUTH_CLIENT_ID=  # from step 2
GOOGLE_OAUTH_CLIENT_SECRET= # from step 2
SESSION_SECRET=          # any long random string
PORT=3000
```

### 4. Run

```bash
npm start
```

Open http://localhost:3000 in Chrome or Edge.

