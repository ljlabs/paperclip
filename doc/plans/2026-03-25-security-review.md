# Security Review — 2026-03-25

Full review of auth, secrets, data leakage, and privacy across the Paperclip codebase.

---

## Summary

The codebase has a solid security foundation. API keys are hashed at rest, secrets are AES-256-GCM encrypted, company boundaries are enforced consistently, and log redaction is thorough. The issues found are low-to-medium severity with one actionable fix applied (see §6).

---

## 1. Authentication — PASS

| Check | Result |
|---|---|
| API keys stored as SHA-256 hashes only | ✓ |
| Timing-safe comparison for key lookup | ✓ `timingSafeEqual` in `board-auth.ts` and `agent-auth-jwt.ts` |
| JWT uses HMAC-SHA256 with configurable secret | ✓ |
| JWT validates `exp`, `iss`, `aud` | ✓ |
| Board session via better-auth (not hand-rolled) | ✓ |
| Agent keys scoped to single agent + company | ✓ |
| Revoked keys rejected on every request | ✓ `revokedAt IS NULL` check |
| Board keys check expiry | ✓ `expiresAt > NOW()` check |

No issues found.

---

## 2. Authorization — PASS

| Check | Result |
|---|---|
| `assertCompanyAccess` called on all company-scoped routes | ✓ |
| Agent cannot access other company's data | ✓ `actor.companyId !== companyId` → 403 |
| Board-only operations guarded by `assertBoard` | ✓ |
| Instance admin bypass is explicit and logged | ✓ |
| CSRF protection for board session mutations | ✓ `boardMutationGuard` Origin/Referer check |
| `local_implicit` and `board_key` sources bypass CSRF correctly | ✓ not browser sessions |

No issues found.

---

## 3. Secrets & Encryption — PASS with one note

| Check | Result |
|---|---|
| Secrets encrypted AES-256-GCM at rest | ✓ |
| Random 12-byte IV per encryption | ✓ |
| GCM auth tag verified on decrypt | ✓ |
| Master key never stored in DB | ✓ |
| Master key file created with `mode: 0o600` | ✓ (no-op on Windows — documented in `04-windows-support.md`) |
| `PAPERCLIP_SECRETS_MASTER_KEY` env var supported | ✓ |
| Secret values never returned in API responses | ✓ only metadata returned |
| Secret values redacted in `activity_log` | ✓ via `redactEventPayload` |
| Strict mode blocks inline sensitive env values | ✓ |

**Note (low severity):** On Windows, `chmodSync(keyPath, 0o600)` is a no-op. The code already wraps this in `try/catch` and the call is best-effort. For multi-user Windows deployments, operators should use `PAPERCLIP_SECRETS_MASTER_KEY` env var or apply NTFS ACLs manually. Documented in `04-windows-support.md`.

---

## 4. Data Leakage in API Responses — PASS with one fix applied

### 4a. Agent `adapter_config` in list/get responses

`adapter_config` can contain sensitive env values (API keys, tokens). The routes apply `redactEventPayload()` before returning agent data in most paths.

**Fix applied (§6 below):** One path in `GET /agents/:id` returned the raw `adapterConfig` when the actor was an agent reading its own record. This has been corrected to always apply redaction for non-board actors.

### 4b. Secret routes

`GET /companies/:companyId/secrets` returns only metadata (`id`, `name`, `provider`, `latestVersion`, `description`) — never ciphertext or plaintext values. ✓

`POST /companies/:companyId/secrets` and `POST /secrets/:id/rotate` accept a `value` field but never echo it back in the response. ✓

### 4c. Activity log details

`logActivity` calls throughout routes pass `details` objects that go through `redactEventPayload()` before write. Spot-checked: agent create, agent update, secret create/rotate/delete — all redacted correctly. ✓

### 4d. Heartbeat run `context_snapshot`

`context_snapshot` in `heartbeat_runs` is a JSONB field that can contain agent context. It is not returned in list endpoints by default — only in the run detail endpoint which is board-only. ✓

---

## 5. Log Redaction — PASS

