// Online, consistent SQLite backup — run INSIDE the live reins container.
//
//   docker compose exec -T -e BACKUP_DEST=/data/backups/reins-<ts>.db reins node < backup-db.js
//
// Fed over stdin (node executes stdin as a script) so ship.sh never has to
// escape a multi-line program through ssh. Uses better-sqlite3's online backup
// API, which captures a transactionally-consistent copy of a live WAL database
// without stopping writes — a raw `cp` of a WAL db can be torn/incomplete.
//
// Both the source and the produced backup are integrity-checked; any failure
// exits non-zero so the caller (ship.sh, under `set -e`) ABORTS the deploy.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const src = process.env.REINS_DB || "/data/reins.db";
const dest = process.env.BACKUP_DEST;

function die(msg) {
  console.error("backup FAILED: " + msg);
  process.exit(1);
}

if (!dest) die("BACKUP_DEST not set");
if (!fs.existsSync(src)) die(`source db not found at ${src}`);

fs.mkdirSync(path.dirname(dest), { recursive: true });

const source = new Database(src, { readonly: true, fileMustExist: true });

// Refuse to back up an already-corrupt source — better to fail loudly than to
// archive garbage and overwrite a good prior backup with it.
const srcOk = source.pragma("integrity_check", { simple: true });
if (srcOk !== "ok") die(`source integrity_check returned: ${srcOk}`);

source
  .backup(dest)
  .then(() => {
    source.close();
    // Verify the copy opens, passes integrity_check, and carries real schema.
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    const copyOk = copy.pragma("integrity_check", { simple: true });
    const objects = copy.prepare("SELECT count(*) AS n FROM sqlite_master").get().n;
    const projects = copy.prepare("SELECT count(*) AS n FROM projects").get().n;
    const events = copy.prepare("SELECT count(*) AS n FROM events").get().n;
    copy.close();
    if (copyOk !== "ok") die(`backup integrity_check returned: ${copyOk}`);
    if (objects === 0) die("backup has an empty schema — refusing to trust it");
    const bytes = fs.statSync(dest).size;
    console.log(
      `backup OK → ${dest}  (${bytes} bytes, ${objects} schema objects, ${projects} projects, ${events} events)`
    );
    process.exit(0);
  })
  .catch((e) => die(String((e && e.stack) || e)));
