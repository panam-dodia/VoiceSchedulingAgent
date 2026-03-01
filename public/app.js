'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return `${proto}//${location.host}/ws?timezone=${tz}`;
})();

// Gemini Live API requires PCM16 at 16 kHz for INPUT
const CAPTURE_SAMPLE_RATE = 16000;
// Gemini Live API outputs PCM16 at 24 kHz
const PLAYBACK_SAMPLE_RATE = 24000;

const SCRIPT_PROCESSOR_BUFFER = 4096;

// ─── State ────────────────────────────────────────────────────────────────────

let ws = null;
let captureContext = null;   // AudioContext at 16 kHz — mic capture only
let playbackContext = null;  // AudioContext at 24 kHz — assistant audio playback
let mediaStream = null;
let scriptProcessor = null;
let sourceNode = null;
let silentGain = null;
let isRecording = false;

// Playback scheduling — chunks are pre-scheduled on the AudioContext timeline
let nextPlayTime = 0;          // when the next chunk should start (AudioContext time)
let activePlaybackSources = []; // track active sources so we can stop them on interrupt

// Transcript — track current streaming turn
let assistantTranscriptEl = null;
let assistantTranscriptText = '';

// ─── DOM ─────────────────────────────────────────────────────────────────────

const btnToggle = document.getElementById('btn-toggle');
const statusEl = document.getElementById('status');
const calendarBanner = document.getElementById('calendar-banner');
const transcriptEl = document.getElementById('transcript');
const hintEl = document.getElementById('hint');

// ─── Entry Point ─────────────────────────────────────────────────────────────

btnToggle.addEventListener('click', () => {
  if (!isRecording) {
    startSession();
  } else {
    stopSession();
  }
});

// ─── Session Management ───────────────────────────────────────────────────────

async function startSession() {
  btnToggle.disabled = true;
  setStatus('connecting');
  calendarBanner.style.display = 'none';

  // Request microphone access before connecting
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    setStatus('error');
    appendError(`Microphone access denied: ${err.message}`);
    btnToggle.disabled = false;
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => console.log('[WS] Connected to backend');

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.onerror = () => {
    setStatus('error');
    appendError('WebSocket connection error — is the server running?');
    btnToggle.disabled = false;
  };

  ws.onclose = (ev) => {
    console.log('[WS] Closed:', ev.code, ev.reason);
    if (isRecording) { stopSession(); setStatus('error'); }
  };
}

function stopSession() {
  isRecording = false;

  // Stop mic capture
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (silentGain)      { silentGain.disconnect();      silentGain = null;      }
  if (sourceNode)      { sourceNode.disconnect();      sourceNode = null;      }
  if (mediaStream)      { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (captureContext)   { captureContext.close(); captureContext = null; }

  // Stop playback
  stopPlayback();
  if (playbackContext) { playbackContext.close(); playbackContext = null; }

  // Close WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  ws = null;

  // Reset UI
  btnToggle.textContent = 'Start';
  btnToggle.classList.remove('active', 'speaking');
  btnToggle.disabled = false;
  setStatus('idle');

  assistantTranscriptEl = null;
  assistantTranscriptText = '';
}

// ─── Message Handling ─────────────────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {

    // Session is live — start capturing audio
    case 'session.ready':
      startAudioCapture();
      startPlaybackContext();
      btnToggle.textContent = 'Stop';
      btnToggle.classList.add('active');
      btnToggle.disabled = false;
      isRecording = true;
      setStatus('listening');
      if (hintEl) hintEl.style.display = 'none';
      break;

    // Audio chunk from Gemini — queue for playback
    case 'audio':
      if (msg.data) enqueueAudio(msg.data);
      setStatus('speaking');
      btnToggle.classList.remove('active');
      btnToggle.classList.add('speaking');
      break;

    // Transcript delta from Gemini (assistant or user)
    case 'transcript':
      handleTranscript(msg.role, msg.text);
      break;

    // User started speaking — stop assistant audio immediately (barge-in)
    case 'interrupted':
      stopPlayback();
      playbackQueue = [];
      assistantTranscriptEl = null;
      assistantTranscriptText = '';
      setStatus('listening');
      btnToggle.classList.remove('speaking');
      btnToggle.classList.add('active');
      break;

    // Model finished its turn
    case 'turn.complete':
      assistantTranscriptEl = null;
      assistantTranscriptText = '';
      setStatus('listening');
      btnToggle.classList.remove('speaking');
      btnToggle.classList.add('active');
      break;

    // Calendar event was successfully created
    case 'calendar.event.created':
      showCalendarBanner(msg.eventLink, msg.args);
      // Auto-stop after Gemini finishes speaking the confirmation (~4 seconds)
      setTimeout(() => { if (isRecording) stopSession(); }, 4000);
      break;

    case 'reconnecting':
      setStatus('connecting');
      console.log(`[Reconnect] Attempt ${msg.attempt}`);
      break;

    case 'error':
      console.error('[Error]', msg);
      appendError(msg.message || 'Unknown error from server');
      setStatus('error');
      break;

    default:
      console.debug('[Unhandled]', msg.type);
  }
}

