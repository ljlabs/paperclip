# Paperclip — Windows Support

Paperclip runs on Windows. This document covers platform-specific behavior, known limitations, and what is already handled.

---

## What Already Works on Windows

| Area | How |
|---|---|
| Path resolution | `path.resolve()`, `os.homedir()`, `path.isAbsolute()` throughout — all cross-platform |
| Home dir expansion (`~/`) | `expandHomePrefix()` in `server/src/home-paths.ts` uses `os.homedir()` |
| Process spawning | `resolveSpawnTarget()` in `packages/adapter-utils/src/server-utils.ts` handles `.cmd`/`.bat` via `cmd.exe /d /s /c` and resolves `PATHEXT` extensions |
| PATH fallback | `defaultPathForPlatform()` returns Windows `System32` paths when `PATH` is unset |
| Command resolution | `resolveCommandPath()` checks `PATHEXT` extensions on Windows |
| Embedded PostgreSQL | `embedded-postgres` npm package handles Windows automatically |
| Log path redaction | `redactCurrentUserValue()` includes `C:\Users\<name>` candidates |
| `.cmd`/`.bat` quoting | `quoteForCmd()` escapes double-quotes for `cmd.exe` argument passing |
| Signal handling (child processes) | `child.kill("SIGTERM")` / `child.kill("SIGKILL")` — Node.js translates these to `TerminateProcess` on Windows |

---

## Windows-Specific Limitations

### 1. `chmodSync(path, 0o600)` is a no-op on Windows

**Files affected:**
- `server/src/secrets/local-encrypted-provider.ts` — master key file
- `cli/src/config/store.ts` — config backup
- `cli/src/config/secrets-key.ts` — secrets key file
- `cli/src/checks/secrets-check.ts` — secrets key repair
- `cli/src/commands/worktree.ts` — worktree key copy

**Impact:** The master key file (`master.key`) and config backups are created with default ACLs on Windows, meaning other local users on the same machine could read them.

**Mitigation:** All `chmodSync` calls are already wrapped in `try/catch` with `// best effort` comments — the code does not fail on Windows. For production Windows deployments, use `PAPERCLIP_SECRETS_MASTER_KEY` env var instead of a key file, or ensure the data directory is protected at the OS level (NTFS permissions, BitLocker).

**Recommended hardening** (not yet implemented): Use `icacls` via a child process to set restrictive ACLs on Windows. Example:
```
icacls "C:\path\to\master.key" /inheritance:r /grant:r "%USERNAME%:(R)"
```

### 2. Symlinks require Developer Mode or admin rights on Windows

**Files affected:** All adapter skill sync code (`ensurePaperclipSkillSymlink` in `packages/adapter-utils/src/server-utils.ts`), used by claude, codex, gemini, cursor, pi, opencode adapters.

**Impact:** Skill injection via symlinks will fail silently on Windows without Developer Mode enabled.

**Mitigation:** `ensurePaperclipSkillSymlink` catches errors and returns `"skipped"` — the adapter still runs, just without injected skills. Enable Developer Mode in Windows Settings → For Developers to allow symlink creation without admin rights.

### 3. Process group kill (`process.kill(-pid, "SIGTERM")`) is Unix-only

**File:** `server/src/services/workspace-runtime.ts` lines 281–291

**Impact:** The negative-PID process group kill is guarded by `if (process.platform !== "win32")` — Windows falls through to `child.kill("SIGTERM")` which works correctly.

### 4. `~/` paths in config schema defaults

**File:** `packages/shared/src/config-schema.ts`

Default values like `~/.paperclip/instances/default/db` are expanded at runtime by `resolveHomeAwarePath()` / `expandHomePrefix()` which use `os.homedir()`. These resolve correctly on Windows to `C:\Users\<name>\.paperclip\...`.

### 5. Shell-specific commands in documentation

Several docs and smoke scripts use Unix shell syntax (`rm -rf`, `chmod 600`, `eval "$(...)"`). These do not apply to Windows users. Windows equivalents:

| Unix | Windows (PowerShell) |
|---|---|
| `rm -rf ~/.paperclip/instances/default/db` | `Remove-Item -Recurse -Force "$env:USERPROFILE\.paperclip\instances\default\db"` |
| `chmod 600 master.key` | `icacls master.key /inheritance:r /grant:r "${env:USERNAME}:(R)"` |
| `eval "$(paperclipai worktree env)"` | `paperclipai worktree env --json` then set vars manually |

---

## Running on Windows

### Prerequisites

- Node.js 20+ (from nodejs.org or `winget install OpenJS.NodeJS`)
- pnpm 9+ (`npm install -g pnpm`)
- Git for Windows (for worktree commands)

### Dev Setup

```powershell
pnpm install
pnpm dev
```

Same as Unix — embedded PostgreSQL handles itself.

### Reset Dev Database

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.paperclip\instances\default\db"
pnpm dev
```

### Secrets Key File Protection

On Windows, manually restrict the key file after first run:

```powershell
$keyPath = "$env:USERPROFILE\.paperclip\instances\default\secrets\master.key"
icacls $keyPath /inheritance:r /grant:r "${env:USERNAME}:(R)"
```

Or set the key via environment variable to avoid a file entirely:

```powershell
$env:PAPERCLIP_SECRETS_MASTER_KEY = "<your-32-byte-base64-key>"
```

### Skill Sync (Adapters)

Enable Developer Mode for symlink support:

1. Settings → System → For Developers
2. Toggle "Developer Mode" on

Or run your terminal as Administrator.

---

## Platform Detection Pattern

When writing platform-specific code, use:

```typescript
if (process.platform === "win32") {
  // Windows-specific path
} else {
  // Unix path
}
```

The `defaultPathForPlatform()` and `resolveSpawnTarget()` functions in `packages/adapter-utils/src/server-utils.ts` are the canonical examples of this pattern in the codebase.
