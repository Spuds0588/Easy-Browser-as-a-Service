# Master Development Document: Remote Browser-as-a-Service

---

## 1. Product Requirements Document (PRD)

### 1.1 Overview & Vision
We are building a highly embeddable, effortlessly deployable "Browser-as-a-Service" tailored for enterprise web applications, specifically Loan Origination Systems (LOS) and Customer Relationship Management (CRM) tools. The goal is to allow organizations and developers to bypass CORS, encapsulate sessions, and securely stream remote web environments into their own applications via a simple Web Component. The highest priorities are ease of deployment (one-click cloud/bare-metal) and architectural simplicity (stateless backend).

### 1.2 Target Audience
- Developers and dev-teams building portals on top of legacy or strict-CORS CRMs/LOSs.
- Enterprises needing isolated, deep-linked browser sessions embedded inside parent applications without risking local storage/cookie conflicts.

### 1.3 Core Features (MVP)
- **Drop-in Web Component SDK:** A vanilla JavaScript library (`<remote-browser>`) that behaves like an `<iframe>` but powers a remote session, automatically managing WebSocket connections and canvas rendering.
- **Stateless Backend Sessions:** The Docker container holds no persistent state. Cookies, `localStorage`, and `sessionStorage` are continuously synced to the parent DOM and re-injected on connection.
- **Deep-Link Resilience:** The embedded session must survive parent-page reloads and navigations seamlessly.
- **Input Passthrough:** Support for mouse clicks, movement, and native scrolling.
- **Keyboard & Clipboard Integration:** Keyboard event passthrough and bi-directional text-only clipboard sync.
- **Document Passthrough:**
  - **Downloads:** Intercept remote downloads and generate temporary HTTP links to pass to the host.
  - **Uploads:** Intercept remote file pickers, open a local host file picker, POST the file to the container, and pass it to the remote browser.
- **Zombie Session Management:** Multi-tiered timeouts (idle input, visibility API, hard disconnect) to aggressively free container resources.

### 1.4 Out of Scope (For MVP)
- WebRTC streaming (ruled out due to deployment friction; using CDP/WebSockets instead).
- Audio streaming.
- Image/File clipboard copy-paste (text only).
- Database-backed user management or session storage.

---

## 2. Implementation Guide

### 2.1 Architecture & Core Stack
- **Backend Environment:** Node.js running inside a Docker container (base: `ghcr.io/puppeteer/puppeteer:latest`).
- **Browser Engine:** Headless Chromium.
- **Communication Protocol:** Chrome DevTools Protocol (CDP) natively transmitted over standard WebSockets (`ws`).
- **Frontend SDK:** Vanilla JavaScript (Custom Elements API / Web Components).
- **Deployment Targets:** Standard `docker-compose` (bare metal) and `fly.toml` (Fly.io serverless containers).

### 2.2 System Components
#### 2.2.1 The Backend (Container)
- A single master `puppeteer.launch()` process runs continually.
- Upon a new WebSocket connection, the server requests an `IncognitoBrowserContext` from the master process. This ensures isolation (one session per request) while preventing Memory/CPU limits from being exhausted by multiple heavy Chrome binaries.
- Standard Express.js server routes HTTP traffic for the Web Component SDK delivery and file upload/download endpoints.

#### 2.2.2 The Frontend (Web Component SDK)
- Registers `<remote-browser src="...">`.
- Creates a Shadow DOM containing a `<canvas>` element.
- Listens for input events (mouse, scroll, keyboard) and stringifies them over the WebSocket.
- Renders incoming JPEG frames from CDP (`Page.screencastFrame`) directly to the canvas context.

### 2.3 Data Flow & Feature Bridges
- **State Synchronization:** 
  1. SDK reads parent host's `localStorage` (scoped to our component) and sends the initial payload.
  2. Backend injects state into `IncognitoBrowserContext`.
  3. Backend monitors CDP for cookie/storage changes, streaming them back to SDK.
  4. SDK updates host `localStorage` silently.
- **Document Downloads:** CDP intercepts download -> saved to container `/tmp/` -> Backend generates `/download/:id` HTTP route -> SDK receives URL via WS -> SDK triggers hidden `<a>` download on host.
- **Document Uploads:** CDP intercepts file chooser -> SDK triggers local `<input type="file">` -> SDK HTTP POSTs file to `/upload` -> Backend saves to `/tmp/` -> Backend resolves CDP file chooser with local path.