| Check | Result |
|---|---|
| Sensitive env keys redacted in process spawn logs | ✓ `redactEnvForLogs` in adapter utils |
| JWT values redacted in event payloads | ✓ `JWT_VALUE_RE` in `redaction.ts` |
| OS username masked in log output | ✓ `redactCurrentUserValue` |
| Home directory paths masked in log output | ✓ includes `C:\Users\<name>` on Windows |
| `adapter_config` redacted before activity log write | ✓ |
| `runtimeConfig` redacted before activity log write | ✓ |

No issues found.

---

## 6. Fix Applied — Agent Config Redaction Gap

**File:** `server/src/routes/agents.ts`

**Issue:** The `buildAgentDetail` function has a `restricted` option that strips `adapterConfig` entirely for non-privileged agent actors. However, the `GET /agents/:id` route was not consistently applying this restriction — an agent authenticating with its own API key could receive its own `adapterConfig` with plain values if any had not yet been migrated to secret refs.

While agents need their own config to function, returning plain secret values in the API response is unnecessary since the runtime resolution path (`resolveAdapterConfigForRuntime`) handles secret injection at invocation time.

**Fix:** The `redactForRestrictedAgentView` function already exists and correctly redacts `adapterConfig` and `runtimeConfig` to `{}` for restricted views. The `buildAgentDetail` call now consistently passes `restricted: true` when the actor is an agent (not board).

This ensures agents can read their own identity/status fields but never receive plaintext secret values through the REST API — secrets reach them only via the injected process environment at heartbeat time.

---

## 7. Privacy — PASS

| Check | Result |
|---|---|
| User email/name not leaked in agent-accessible endpoints | ✓ |
| `auth_users` only queried in board-auth paths | ✓ |
| PII in activity log limited to actor IDs (UUIDs/user IDs) | ✓ |
| No user PII in heartbeat run logs | ✓ |
| OS username masked before any log emission | ✓ |

No issues found.

---

## 8. Input Validation — PASS

All mutating routes use `validate(schema)` middleware backed by Zod schemas defined in `packages/shared/src/`. Input is rejected with `400` before reaching business logic. No raw `req.body` access without prior validation observed in security-sensitive routes.

---

## 9. File System Security — PASS with note

**Plugin UI static file serving** (`server/src/routes/plugin-ui-static.ts`): Uses `realpathSync` to resolve symlinks and verifies the resolved path is contained within the plugin's UI directory. This correctly prevents symlink-based path traversal. ✓

**Local disk storage provider**: Uses `path.resolve` for all paths and should be verified to enforce containment on upload/download. Spot-check shows object keys are validated before use. ✓

**Note:** The `resolvePathValue` template engine in adapter utils uses a dotted-path accessor on plain objects — no prototype pollution risk since it checks `typeof cursor !== "object"` at each step. ✓

---

## 10. Rate Limiting — OPEN ITEM

The spec (`doc/SPEC-implementation.md` §16) calls for rate limiting on auth and key-management endpoints. No rate limiting middleware was found in the current codebase.

**Recommendation:** Add rate limiting to:
- `POST /api/auth/*` (login, signup)
- `POST /agents/:id/keys` (key creation)
- `POST /companies/:companyId/secrets` (secret creation)
- Any endpoint that performs a DB lookup by token hash

A lightweight option is the `express-rate-limit` package. This is a medium-severity gap for `authenticated/public` deployments. For `local_trusted` deployments it is low severity.

---

## 11. Missing Security Headers — LOW

No `helmet` or equivalent security header middleware was observed. For `authenticated/public` deployments, consider adding:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy` (for the UI)

The `express` default does not set these. Low severity for API-only usage; medium for the board UI in public deployments.

---

## Findings Summary

| # | Severity | Area | Status |
|---|---|---|---|
| 1 | Low | `chmodSync` no-op on Windows for key file | Documented, no code change needed |
| 2 | Low | Agent `GET /agents/:id` could return unredacted `adapterConfig` | **Fixed** (§6) |
| 3 | Medium | No rate limiting on auth/key endpoints | Open item — `express-rate-limit` recommended |
| 4 | Low | No security headers (`helmet`) | Open item — recommended for public deployments |
