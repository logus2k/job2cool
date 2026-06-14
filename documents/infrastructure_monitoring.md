# Infrastructure Live Monitoring

> A self-contained Help & Support feature in job2cool that renders the app's
> container-level dependency graph as an SVG service map and overlays **live
> health** on every node — pushed from the backend over Socket.IO, with a
> timer-free staleness watchdog on the client.

---

## 1. Purpose

job2cool (the HR assistant "Diana") is a thin orchestrator that depends, at
request time, on a fan-out of containers across three Docker networks. When
something breaks — the GPU model host wedges, a KB engine is down, the proxy is
misconfigured — the symptom surfaces as a vague failure in the chat or document
flow. This feature answers, at a glance, **"which dependency is unhealthy right
now?"** It is both:

1. **Documentation** — the diagram is the authoritative, always-current picture
   of job2cool's request-path dependencies and how they connect.
2. **Live monitoring** — each container carries a health dot (green / orange /
   red / grey) updated continuously while the page is open.

It lives in the left-nav **Help & Support** view (`#view-help`).

---

## 2. What is on the map (and what is deliberately not)

The map shows **job2cool's request-path dependencies only** — the containers a
user request actually traverses. It is *not* a map of the whole host.

### Included (16 boxes)

| Tier | Containers |
|---|---|
| Client | **Browser** (the user + embedded cv-chat widget — not a container, no health dot) |
| Edge & Identity | `proxy_server` (nginx), `oauth2-proxy` |
| Application | `job2cool-backend` |
| Direct dependencies | `agent_server`, `kb-service`, `mcp-service` |
| mcp tool backend | `websearch_server` |
| KB engine stack (via kb-service) | `noted-rag`, `noted-graph`, `noted` |
| Model & graph store | `llama-vision`, `noted-arcadedb` |
| Voice (via proxy origin) | `stt_server`, `tts_server`, `avatar_server` |

### Deliberately excluded

- **noted platform infra** — Airflow (×5), Postgres, Redis, MLflow, MinIO,
  Evidently, model-serving. These power KB **ingestion / training / ops**, not
  job2cool's request path. A chat → RAG → compose request never touches them.
- **noted-tools** — the older self-authored MCP tool host. job2cool's Tools /
  Skills feature runs entirely through **mcp-service**; nothing in the backend
  ever calls noted-tools, so it was removed.

### Two scoping nuances worth recording

- **Why `noted` is kept.** job2cool's catch-all `/api/{path}` proxies to
  kb-service, which composes `/api/domains`, `/api/graph/*`, `/api/rag/*` itself
  but falls everything else through to `noted:8123`. The thing that falls
  through is **document-file serving** (`api/documents/files/...`) — the source
  PDF behind a citation and KB doc-title links. So `noted` is a *narrow*
  dependency: not on the chat/RAG path, but hit whenever a user opens a cited
  source document.
- **Why the voice stack has no backend edges.** stt / tts / avatar are reached
  **Browser → proxy_server → voice** (the browser opens Socket.IO to
  `/stt /tts /avatar` on the proxy origin), never via job2cool-backend. The map
  shows this with a Browser box and a left-routed bus from the proxy.

---

## 3. Live health architecture

The guiding rule (project-wide): **the browser never polls.** Detecting that a
container has gone down inherently requires probing on a clock, so that clock
lives **server-side**; the client only ever *receives* pushes.

```
                              health:subscribe
   Browser (help.js) ───────────────────────────────►  job2cool-backend
        ▲                                                (health_monitor.py)
        │   health:status (every ~10s)                        │
        └───────────────  Socket.IO  ◄───────────────────────┤ probes 13 containers
                                                              │ over HTTP, classifies
                                                              │ each ok/degraded/down
                                                              ▼
                                              mcp-service /backends/health
                                                 (proxies to websearch_server,
                                                  which is mcp_internal-only)
```

### 3.1 Server: watcher-gated heartbeat (`backend/health_monitor.py`)

