# Stage Timer

A lightweight, real-time countdown timer web application for conference stages (`/stage`) with remote control from a phone or laptop (`/control`).

No native app installation required — everything runs in a mobile or tablet browser, and multiple halls/rooms are completely isolated using unique **4-digit PIN codes** and **QR codes**.

---

## Features

- **Room Isolation via PIN & QR Code:** Every organizer clicks **"+ Create New Remote"** on `/control` to get a unique 4-digit PIN and a scannable QR code (`/stage?pin=XXXX`). Different rooms never interfere with each other.
- **Take Over / Restore by PIN:** If your laptop dies mid-talk, open `/control` on your phone, enter the 4-digit PIN shown on the stage tablet, and take over control immediately without walking up to the stage.
- **Two Display Modes:**
  - *Colored Background* — full screen changes color per threshold (green / yellow / red) with crisp white digits.
  - *Black Screen (Colored Digits)* — pure black `#000000` background with bright colored digits so the tablet doesn't glare in a dark auditorium.
- **Customizable Thresholds & Colors:** Set exact minutes and seconds before `00:00` when the timer turns yellow and red, and pick custom hex colors from the remote.
- **Overtime Alert:** Past `00:00` in both modes, the entire stage screen flashes red, displays `TIME'S UP!`, and counts overtime negatively (`-00:01`, `-00:02`...).
- **Speaker Messages:** Send quick presets (*"2 minutes left"*, *"Move to Q&A"*, *"Time's up!"*) or custom text. The message appears in huge text below the clock while timer digits automatically scale down to fit cleanly. While a message is visible on stage, a pulsing red **`● ON SCREEN`** indicator blinks on the remote.
- **Drift-Free Sync:** Time is calculated from a target server timestamp (`endTimeMs`) adjusted for client clock skew (`serverTimeOffset`) over Server-Sent Events (SSE) — no network ticks, instant auto-resync after reconnects.
- **Restart Persistence:** Active rooms, timers, and color settings are automatically saved to `rooms-state.json` and restored on server restart.
- **Screen Wake Lock:** Uses the browser `Wake Lock API` plus fullscreen mode on `/stage` to keep the tablet screen awake.

---

## Project Structure

```text
stage-timer/
├── server.js           # Node.js HTTP + SSE server + SVG QR generator
├── public/
│   ├── stage.html      # Stage tablet display (/stage)
│   └── control.html    # Organizer remote control (/control)
├── package.json
├── Dockerfile          # Production container image
├── docker-compose.yml  # One-command deployment on a VPS
├── render.yaml         # Render.com Blueprint config
├── VIBECODING_SPEC.md  # Copy-paste master prompt & API spec for AI builders
└── README.md
```

---

## Option 1: Deploy on Your Own Server (VPS / Dedicated IP)

The server uses pure Node.js with only one dependency (`qrcode`), consumes ~30 MB RAM, and handles dozens of simultaneous rooms.

### Method A: Docker (Recommended)

Requires Docker and Docker Compose:

```bash
git clone https://github.com/kzinkoff/stage-timer.git
cd stage-timer
docker compose up -d --build
```

The server will listen on port `3000` (check with `curl http://localhost:3000/health`).  
To use a different port: `PORT=8080 docker compose up -d --build`.

### Method B: Node.js (`>= 18`) + PM2 / systemd

```bash
git clone https://github.com/kzinkoff/stage-timer.git
cd stage-timer
npm ci --omit=dev
```

Run with **PM2**:
```bash
npm install -g pm2
PORT=3000 pm2 start server.js --name stage-timer
pm2 save
```

Or create a **systemd** unit (`/etc/systemd/system/stage-timer.service`):
```ini
[Unit]
Description=Stage Timer Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/stage-timer
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

---

### Important: HTTPS & Reverse Proxy (Caddy or Nginx)

> **Why HTTPS matters:**
> Mobile browsers on iPad (Safari) and Android (Chrome) only allow the **Screen Wake Lock API** over `https://` or `localhost`. If you open `/stage` over plain `http://<IP>:3000`, the browser will block Wake Lock and you will need to disable auto-lock in the tablet's OS settings.

#### Caddy (Automatic HTTPS in 3 lines)

Point your domain (e.g. `timer.example.com`) to the server IP and put this in `/etc/caddy/Caddyfile`:

```caddyfile
timer.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
Caddy automatically provisions Let's Encrypt SSL certificates and handles SSE streams out of the box.

#### Nginx

For real-time **SSE (`/api/events`)** updates to arrive immediately without buffering, you **must** set `proxy_buffering off;` and a long `proxy_read_timeout`:

```nginx
server {
    listen 80;
    server_name timer.example.com;

    # Add SSL configuration via certbot (`certbot --nginx -d timer.example.com`)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for instant SSE delivery:
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding off;
    }
}
```

---

## Option 2: Cloud Hosting Without Managing a Server

- **Render.com:** Connect this repository as a *Blueprint* or *Web Service* — `render.yaml` is already included (`buildCommand: npm install`, `startCommand: node server.js`, `healthCheckPath: /health`).
  - *Tip for Render free tier:* Free instances sleep after 15 minutes of inactivity. During your event, set up a free ping monitor (e.g. [cron-job.org](https://cron-job.org/) or [UptimeRobot](https://uptimerobot.com/)) targeting `https://<your-app>.onrender.com/health` every 5 minutes.
- **Railway.app / Fly.io / PaaS providers:** Import this repository; the platform detects `Dockerfile` or `package.json` (`npm start`) and provides HTTPS automatically.

---

## Option 3: Recreate or Host on AI / Vibe-Coding Platforms

Want to rebuild or customize this app inside **Lovable, Bolt.new, Replit, v0, or Base44**?  
See **[VIBECODING_SPEC.md](./VIBECODING_SPEC.md)** for a complete copy-paste master prompt, data schema, and Supabase/Firebase adaptation notes.

---

## Event Day Checklist for Organizers

### 1. Setting up the Stage Tablet (`/stage`)
1. Connect the tablet to power/powerbank and Wi-Fi (or LTE).
2. As a failsafe, disable screen auto-lock in the tablet's OS settings (*iPad: Settings → Display & Brightness → Auto-Lock → Never*; *Android: Settings → Display → Screen Timeout / Stay Awake while charging*).
3. On your phone or laptop, open `/control` and tap **"+ Create New Remote"** — a 4-digit PIN and QR code will appear.
4. Scan the QR code with the stage tablet camera (or open `/stage` and enter the 4-digit PIN using the on-screen keypad).
5. Tap the stage screen and press **Fullscreen** — the top badge will turn into `☀️ Screen Awake`.

### 2. Troubleshooting During the Event
- **Organizer's laptop/phone battery died:** Open `/control` on another phone, enter the 4-digit PIN displayed in the top-left corner of the stage tablet under **"Open or Restore Remote by PIN"**, and click **"Open / Restore"**. Control switches immediately with zero interruption on stage.
- **Temporary Wi-Fi drop:** The status dot on `/stage` turns red while disconnected, but the timer keeps counting accurately using local monotonic offset and automatically re-syncs as soon as connectivity returns.
