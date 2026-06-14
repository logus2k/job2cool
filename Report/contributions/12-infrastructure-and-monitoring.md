# 12. Infrastructure, Deployment & Live Monitoring

## 12.1 Deployment

job2cool ships as **one image** (backend + baked-in frontend). A frontend or backend
change is deployed with:

```
cd ~/env/assets/job2cool && docker compose up -d --build job2cool-backend
```

The container joins the external `noted-network` (shared services) and
`logus2k_network` (voice + site proxy). Public access is **proxy_server (nginx) →
oauth2-proxy (Google) → job2cool-backend**, under the sub-path `/job2cool/`; the
backend reads the authenticated identity from `X-Forwarded-*`. Two deployment facts
that bit during the build and are worth recording: the frontend is **baked, not
bind-mounted** (so frontend edits need a rebuild), and the nginx upload limit must be
set on **both** the `/job2cool/` block **and** the shared `/oauth2/auth` subrequest
(the auth subrequest also enforces body size), with a single-file mount applied via
`docker restart proxy_server`.

## 12.2 The event-driven (no-polling) principle

A project-wide rule: **the browser never polls.** `setTimeout`/`setInterval` for
data-fetching are banned; live updates are **pushed** over Socket.IO (or SSE for
one-way streams). This is realised in three places: the live-document buffers (SSE,
§07), the live KB build-progress (Socket.IO `kb:progress`, §10.7), and the
infrastructure health map (below). Where the *absence* of an event must be detected
(staleness), the solution is still timer-free — a CSS animation, not a `setInterval`.

## 12.3 Live infrastructure monitoring (Help & Support)

The Help & Support view is a **self-documenting, live-monitored architecture map** —
the concrete rendering of the arc's "final system" box (§02). It is both
**documentation** (the authoritative, always-current picture of job2cool's
request-path dependencies) and **live monitoring** (each container carries a health
dot updated continuously while the page is open).

**Scope.** 16 boxes — only the containers a user request actually traverses (browser,
edge+identity, the backend, its direct dependencies, the KB engine stack, the model
host, and the voice stack). Deliberately *excluded*: noted's ingestion/training infra
(Airflow ×5, Postgres, Redis, MLflow, MinIO, Evidently) — it powers KB
ingestion/ops, not the request path.

**Server side** (`backend/health_monitor.py`). A single `asyncio` loop probes ~13
containers over HTTP every ~10s and pushes a `health:status` snapshot to a Socket.IO
room — **but only while at least one browser is watching** (watcher-gated; nobody
watching ⇒ no probing). Each probe maps to a colour: connection error/timeout →
**red** (down), HTTP 5xx → **orange** (degraded), any other response → **green**
(liveness). Two special cases: `websearch_server` (isolated network) is observed
through a side-effect-free `GET /backends/health` passthrough on mcp-service; and the
backend stamps *itself* `ok` — if it dies, **no push arrives at all**, which the
client watchdog turns into the correct all-red signal.

**Client side** (`frontend/js2c/architecture.js` + `help.js`). A hand-authored,
data-driven **SVG** (no graph library — the topology is fixed, recolouring a dot is a
one-line attribute set), colour-coded by network. The **staleness watchdog is a CSS
animation**: a "live feed" badge runs a keyframe decay green→yellow→orange→red over
~40s; every incoming push **restarts** the animation (an event-driven reset, not a
timer); if pushes stop, the browser's own animation clock carries the badge to red
and the `animationend` event dims all dots. With a 10s heartbeat and a 40s window:
one missed beat ≈ yellow, two ≈ orange, silent ≈ red. A standalone
`documents/architecture_preview.html` renders the same module with mock health for
offline iteration.

## 12.4 Why this is a contribution, not just ops

The monitoring feature does triple duty for the report:

1. It is the **architecture diagram the report requires**, kept honest by being
   generated from (and health-checked against) the running system.
2. It demonstrates the **event-driven design discipline** (no polling, even for
   staleness) as a concrete engineering choice with a non-obvious solution (the CSS
   watchdog).
3. It directly supports the **demo / oral presentation** ("show the system running")
   and the operability the rubric's "sound engineering" criterion rewards — when a
   model host wedges or a KB engine is down, the failure is localised at a glance
   instead of surfacing as a vague chat error.

## 12.5 Limitations

Liveness, not deep health (a green dot means "responded < 500", not "every subsystem
healthy"); watcher-gated (a UI dashboard, not a Prometheus/alerting pipeline);
websearch and oauth2-proxy observed indirectly / by a liveness ping. These are
appropriate for a single-operator demo and are recorded honestly (§15).