- A single `asyncio` loop probes every `HEALTH_PROBE_INTERVAL` seconds
  (default **10s**) and emits a `health:status` snapshot to the `health`
  Socket.IO room — **but only while at least one browser is in the room**
  (`sio.manager.get_participants`). Nobody watching ⇒ no probing.
- On `health:subscribe` the new client gets the cached snapshot immediately
  (instant paint), then a fresh probe is kicked for everyone.
- The Socket.IO server is the same one used for KB build-progress
  (`socketio_relay.sio`), mounted in `main.py`.

### 3.2 Status classification

Each probe is a plain HTTP GET (5s timeout); the result maps to a colour:

| Outcome | Status | Dot |
|---|---|---|
| connection error / timeout | `down` | red |
| HTTP 5xx | `degraded` | orange |
| any other response (2xx / 204 / 404 …) | `ok` | green (liveness) |

### 3.3 Probe targets (verified endpoints)

| Container | Probe URL |
|---|---|
| `agent_server` | `http://agent_server:7701/v1/models` |
| `kb-service` | `http://kb-service:8080/health` |
| `mcp-service` | `http://mcp-service:8080/health` |
| `noted-rag` | `http://noted-rag:8200/health` |
| `noted-graph` | `http://noted-graph:5523/health` |
| `noted` | `http://noted:8123/api/domains` |
| `llama-vision` | `http://llama-vision:8500/health` |
| `noted-arcadedb` | `http://noted-arcadedb:2480/api/v1/ready` (204) |
| `stt_server` | `http://stt_server:2700/health` |
| `tts_server` | `http://tts_server:7700/health` |
| `avatar_server` | `http://avatar_server:7800/` |
| `proxy_server` | `http://proxy_server:80/` |
| `oauth2-proxy` | `http://oauth2-proxy:4180/ping` |
| `websearch_server` | **via** `mcp-service` → `GET /backends/health` |
| `job2cool-backend` | self — stamped `ok` (it is running to emit the push) |

All URLs are env-overridable (`HM_*_URL`); the targets are the **real**
containers, distinct from the functional env vars (e.g. `NOTED_RAG_URL` points
at the kb-service façade, but here we probe the `noted-rag` container directly).

### 3.4 The two special cases

- **`websearch_server`** lives on the isolated `mcp_internal` network and is
  unreachable from job2cool-backend. It is observed *through* a new,
  side-effect-free endpoint on mcp-service — **`GET /backends/health`** — which
  pings websearch's `/health` (no real web search) and returns
  `{"backends": {"websearch_server": "ok"|"degraded"|"down"}}`. If mcp-service
  itself is unreachable, websearch reports `down` (its only path is gone).
- **`job2cool-backend`** can't meaningfully probe itself, so it stamps itself
  `ok` in every push. If the backend dies, **no push arrives at all** — and the
  client watchdog (below) decays the whole board to red, which is the correct
  signal that the monitoring source itself is gone.

---

## 4. The client-side watchdog (timer-free staleness)

Requirement: if pushes stop arriving, the live indicator must degrade
**green → yellow → orange → red**. Detecting the *absence* of events normally
needs a `setInterval` watchdog — which is banned project-wide.

**Solution: a CSS-animation watchdog.** A "live feed" badge runs a keyframe
animation (`archDecay`) that fades green → yellow (46%) → orange (70%) → red
(100%) over `--arch-stale` (default **40s**). Every incoming `health:status`
push calls `markLive()`, which **restarts** the animation (pets the watchdog) —
an event-driven reset, not a timer. If pushes stop:

- the browser's own animation clock carries the badge to red on its own, and
- the **`animationend` event** (also not a timer) fires `goStale()`, which marks
  "no signal" and dims all the health dots.

With a 10s server heartbeat and a 40s decay window: one missed beat ≈ yellow,
two ≈ orange, fully silent ≈ red. A hard socket `disconnect` jumps straight to
the stale/red end-state via `markDisconnected()`.

---

## 5. Rendering (`frontend/js2c/architecture.js`)

