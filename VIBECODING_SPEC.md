# Stage Timer Specification for AI & Vibe-Coding Platforms

This document provides a ready-to-use master prompt, room state schema, and API contract. You can copy and paste the prompt below directly into **Lovable, Bolt.new, Replit Agent, v0, Base44, Cursor**, or any AI app builder with built-in cloud hosting.

---

## 1. Ready-to-Use Master Prompt (Copy & Paste)

Copy the entire block below and paste it into your AI builder:

```text
Build a web application called "Stage Timer" — a multi-room speaker countdown timer with remote control from a phone or laptop.

=== ARCHITECTURE & ROUTES ===
The app has exactly two screens, no user login/auth, no speaker name field, and no fixed room tabs:
1. /control — organizer's remote control (mobile-first layout).
2. /stage — fullscreen stage display for the tablet facing the speaker.

Root / redirects to /control.

=== ROOM ISOLATION VIA 4-DIGIT PIN & QR CODE ===
Each organizer creates an isolated room so halls/stages never interfere with one another:
1. Start screen on /control (when ?pin=XXXX is not in the URL):
   - Huge button "+ Create New Remote": creates a room on the server with a unique random 4-digit PIN (1000-9999), updates the URL to /control?pin=XXXX, and immediately opens the tablet pairing card.
   - "Open or Restore Remote by PIN" card: 4-digit input + "Open / Restore" button. If a room with that PIN already exists, connect to it (preserving its running timer and settings). If it doesn't exist (e.g., server restarted or organizer's laptop died and they're switching to a phone using the PIN visible on the stage tablet), create a room with that exact 4-digit PIN.
2. Tablet pairing card on /control (collapsible via a "Tablet (QR / PIN)" toggle button):
   - Large 4-digit PIN display.
   - Scannable QR code (SVG/PNG) encoding the full URL <origin>/stage?pin=XXXX.
   - Direct link "Open Stage Screen".
3. Stage screen /stage:
   - If opened without ?pin=XXXX, show a dark fullscreen PIN entry card with a large touch-friendly on-screen numeric keypad (0-9, backspace, Connect) plus physical keyboard support.
   - If opened via QR code /stage?pin=XXXX, open the timer immediately.
   - If network drops or the server restarts, /stage MUST NOT kick back to the PIN entry screen: keep the timer screen visible with a red disconnected status dot and auto-reconnect to the same PIN (and let the SSE endpoint auto-create the room for any valid 4-digit PIN if missing).

=== DRIFT-FREE TIME MATH & REAL-TIME SYNC ===
- Real-time sync between /control and /stage (< 1s latency via SSE, WebSockets, or Realtime).
- Do NOT broadcast per-second ticks over the network. Store a target endTimeMs (Unix timestamp ms) when running.
- Include serverNow (Date.now() on server) in every state payload. Clients compute serverTimeOffset = serverNow - Date.now() and calculate remaining time locally at ~100ms intervals as endTimeMs - (Date.now() + serverTimeOffset).
- While remaining > 0, round seconds up (Math.ceil(ms / 1000)). Past zero, switch to negative count (-00:01, -00:02...) using Math.floor(Math.abs(ms) / 1000).

=== REMOTE CONTROL (/control) ===
1. Live mini preview of the stage display (mirrors digits, status, active message, and colored/black background mode).
2. Transport controls: "Start", "Pause", "Reset", "-1 min", "+1 min".
3. Duration presets in a 3x2 grid: 5 m, 10 m, 15 m, 20 m, 30 m, 45 m + custom minutes input and "Set" button.
4. Colors & threshold settings:
   - Display mode switch:
     1) "Colored Background" (blackBackground = false): full screen uses the active zone color, digits are white.
     2) "Black Screen (Colored Digits)" (blackBackground = true): background stays #000000 while timer digits and status badge use the active zone color.
   - "Turns Yellow at..." threshold (minutes + seconds inputs before 00:00, default 5m 0s) + color picker (default #eab308).
   - "Turns Red at..." threshold (minutes + seconds inputs before 00:00, default 1m 0s) + color picker (default #dc2626).
   - "Green Zone" color picker (default #16a34a).
5. Message to Stage Screen:
   - Text input + quick chips ("2 minutes left", "Move to Q&A", "Please wrap up, time's up!").
   - "Show" and "Hide" buttons.
   - IMPORTANT: While a message is actively displayed on stage (showMessage === true), show a pulsing red recording-style dot and "ON SCREEN" badge next to the section title, plus highlight the "Show" button with a red outline and pulsing red dot.

=== STAGE SCREEN LAYOUT & BEHAVIOR (/stage) ===
1. Digits use font-variant-numeric: tabular-nums so widths never jitter.
2. Responsive typography readable from 3-5+ meters:
   - Normal mode (no alert, no message): digits at 31vw (26vw when negative).
   - When "PAUSED" or "TIME'S UP!" badge is shown: badge at clamp(44px, 11.5vmin, 160px), digits shrink to 24vw (22vw when negative).
   - When an organizer message is shown: render the message box in normal flex flow below the timer (never overlapping digits!), automatically shrink timer digits to min(17vw, 22vmin), and render the message huge at clamp(42px, 10.5vmin, 140px) (or clamp(32px, 8vmin, 100px) when > 35 chars) inside a high-contrast bordered box.
3. Overtime behavior after 00:00:
   - In BOTH color modes (colored background and black screen), when remaining <= 0 and status === 'running', flash the entire screen red/dark (1s CSS animation), display "TIME'S UP!" prominently, and count negative overtime (-00:05).
4. Screen Wake Lock:
   - Use Screen Wake Lock API (navigator.wakeLock.request('screen')), auto-request on any click/touchstart, on PIN connect, and on visibilitychange === 'visible'.
   - Top bar shows connection dot, PIN, Wake Lock status badge ("☀️ Screen Awake" / "👆 Tap screen to keep awake"), "Change PIN" button, and "Fullscreen" button (requestFullscreen()).
```

