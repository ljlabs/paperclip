# Paperclip — Data Model

All tables live in PostgreSQL (embedded or external). Schema is managed by Drizzle ORM in `packages/db/src/schema/`.

---

## Entity Relationship Diagram

```mermaid
erDiagram
    companies {
        uuid id PK
        text name
        text description
        text status
        jsonb branding
    }

    agents {
        uuid id PK
        uuid company_id FK
        text name
        text role
        text title
        text status
        uuid reports_to FK
        text adapter_type
        jsonb adapter_config
        jsonb runtime_config
        int budget_monthly_cents
        int spent_monthly_cents
        timestamptz last_heartbeat_at
    }

    agent_api_keys {
        uuid id PK
        uuid agent_id FK
        uuid company_id FK
        text name
        text key_hash
        timestamptz revoked_at
        timestamptz last_used_at
    }

    goals {
        uuid id PK
        uuid company_id FK
        text title
        text level
        uuid parent_id FK
        uuid owner_agent_id FK
        text status
    }

    projects {
        uuid id PK
        uuid company_id FK
        uuid goal_id FK
        text name
        text status
        uuid lead_agent_id FK
    }

    issues {
        uuid id PK
        uuid company_id FK
        uuid project_id FK
        uuid parent_id FK
        text title
        text status
        text priority
        uuid assignee_agent_id FK
        timestamptz started_at
        timestamptz completed_at
    }

    issue_comments {
        uuid id PK
        uuid company_id FK
        uuid issue_id FK
        uuid author_agent_id FK
        text body
    }

    heartbeat_runs {
        uuid id PK
        uuid company_id FK
        uuid agent_id FK
        text status
        text invocation_source
        timestamptz started_at
        timestamptz finished_at
        jsonb context_snapshot
    }

    cost_events {
        uuid id PK
        uuid company_id FK
        uuid agent_id FK
        uuid issue_id FK
        text provider
        text model
        int input_tokens
        int output_tokens
        int cost_cents
        timestamptz occurred_at
    }

    approvals {
        uuid id PK
        uuid company_id FK
        text type
        text status
        jsonb payload
        uuid requested_by_agent_id FK
        uuid decided_by_user_id FK
    }

    company_secrets {
        uuid id PK
        uuid company_id FK
        text name
        text provider
        int latest_version
    }

    company_secret_versions {
        uuid id PK
        uuid secret_id FK
        int version
        jsonb material
    }

    activity_log {
        uuid id PK
        uuid company_id FK
        text actor_type
        text actor_id
        text action
        text entity_type
        text entity_id
        jsonb details
        timestamptz created_at
    }

    assets {
        uuid id PK
        uuid company_id FK
        text provider
        text object_key
        text content_type
        int byte_size
        text sha256
    }

    companies ||--o{ agents : "employs"
    companies ||--o{ goals : "has"
    companies ||--o{ projects : "has"
    companies ||--o{ issues : "has"
    companies ||--o{ approvals : "has"
    companies ||--o{ company_secrets : "has"
    companies ||--o{ activity_log : "logs"
    companies ||--o{ cost_events : "tracks"
    companies ||--o{ assets : "stores"

    agents ||--o{ agent_api_keys : "has"
    agents ||--o{ heartbeat_runs : "runs"
    agents ||--o{ cost_events : "incurs"
    agents }o--o| agents : "reports_to"

    issues ||--o{ issue_comments : "has"
    issues }o--o| issues : "parent"
    issues }o--o| projects : "belongs_to"

    company_secrets ||--o{ company_secret_versions : "versions"
```

---

## Auth Tables (managed by better-auth)

| Table | Purpose |
|---|---|
| `auth_users` | Human user accounts |
| `auth_sessions` | Active login sessions |
| `auth_accounts` | OAuth provider links |
| `auth_verifications` | Email verification tokens |
| `board_api_keys` | Long-lived board API keys (hashed) |
| `cli_auth_challenges` | CLI device-auth flow challenges |
| `instance_user_roles` | Instance-admin role grants |
| `company_memberships` | User ↔ company access grants |

---

## Status State Machines

### Agent Status

```mermaid
stateDiagram-v2
    [*] --> idle : created
    idle --> running : heartbeat invoked
    running --> idle : run complete
    running --> error : run failed
    error --> idle : board resumes
    idle --> paused : board pauses
    running --> paused : board pauses (cancel flow)
    paused --> idle : board resumes
    idle --> terminated : board terminates
    running --> terminated : board terminates
    paused --> terminated : board terminates
    error --> terminated : board terminates
    terminated --> [*]
```

### Issue Status

```mermaid
stateDiagram-v2
    [*] --> backlog : created
    backlog --> todo
    backlog --> cancelled
    todo --> in_progress : checkout
    todo --> blocked
    todo --> cancelled
    in_progress --> in_review
    in_progress --> blocked
    in_progress --> done
    in_progress --> cancelled
    in_review --> in_progress
    in_review --> done
    in_review --> cancelled
    blocked --> todo
    blocked --> in_progress
    blocked --> cancelled
    done --> [*]
    cancelled --> [*]
```

### Approval Status

```mermaid
stateDiagram-v2
    [*] --> pending : created
    pending --> approved : board approves
    pending --> rejected : board rejects
    pending --> cancelled : requester cancels
    approved --> [*]
    rejected --> [*]
    cancelled --> [*]
```

---

## Security Properties of the Data Model

- `agent_api_keys.key_hash` — SHA-256 hash only; plaintext never persisted after creation
- `board_api_keys.key_hash` — SHA-256 hash only; timing-safe comparison on lookup
- `company_secret_versions.material` — AES-256-GCM ciphertext; master key never in DB
- `agents.adapter_config` — may contain secret refs (`{type: "secret_ref", secretId}`); plain values are redacted in API responses and logs
- `activity_log.details` — event payloads are sanitized through `redactEventPayload()` before write
