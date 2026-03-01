'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createEvent } = require('./calendar');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio-latest';

if (!GEMINI_API_KEY) {
  console.error('FATAL: GEMINI_API_KEY is not set');
  process.exit(1);
}

const GEMINI_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (browserWs, req) => {
  const reqUrl = new URL(req.url, `http://localhost`);
  const timezone = reqUrl.searchParams.get('timezone') || 'UTC';
  console.log(`[${new Date().toISOString()}] Browser connected — timezone: ${timezone}`);

  let reconnectAttempts = 0;
  const MAX_RECONNECTS = 3;
  let geminiWs = null;

  function connectToGemini() {
    geminiWs = new WebSocket(GEMINI_WS_URL);
    attachGeminiHandlers();
  }

  // ── Connect to Gemini Live API ─────────────────────────────────────────────
  connectToGemini();

  function attachGeminiHandlers() {

  geminiWs.on('open', () => {
    console.log('[Gemini] WebSocket connected — sending setup');

    const todayStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: timezone,
    });

    sendToGemini({
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(todayStr, timezone) }],
        },
        tools: [{ functionDeclarations: [calendarFunctionDeclaration()] }],
      },
    });
  });

  // ── Gemini → Browser ───────────────────────────────────────────────────────
  geminiWs.on('message', async (rawData) => {
    let event;
    try {
      event = JSON.parse(rawData.toString());
    } catch {
      console.error('[Gemini] Failed to parse message');
      return;
    }

    // Setup complete — trigger the assistant to greet the user
    if (event.setupComplete !== undefined) {
      console.log('[Gemini] Setup complete — sending greeting trigger');

      sendToGemini({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Hello' }] }],
          turnComplete: true,
        },
      });

      // Tell the browser the session is live
      safeSend(browserWs, JSON.stringify({ type: 'session.ready' }));
      return;
    }

    // Tool / function call
    if (event.toolCall) {
      for (const fc of event.toolCall.functionCalls || []) {
        if (fc.name === 'create_calendar_event') {
          console.log('[Calendar] Function call:', JSON.stringify(fc.args));
          await handleCalendarCall(fc, browserWs);
        }
      }
      return;
    }

    // Server content — audio, transcripts, turn signals
    if (event.serverContent) {
      const sc = event.serverContent;

      // Model was interrupted by user speech — tell browser to stop playback
      if (sc.interrupted) {
        safeSend(browserWs, JSON.stringify({ type: 'interrupted' }));
        return;
      }

      // Audio and text parts from the model's turn
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            // Audio chunk — relay directly to browser
            safeSend(browserWs, JSON.stringify({
              type: 'audio',
              data: part.inlineData.data,
            }));
          }
          // part.text is intentionally ignored — it contains the model's
          // internal reasoning/thinking, not the spoken response transcript
        }
      }

      // Output audio transcription (assistant speech → text)
      if (sc.outputTranscription?.text) {
        safeSend(browserWs, JSON.stringify({
          type: 'transcript',
          role: 'assistant',
          text: sc.outputTranscription.text,
        }));
      }

      // Input audio transcription (user speech → text)
      if (sc.inputTranscription?.text) {
        safeSend(browserWs, JSON.stringify({
          type: 'transcript',
          role: 'user',
          text: sc.inputTranscription.text,
        }));
      }

      // Model finished its turn
      if (sc.turnComplete) {
        safeSend(browserWs, JSON.stringify({ type: 'turn.complete' }));
      }

      return;
    }

    // Log unhandled events for debugging
    const knownNoisy = new Set(['usageMetadata']);
    if (!knownNoisy.has(Object.keys(event)[0])) {
      console.debug('[Gemini] Unhandled event:', JSON.stringify(event).slice(0, 200));
    }
  });

  geminiWs.on('error', (err) => {
    console.error('[Gemini] WebSocket error:', err.message);
    safeSend(browserWs, JSON.stringify({ type: 'error', message: `Gemini error: ${err.message}` }));
  });

  geminiWs.on('close', (code, reason) => {
    console.log(`[Gemini] WebSocket closed: ${code} ${reason}`);

    // 1011 = internal server error on Gemini's side — retry automatically
    if (code === 1011 && reconnectAttempts < MAX_RECONNECTS && browserWs.readyState === WebSocket.OPEN) {
      reconnectAttempts++;
      const delay = reconnectAttempts * 1500;
      console.log(`[Gemini] Retrying in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECTS})`);
      safeSend(browserWs, JSON.stringify({ type: 'reconnecting', attempt: reconnectAttempts }));
      setTimeout(connectToGemini, delay);
      return;
    }

    if (browserWs.readyState === WebSocket.OPEN) {
      safeSend(browserWs, JSON.stringify({ type: 'error', message: 'Connection lost. Please click Stop and try again.' }));
      browserWs.close();
    }
  });

  } // end attachGeminiHandlers

  // ── Browser → Gemini ───────────────────────────────────────────────────────
  browserWs.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (msg.type === 'audio' && geminiWs.readyState === WebSocket.OPEN) {
      // Browser sends raw PCM16 at 16kHz — wrap in Gemini realtimeInput format
      sendToGemini({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: msg.data }],
        },
      });
    }
  });

  browserWs.on('close', () => {
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });

  browserWs.on('error', (err) => {
    console.error('[Browser] WebSocket error:', err.message);
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function sendToGemini(obj) {
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify(obj));
    } else {
      console.warn('[Server] Dropped message to closed Gemini WS:', Object.keys(obj)[0]);
    }
  }

  async function handleCalendarCall(fc, browserWs) {
    const args = fc.args; // Gemini gives args as an object, not a JSON string

    let responseOutput;
    try {
      const result = await createEvent({
        name: args.name,
        dateTime: args.date_time,
        title: args.title,
        durationMinutes: args.duration_minutes,
        timezone,
      });

      console.log('[Calendar] Event created:', result.eventLink);

      safeSend(browserWs, JSON.stringify({
        type: 'calendar.event.created',
        eventLink: result.eventLink,
        eventId: result.eventId,
        args,
      }));

      responseOutput = { success: true, eventLink: result.eventLink };
    } catch (err) {
      console.error('[Calendar] Failed:', err.message);
      responseOutput = { success: false, error: err.message };
    }

    // Send the function result back to Gemini so it can continue the conversation
    sendToGemini({
      toolResponse: {
        functionResponses: [{
          id: fc.id,
          name: fc.name,
          response: { output: responseOutput },
        }],
      },
    });
  }
});