---

## 3. Developer Task List

### Phase 1: Infrastructure & Core Engine
- [ ] **Task 1.1:** Setup Docker environment (`Dockerfile`, `docker-compose.yml`, `install.sh`, `fly.toml`) using Puppeteer base image.
- [ ] **Task 1.2:** Initialize Express/WS server. Implement master `puppeteer.launch()` on startup.
- [ ] **Task 1.3:** Implement WebSocket connection handler that generates a new `IncognitoBrowserContext` and `Page` per connection.
- [ ] **Task 1.4:** Wire up CDP `Page.startScreencast`. Transmit JPEG frames to the client and acknowledge frames (`Page.screencastFrameAck`).
- [ ] **Task 1.5:** Implement robust session cleanup (on WS disconnect, wait 60s, then close context. If idle for X mins, close context).

### Phase 2: Frontend SDK (Web Component)
- [ ] **Task 2.1:** Scaffold `sdk.js`. Register `<remote-browser>` custom element.
- [ ] **Task 2.2:** Implement WebSocket connection logic and Canvas rendering loop within the Web Component.
- [ ] **Task 2.3:** Map and transmit standard mouse events (`Input.dispatchMouseEvent`) and scroll wheel events.
- [ ] **Task 2.4:** Map and transmit keyboard events (`Input.dispatchKeyEvent`).

### Phase 3: State & Integrations
- [ ] **Task 3.1:** Implement bi-directional Text Clipboard sync (`navigator.clipboard` to WS to CDP).
- [ ] **Task 3.2:** Implement Continuous State Sync (Cookies, LocalStorage). Inject on startup, listen for changes via CDP, emit to SDK.
- [ ] **Task 3.3:** Build Document Download bridge (CDP intercept -> `/tmp/` -> HTTP link -> SDK trigger).
- [ ] **Task 3.4:** Build Document Upload bridge (CDP intercept -> SDK file picker -> HTTP POST -> CDP resolve).

### Phase 4: Polish & Delivery
- [ ] **Task 4.1:** Add console logs and debugging hooks for easy troubleshooting during testing.
- [ ] **Task 4.2:** Test deep-linking (parent reload) to ensure state resumes instantly without logging out of the target CRM.
- [ ] **Task 4.3:** Finalize deployment documentation (README.md) for bare-metal and Fly.io.

---

## 4. `agents.md`

```markdown
# AI Developer Agent Context & Rules

You are acting as an expert software engineer working on the "Remote Browser-as-a-Service" project.

## 🏗️ Architectural Directives (CRITICAL)
1. **NO WEBRTC:** Do not suggest, implement, or include WebRTC, STUN, or TURN servers. We are strictly using Chrome DevTools Protocol (CDP) Screencasting over standard WebSockets (`ws`).
2. **STATELESS BACKEND:** The Docker container must remain entirely stateless. Do not use Redis, SQLite, PostgreSQL, or persistent Docker volumes for user sessions. All session state (cookies, local storage) lives on the client (SDK) and is synced back and forth.
3. **INCOGNITO CONTEXTS:** Do not call `puppeteer.launch()` for every user. You MUST launch one master browser instance on server start, and create an `IncognitoBrowserContext` for every new WebSocket connection.
4. **VANILLA JS SDK:** The frontend SDK must be built using Vanilla JavaScript (Web Components / Custom Elements). Do not use React, Vue, or build steps (Webpack/Vite) for the embeddable client SDK.
5. **YAGNI PRINCIPLE:** You Aren't Gonna Need It. Keep solutions lightweight, single-line where possible, and avoid over-engineering. 

## 🛠️ Tech Stack
- **Backend:** Node.js, Express, `ws`, Puppeteer.
- **Frontend:** Vanilla JS (`<remote-browser>` Custom Element).
- **Environment:** Docker (`ghcr.io/puppeteer/puppeteer:latest`).

## 📋 Standard Procedures
- Output full files when generating code so they can be copy-pasted and tested immediately.
- Include verbose `console.log` statements prefixed with component tags (e.g., `[WS]`, `[CDP]`, `[SDK]`) to aid the product manager in debugging.
- Always validate `ws.readyState === ws.OPEN` before sending payloads.
- Handle CDP/Puppeteer crashes gracefully. If a context crashes, notify the client SDK to render an error overlay and attempt a reconnect.
```