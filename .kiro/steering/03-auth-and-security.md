# Paperclip — Auth & Security

---

## Authentication Layers

```mermaid
flowchart TD
    REQ["Incoming Request"] --> AM["actorMiddleware"]

    AM --> MODE{Deployment Mode?}

    MODE -->|local_trusted| LT["actor = board\nsource = local_implicit\nno login required"]

    MODE -->|authenticated| BEARER{Authorization\nheader present?}

    BEARER -->|no| SESSION["Try better-auth session\n(cookie)"]
    SESSION -->|valid session| BOARD_SESSION["actor = board\nsource = session\nuserId from session"]
    SESSION -->|no session| ANON["actor = none"]

    BEARER -->|yes| TOKEN_TYPE{Token prefix?}

    TOKEN_TYPE -->|pcp_board_*| BOARD_KEY["Lookup board_api_keys\nby SHA-256 hash\ncheck revoked + expired"]
    BOARD_KEY -->|found| BOARD_KEY_ACTOR["actor = board\nsource = board_key"]
    BOARD_KEY -->|not found| ANON

    TOKEN_TYPE -->|pcp_agent_*| AGENT_KEY["Lookup agent_api_keys\nby SHA-256 hash\ncheck revoked"]
    AGENT_KEY -->|found| AGENT_ACTOR["actor = agent\nagentId + companyId"]
    AGENT_KEY -->|not found| JWT_TRY

    TOKEN_TYPE -->|JWT format| JWT_TRY["verifyLocalAgentJwt\nHMAC-SHA256\ncheck exp + iss + aud"]
    JWT_TRY -->|valid| JWT_ACTOR["actor = agent\nfrom JWT claims"]
    JWT_TRY -->|invalid| ANON
```

---

## Authorization Checks

Every route that touches company-scoped data calls `assertCompanyAccess(req, companyId)`:

```mermaid
flowchart TD
    AC["assertCompanyAccess(req, companyId)"] --> ATYPE{actor.type}

    ATYPE -->|board| BADMIN{isInstanceAdmin?}
    BADMIN -->|yes| PASS["✓ allowed"]
    BADMIN -->|no| BMEMBER{companyId in\nactor.companyIds?}
    BMEMBER -->|yes| PASS
    BMEMBER -->|no| FAIL["403 Forbidden"]

    ATYPE -->|agent| AMATCH{actor.companyId\n=== companyId?}
    AMATCH -->|yes| PASS
    AMATCH -->|no| FAIL

    ATYPE -->|none| FAIL
```

Board mutations additionally pass through `boardMutationGuard` which validates `Origin` / `Referer` headers to prevent CSRF when the actor source is `session`.

---

## Secret Handling Pipeline

```mermaid
flowchart LR
    INPUT["API input\nadapter_config.env"] --> NORM["normalizeAdapterConfigForPersistence\n• detect sensitive keys\n• encrypt plain values → secret_ref\n• strict mode: reject inline sensitive keys"]

    NORM --> DB[("DB\ncompany_secret_versions\n(AES-256-GCM ciphertext)")]

    DB --> RESOLVE["resolveAdapterConfigForRuntime\n• fetch + decrypt secret versions\n• substitute secret_refs → plaintext"]

    RESOLVE --> SPAWN["Child process env\n(plaintext, never logged)"]

    NORM --> REDACT["redactEventPayload\n(for activity_log / API responses)\n• replaces plain values with ***REDACTED***\n• preserves secret_ref bindings"]
```

### Encryption Details

- Algorithm: AES-256-GCM
- Key: 32-byte master key (auto-generated on first run, stored at `~/.paperclip/instances/default/secrets/master.key`)
- Per-secret: random 12-byte IV, 16-byte GCM auth tag
- Key override: `PAPERCLIP_SECRETS_MASTER_KEY` env var (base64 / hex / raw 32-char)

---

## API Key Lifecycle

```mermaid
sequenceDiagram
    participant Board
    participant API
    participant DB

    Board->>API: POST /agents/:id/keys
    API->>API: randomBytes(24) → hex token\n"pcp_agent_<48 hex chars>"
    API->>DB: INSERT agent_api_keys\n(key_hash = SHA256(token))
    API-->>Board: {key: "pcp_agent_...", id: "uuid"}\n⚠ plaintext shown ONCE only

    Note over Board,DB: Subsequent requests

    Board->>API: Authorization: Bearer pcp_agent_...
    API->>API: SHA256(token)
    API->>DB: SELECT WHERE key_hash = ?
    DB-->>API: key row (no plaintext)
    API-->>Board: 200 OK
```

---

## CSRF Protection

`boardMutationGuard` middleware runs on all non-GET/HEAD/OPTIONS requests where `actor.source === "session"`:

- Checks `Origin` header matches `http(s)://<host>` of the request
- Falls back to `Referer` header if `Origin` absent
- Allows `local_implicit` and `board_key` sources through without check (not browser sessions)
- Returns `403` with `"Board mutation requires trusted browser origin"` on mismatch

---

## Log Redaction

Two layers of redaction prevent data leakage in logs:

1. **`redactEventPayload`** (`server/src/redaction.ts`) — applied to `activity_log.details` and API responses for agent configs. Redacts any key matching `api_key`, `token`, `secret`, `password`, `authorization`, `bearer`, `jwt`, `private_key`, `cookie`, `connectionstring`. Also redacts string values that look like JWTs.

2. **`redactCurrentUserValue`** (`server/src/log-redaction.ts`) — masks OS username and home directory paths in log output. Handles `USER`, `LOGNAME`, `USERNAME`, `USERPROFILE`, `HOME` env vars and `os.userInfo()`. Includes Windows paths (`C:\Users\<name>`).

---

## Security Checklist for New Endpoints

When adding a new route:

- [ ] Call `assertCompanyAccess(req, companyId)` for any company-scoped resource
- [ ] Call `assertBoard(req)` for board-only operations
- [ ] Pass `adapter_config` through `redactEventPayload()` before logging or returning in list responses
- [ ] Write to `activity_log` for all mutating actions
- [ ] Return `401` for unauthenticated, `403` for unauthorized (not `404` to avoid enumeration)
- [ ] Validate input with a Zod schema via `validate()` middleware
- [ ] Never return raw secret values — only metadata (`name`, `provider`, `latestVersion`)

---

## Known Security Boundaries

| Boundary | Enforcement |
|---|---|
| Cross-company data access | `assertCompanyAccess` on every route |
| Agent accessing other company | `actor.companyId !== companyId` → 403 |
| Agent key revocation | `revokedAt IS NULL` check on every lookup |
| Board key expiry | `expiresAt > NOW()` check on every lookup |
| JWT expiry | `exp` claim validated in `verifyLocalAgentJwt` |
| Secrets in logs | `redactEnvForLogs` in adapter utils, `redactEventPayload` in routes |
| Secrets in API responses | `redactEventPayload` applied to `adapter_config` in agent list/get |
| File traversal in plugin UI | `realpathSync` containment check in `plugin-ui-static.ts` |
| CSRF for board sessions | `boardMutationGuard` Origin/Referer validation |