function handleTranscript(role, text) {
  if (!text) return;

  if (role === 'user') {
    // User speech recognised — show as a new turn
    appendTurn('user', text);
    return;
  }

  // Assistant transcript — stream into a single turn
  if (!assistantTranscriptEl) {
    assistantTranscriptText = text;
    assistantTranscriptEl = appendTurn('assistant', assistantTranscriptText);
  } else {
    assistantTranscriptText += text;
    updateTurnText(assistantTranscriptEl, assistantTranscriptText);
  }
}

// ─── Audio Capture ────────────────────────────────────────────────────────────

function startAudioCapture() {
  // 16 kHz — Gemini Live API requires PCM16 at 16 kHz for input
  captureContext = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });

  sourceNode = captureContext.createMediaStreamSource(mediaStream);

  scriptProcessor = captureContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);

  scriptProcessor.onaudioprocess = (ev) => {
    if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

    const float32 = ev.inputBuffer.getChannelData(0);
    const base64 = float32ToPCM16Base64(float32);

    ws.send(JSON.stringify({ type: 'audio', data: base64 }));
  };

  // Route through a silent gain node (gain=0) so onaudioprocess fires
  // but mic audio is NOT played back through the speakers
  silentGain = captureContext.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(scriptProcessor);
  scriptProcessor.connect(silentGain);
  silentGain.connect(captureContext.destination);
}

/**
 * Convert Float32Array PCM samples to base64-encoded Int16 (PCM16).
 * Gemini expects little-endian PCM16 at 16 kHz mono.
 */
function float32ToPCM16Base64(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── Audio Playback ───────────────────────────────────────────────────────────

function startPlaybackContext() {
  // 24 kHz — Gemini outputs PCM16 at 24 kHz
  playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
}

/**
 * Decode a base64 PCM16 chunk (24 kHz from Gemini) and schedule it for
 * gapless playback using AudioContext timeline scheduling.
 */
function enqueueAudio(base64String) {
  if (!playbackContext) return;

  const binaryStr = atob(base64String);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

  const audioBuffer = playbackContext.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  // Schedule this chunk to start exactly when the previous one ends.
  // If we're behind (first chunk or after a gap), start immediately.
  const startTime = Math.max(nextPlayTime, playbackContext.currentTime + 0.02);
  nextPlayTime = startTime + audioBuffer.duration;

  const src = playbackContext.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(playbackContext.destination);
  src.start(startTime);

  activePlaybackSources.push(src);

  // Clean up the reference once it finishes
  src.onended = () => {
    activePlaybackSources = activePlaybackSources.filter(s => s !== src);
  };
}

function stopPlayback() {
  // Stop all scheduled sources and reset the timeline
  activePlaybackSources.forEach(src => {
    try { src.stop(); } catch { /* already stopped */ }
  });
  activePlaybackSources = [];
  nextPlayTime = 0;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = state;
}

function appendTurn(role, text) {
  const div = document.createElement('div');
  div.className = `turn ${role}`;
  div.innerHTML =
    `<div class="turn-label">${role === 'user' ? 'You' : 'Assistant'}</div>` +
    `<div class="turn-bubble">${escapeHtml(text)}</div>`;
  transcriptEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function updateTurnText(turnEl, text) {
  const el = turnEl.querySelector('.turn-bubble');
  if (el) {
    el.textContent = stripMarkdown(text);
    turnEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

function appendError(message) {
  const div = document.createElement('div');
  div.className = 'turn error-turn';
  div.innerHTML =
    `<div class="turn-label">Error</div>` +
    `<div class="turn-bubble">${escapeHtml(message)}</div>`;
  transcriptEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function showCalendarBanner(eventLink, args) {
  const title = args?.title || (args?.name ? `Meeting with ${args.name}` : 'Meeting');
  calendarBanner.innerHTML =
    `<strong>&#x2713; Calendar event created:</strong> ${escapeHtml(title)}` +
    (eventLink
      ? ` &mdash; <a href="${escapeHtml(eventLink)}" target="_blank" rel="noopener noreferrer">View in Google Calendar</a>`
      : '');
  calendarBanner.style.display = 'block';
}

function stripMarkdown(str) {
  if (!str) return '';
  return str
    .replace(/\*\*(.+?)\*\*/g, '$1')  // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic*
    .replace(/`(.+?)`/g, '$1')         // `code`
    .replace(/#+\s/g, '')              // # headings
    .replace(/^[-*]\s/gm, '');         // - bullet points
}

function escapeHtml(str) {
  if (!str) return '';
  return stripMarkdown(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
