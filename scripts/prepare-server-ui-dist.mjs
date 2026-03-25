#!/usr/bin/env node
// Cross-platform version of prepare-server-ui-dist.sh
// Copies ui/dist into server/ui-dist so the server can serve the built UI statically.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDist = resolve(repoRoot, "ui", "dist");
const serverUiDist = resolve(repoRoot, "server", "ui-dist");

if (!existsSync(resolve(uiDist, "index.html"))) {
  console.error(`Error: UI build output missing at ${uiDist}/index.html`);
  process.exit(1);
}

if (existsSync(serverUiDist)) {
  rmSync(serverUiDist, { recursive: true, force: true });
}

cpSync(uiDist, serverUiDist, { recursive: true });
console.log(`  -> Copied ui/dist to server/ui-dist`);
