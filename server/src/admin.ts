/**
 * Reins admin CLI — bootstrap workspaces and tokens.
 *
 *   npm run admin -- create-workspace "Acme Team"
 *   npm run admin -- mint <workspaceId> <ingest|access|admin> [label]
 *   npm run admin -- list-workspaces
 *   npm run admin -- list-tokens <workspaceId>
 *   npm run admin -- revoke <tokenId>
 *
 * Tokens are shown ONCE (only their hash is stored). Keep them safe.
 */
import "./db.js";
import {
  createWorkspace,
  mintToken,
  listWorkspaces,
  listTokens,
  revokeToken,
  getWorkspace,
} from "./auth.js";

const [cmd, ...rest] = process.argv.slice(2);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case "create-workspace": {
    const name = rest.join(" ").trim();
    if (!name) die('usage: create-workspace "<name>"');
    const ws = createWorkspace(name);
    const admin = mintToken(ws.id, "admin", "bootstrap");
    const ingest = mintToken(ws.id, "ingest", "default");
    const access = mintToken(ws.id, "access", "default");
    console.log(`\n  Workspace "${name}" created.`);
    console.log(`  id      ${ws.id}\n`);
    console.log(`  Tokens (shown once — store them now):`);
    console.log(`  admin   ${admin}   ${dim("mint/revoke tokens")}`);
    console.log(`  ingest  ${ingest}   ${dim("for hooks/agents — pass to `reins-hook install --token`")}`);
    console.log(`  access  ${access}   ${dim("for the dashboard — paste at /signin")}\n`);
    break;
  }
  case "mint": {
    const [ws, kind, ...label] = rest;
    if (!ws || !["ingest", "access", "admin"].includes(kind || ""))
      die("usage: mint <workspaceId> <ingest|access|admin> [label]");
    if (!getWorkspace(ws)) die(`no workspace "${ws}"`);
    const token = mintToken(ws, kind as any, label.join(" ") || undefined);
    console.log(`\n  ${kind} token (store now): ${token}\n`);
    break;
  }
  case "list-workspaces": {
    const ws = listWorkspaces();
    console.log(ws.length ? ws.map((w) => `  ${w.id}  ${w.name}`).join("\n") : "  (none)");
    break;
  }
  case "list-tokens": {
    const ws = rest[0];
    if (!ws) die("usage: list-tokens <workspaceId>");
    const toks = listTokens(ws);
    console.log(
      toks.length
        ? toks
            .map((t) => `  ${t.id}  ${t.kind.padEnd(7)} ${t.prefix}…  ${t.revoked ? "REVOKED" : "active"}  ${t.label ?? ""}`)
            .join("\n")
        : "  (none)"
    );
    break;
  }
  case "revoke": {
    const id = rest[0];
    if (!id) die("usage: revoke <tokenId>");
    console.log(revokeToken(id) ? "  revoked" : "  not found");
    break;
  }
  default:
    console.log(`reins admin — commands:
  create-workspace "<name>"
  mint <workspaceId> <ingest|access|admin> [label]
  list-workspaces
  list-tokens <workspaceId>
  revoke <tokenId>`);
}

function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
