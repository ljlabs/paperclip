# Paperclip — System Overview

Paperclip is a **control plane for autonomous AI companies**. One instance hosts multiple companies. Each company has an org chart of AI agents, a goal hierarchy, tasks, budgets, and a governance layer (approvals, board oversight).

---

## High-Level Architecture

```mermaid
graph TD
    subgraph "Client Layer"
        UI["Board UI\n(React + Vite)"]
        CLI["CLI\n(paperclipai)"]
        AGENT["Agent Runtimes\n(Claude, Codex, OpenClaw, etc.)"]
    end

    subgraph "API Server (server/)"
        APP["Express App\n(app.ts)"]
        AUTH["Auth Middleware\n(board session / agent API key / JWT)"]
        ROUTES["REST Routes\n(/api/*)"]
        SERVICES["Business Services\n(agents, issues, approvals, costs, heartbeat)"]
        ADAPTERS["Adapter Runtime\n(process / http / local AI)"]
        PLUGINS["Plugin System\n(plugin-loader, plugin-worker-manager)"]
        REALTIME["WebSocket\n(live-events-ws)"]
    end

    subgraph "Data Layer"
        DB["PostgreSQL\n(embedded PGlite or external)"]
        SECRETS["Secrets Store\n(AES-256-GCM encrypted)"]
        STORAGE["File Storage\n(local disk or S3)"]
    end

    subgraph "External"
        LLM["LLM APIs\n(OpenAI, Anthropic, Google, etc.)"]
        S3["S3-compatible\nObject Storage"]
    end

    UI -->|HTTP + WS| APP
    CLI -->|HTTP| APP
    AGENT -->|Bearer API key| APP

    APP --> AUTH
    AUTH --> ROUTES
    ROUTES --> SERVICES
    SERVICES --> ADAPTERS
    SERVICES --> PLUGINS
    SERVICES --> REALTIME
    SERVICES --> DB
    SERVICES --> SECRETS
    SERVICES --> STORAGE

    ADAPTERS -->|spawn / HTTP| AGENT
    STORAGE -->|optional| S3
    ADAPTERS -->|optional| LLM
```

---

## Package Map

| Package | Path | Purpose |
|---|---|---|
| `server` | `server/` | Express REST API, auth, orchestration services, adapters |
| `ui` | `ui/` | React + Vite board operator interface |
| `db` | `packages/db/` | Drizzle ORM schema, migrations, DB client factory |
| `shared` | `packages/shared/` | Shared types, validators, API path constants |
| `adapter-utils` | `packages/adapter-utils/` | Process spawning, env handling, skill sync utilities |
| `adapters/*` | `packages/adapters/` | Specific adapter implementations (claude, codex, gemini, etc.) |
| `plugin-sdk` | `packages/plugins/sdk/` | Plugin authoring SDK |
| `cli` | `cli/` | Setup, config, doctor, worktree, client commands |

---

## Deployment Modes

| Mode | Exposure | Auth | Use Case |
|---|---|---|---|
| `local_trusted` | loopback only | None (implicit board) | Single-operator local dev |
| `authenticated` | `private` | Session login | Private network (Tailscale/VPN) |
| `authenticated` | `public` | Session login | Internet-facing cloud deployment |

See `doc/DEPLOYMENT-MODES.md` for full details.

---

## Data Flow: Agent Heartbeat Invocation

```mermaid
sequenceDiagram
    participant Scheduler
    participant HeartbeatService
    participant Adapter
    participant AgentProcess
    participant DB

    Scheduler->>HeartbeatService: tick (per-agent interval)
    HeartbeatService->>DB: check agent status + budget
    alt agent paused or over budget
        HeartbeatService-->>Scheduler: skip
    else agent eligible
        HeartbeatService->>DB: create heartbeat_run (queued)
        HeartbeatService->>Adapter: invoke(agent, context)
        Adapter->>AgentProcess: spawn / HTTP call
        AgentProcess-->>Adapter: stdout/stderr / response
        Adapter-->>HeartbeatService: RunResult
        HeartbeatService->>DB: update heartbeat_run (succeeded/failed)
        HeartbeatService->>DB: update agent.last_heartbeat_at
    end
```

---

## Data Flow: Board Mutation (Authenticated Mode)

```mermaid
sequenceDiagram
    participant Browser
    participant Express
    participant AuthMiddleware
    participant BoardMutationGuard
    participant Route
    participant Service
    participant ActivityLog

    Browser->>Express: POST /api/... (session cookie)
    Express->>AuthMiddleware: resolve actor
    AuthMiddleware->>Express: actor = {type: board, userId, ...}
    Express->>BoardMutationGuard: check Origin/Referer
    alt untrusted origin
        BoardMutationGuard-->>Browser: 403
    else trusted
        BoardMutationGuard->>Route: next()
        Route->>Service: business logic
        Service->>ActivityLog: log mutation
        Service-->>Route: result
        Route-->>Browser: 200 JSON
    end
```

---

## Key Invariants

1. Every entity belongs to exactly one company — enforced at route/service layer.
2. Agent API keys are scoped to one agent + one company — cross-company access returns 403.
3. Task checkout is atomic — single SQL `UPDATE ... WHERE status IN (?) AND assignee IS NULL`.
4. Budget hard-stop — at 100% monthly spend, agent is auto-paused and new invocations are blocked.
5. All mutations write to `activity_log` — immutable audit trail.
6. Secrets are never stored in plaintext — AES-256-GCM at rest, redacted in logs and API responses.
7. API keys are stored as SHA-256 hashes only — plaintext shown once at creation.