// ─── Safe send ────────────────────────────────────────────────────────────────

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// ─── Gemini function declaration ──────────────────────────────────────────────

function calendarFunctionDeclaration() {
  return {
    name: 'create_calendar_event',
    description:
      'Creates a Google Calendar event. Call this ONLY after the user has confirmed all details. ' +
      'Requires their name, the date and time (ISO 8601 UTC), and an optional meeting title.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "The attendee's full name",
        },
        date_time: {
          type: 'string',
          description:
            'Event start date and time in ISO 8601 UTC format. ' +
            'Example: "2026-03-15T10:00:00Z". ' +
            'Convert relative times like "tomorrow at 2pm" to absolute dates based on today.',
        },
        title: {
          type: 'string',
          description: 'Optional meeting title. Defaults to "Meeting with {name}" if omitted.',
        },
        duration_minutes: {
          type: 'number',
          description: 'Duration in minutes. Defaults to 30 if omitted.',
        },
      },
      required: ['name', 'date_time'],
    },
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(todayStr, timezone) {
  return `You are a friendly, professional scheduling assistant. Today is ${todayStr}. The user's timezone is ${timezone}.

Your goal is to schedule a meeting by collecting:
1. The user's full name
2. Their preferred date and time
3. Optionally, a meeting title (it is optional — default is "Meeting with [name]")

FLOW:
- Greet the user warmly and ask for their name
- Ask for their preferred date and time
- Ask if they have a preferred meeting title (mention it's optional)
- Confirm all details clearly before creating the event
- Call create_calendar_event ONLY after the user confirms
- After creation, confirm the booking warmly

RULES:
- Convert relative dates like "tomorrow" or "next Friday" to specific dates using today's date
- Always repeat the date/time back to the user in plain language before confirming
- Keep responses short — this is a voice interface
- Never use markdown, bullet points, asterisks, or any special formatting — plain text only
- If the user says "yes", "correct", "go ahead" or similar, proceed with booking
- If calendar creation fails, apologise briefly and ask if they'd like to try again`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
});