A hand-authored, **data-driven SVG** — no external graph/layout library
(deliberate: the layout is a fixed, known topology in a fixed panel, and
recoloring a dot is a one-line `setAttribute`). It matches the existing
`js2c/*.js` IIFE module style.

Public API (`window.JOB2COOL_ARCHITECTURE`):

| Method | Purpose |
|---|---|
| `render(rootEl, {onRefresh})` | draw the toolbar + SVG into a container |
| `setHealth(map)` | recolor dots; `map[containerId] = 'ok'|'degraded'|'down'|'unknown'` |
| `setStatusText(s)` | right-aligned "updated …" line |
| `markLive()` | pet the watchdog (call on each push) |
| `markDisconnected()` | jump to stale/red on a socket drop |
| `NODES`, `STATUS` | the node model and status palette |

The model is three arrays — `NODES` (id = container name, x/y/w/h, network,
`probe`), `GROUPS` (tier labels), `EDGES` (call paths, with `via:'left'` /
`via:'voicebus'` side-routing and `gapY` elbow control). Networks are
colour-coded (this app / noted-network / logus2k-net / mcp_internal /
edge-identity). The SVG uses a `viewBox` (currently `1000 × 940`) and scales
responsively to the panel width; it is vertically centered below a pinned
toolbar.

---

## 6. Files

| File | Role |
|---|---|
| `backend/health_monitor.py` | watcher-gated probe loop + Socket.IO `health:*` channel |
| `backend/main.py` | startup hook `_start_health_monitor`; legacy REST `/api/health` (separate, smaller liveness check) |
| `frontend/js2c/architecture.js` | the data-driven SVG renderer + CSS watchdog |
| `frontend/js2c/help.js` | Help view host — connects Socket.IO, drives `setHealth`/`markLive`/`markDisconnected` |
| `frontend/index.html` | Help & Support nav item, `#view-help`, script includes |
| `mcp/app/main.py` | `GET /backends/health` passthrough for websearch_server |
| `documents/architecture_preview.html` | standalone browser preview (mock health + watchdog demo) — open via `file://`, no rebuild needed |

---

## 7. Configuration

| Env var | Default | Where |
|---|---|---|
| `HEALTH_PROBE_INTERVAL` | `10` (seconds) | health_monitor.py |
| `MCP_SERVICE_URL` | `http://mcp-service:8080` | used for the websearch passthrough |
| `HM_*_URL` (per target) | the internal container URLs in §3.3 | per-target overrides |
| `--arch-stale` (CSS var) | `40s` | watchdog decay window (set on `.arch-fresh`) |

---

## 8. Deployment

Both the backend and the baked-in frontend live in the job2cool image, so a
frontend or backend change needs:

```
cd ~/env/assets/job2cool && docker compose up -d --build job2cool-backend
```

The websearch passthrough lives in a separate service:

```
cd ~/env/assets/mcp && docker compose up -d --build
```

After a frontend rebuild, hard-reload the browser (Ctrl-Shift-R) — `js2c/*.js`
is served with no cache-buster.

---

## 9. Extending it (adding a monitored container)

1. **Backend** — add `(id, probe_url)` to `TARGETS` in `health_monitor.py`
   (or, for a container on an isolated network, add a passthrough like
   `/backends/health` on a service that *can* reach it).
2. **Diagram** — add an entry to `NODES` in `architecture.js` (id must match the
   status-map key) with `probe: true`; wire any `EDGES`.
3. Rebuild job2cool-backend.

---

## 10. Limitations

- **Liveness, not deep health.** A green dot means "the process responded < 500",
  not "every subsystem is healthy."
- **Watcher-gated** — probing happens only while a browser has the Help view
  open; this is a UI dashboard, not an alerting/Prometheus pipeline.
- **websearch & oauth2-proxy** are observed indirectly / via a liveness ping; a
  green dot there means reachable, not fully functional.
- The legacy `/api/health` REST endpoint is a separate, smaller check (kept for
  external probes) and is not what the live diagram consumes.
```