---

## 2. Room State JSON Schema (`RoomState`)

Regardless of backend stack (in-memory Node.js + JSON file, Supabase, or Firebase), each room follows this model:

```json
{
  "pin": "4829",
  "status": "idle",
  "durationSec": 900,
  "remainingMs": 900000,
  "endTimeMs": null,
  "message": "",
  "showMessage": false,
  "settings": {
    "blackBackground": false,
    "yellowThresholdSec": 300,
    "redThresholdSec": 60,
    "greenColor": "#16a34a",
    "yellowColor": "#eab308",
    "redColor": "#dc2626"
  }
}
```

### Computed Fields Sent to Clients
- `remainingMs`: when `status === "running"` and `endTimeMs !== null`, compute `endTimeMs - Date.now()`; otherwise return the stored `remainingMs`.
- `serverNow`: current server `Date.now()` so clients can calculate `serverTimeOffset`.

---

## 3. HTTP / SSE API Contract (for Node.js / Express / Fastify Backends)

| Endpoint | Behavior |
| :--- | :--- |
| `POST /api/create-room` | Optional body `{ "pin": "5577" }`. Without `pin`, creates a room with a unique random 4-digit `pin`. With a 4-digit `pin`, returns the existing room or creates a new one with that exact `pin`. |
| `GET /api/room-exists?pin=XXXX` | Checks whether the room exists. Returns `200 { "ok": true, "pin": "XXXX" }` or `404`. |
| `GET /api/qr?url=...` | Generates an SVG QR code (`image/svg+xml`) for the given URL. |
| `GET /api/events?pin=XXXX` | SSE stream (`text/event-stream`). Sends current `RoomState` immediately on connect. Auto-creates the room for any valid 4-digit `pin` if missing. Keep-alive every 15 seconds. |
| `POST /api/action` | Accepts `{ "pin": "XXXX", "action": "...", ... }`. Supported actions: `set_duration` (`seconds`), `start`, `pause`, `reset`, `adjust` (`deltaSec`), `message` (`message`, `show`), `settings` (`settings`). |
| `GET /health` | Healthcheck returning `200 { "ok": true, "rooms": N, "uptime": ... }`. |

---

## 4. Platform-Specific Notes

### Option A: Node.js Platforms (Replit, Bolt.new, Glitch)
You don't need to regenerate anything from scratch — simply import this GitHub repository (`server.js`, `package.json`, `public/control.html`, `public/stage.html`) and click **Run / Deploy**:
- Start command: `npm start` (`node server.js`).
- Port: `process.env.PORT || 3000`.
- Published URLs automatically include `https://`, enabling `Wake Lock API` on iPad and Android.

### Option B: React + BaaS Platforms (Lovable, Base44, v0 + Supabase / Firebase)
When pasting the master prompt into **Lovable** (Supabase backend) or **v0 / Firebase Studio**, append one of the following technical notes:

**For Lovable / Supabase:**
> Use Supabase for room persistence and real-time sync. Create a `rooms` table matching the JSON schema (`pin text primary key`, `status text`, `duration_sec int`, `remaining_ms bigint`, `end_time_ms bigint`, `message text`, `show_message boolean`, `settings jsonb`, `updated_at timestamptz`). Subscribe via Supabase Realtime (`postgres_changes` filtered by `pin=eq.${pin}`) and use a Supabase Broadcast channel `room:${pin}` for low-latency updates. Get `serverNow` via a Postgres RPC function `select extract(epoch from now()) * 1000`. Generate QR codes client-side using `qrcode.react`.

**For Firebase Realtime Database:**
> Store each room at `rooms/${pin}`. Subscribe to `.info/serverTimeOffset` to automatically compute clock offset between client and server. Generate QR codes client-side with `qrcode` or `qrcode.react`.
