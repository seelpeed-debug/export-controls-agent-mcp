// Shared snapshot writer for the data builders.
//
// WHY THIS EXISTS
// Every builder stamps its output with `retrievedAt`. Left alone, that means a
// rebuild always dirties the file even when the regulation has not moved, so the
// git history fills with "Refresh regulation snapshots" commits that refreshed
// nothing. For a repository whose whole point is that its answers are dated
// against a known version of the law, that destroys the audit value of the log:
// you can no longer tell from history when the regulation actually changed.
//
// So a snapshot is only written when something other than the volatile
// timestamp fields has changed. Use --force to write regardless.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Strip fields that change on every run so they cannot mask a real diff. */
function withoutVolatile(obj, volatileKeys) {
  const clone = { ...obj };
  for (const k of volatileKeys) delete clone[k];
  return clone;
}

/**
 * @param {string} outPath
 * @param {object} payload
 * @param {object} [opts]
 * @param {string[]} [opts.volatileKeys]  Fields ignored when comparing.
 * @param {boolean} [opts.force]          Write even if substantively unchanged.
 * @param {boolean} [opts.pretty]         Indent the JSON.
 * @returns {{written: boolean, reason: string, bytes: number}}
 */
export function writeSnapshotIfChanged(outPath, payload, opts = {}) {
  const { volatileKeys = ["retrievedAt"], force = false, pretty = false } = opts;
  const serialise = (o) => (pretty ? JSON.stringify(o, null, 2) + "\n" : JSON.stringify(o) + "\n");
  const next = serialise(payload);

  if (!force && existsSync(outPath)) {
    try {
      const existing = JSON.parse(readFileSync(outPath, "utf8"));
      const a = JSON.stringify(withoutVolatile(existing, volatileKeys));
      const b = JSON.stringify(withoutVolatile(payload, volatileKeys));
      if (a === b) {
        return {
          written: false,
          reason:
            `unchanged, so ${path.basename(outPath)} was left alone (only ${volatileKeys.join("/")} would have moved). ` +
            "Use --force to rewrite anyway.",
          bytes: Buffer.byteLength(next)
        };
      }
    } catch {
      // Unreadable or malformed existing file: fall through and overwrite.
    }
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, next, "utf8");
  return {
    written: true,
    reason: force ? "written (--force)" : "written: content changed",
    bytes: Buffer.byteLength(next)
  };
}

/** True when --force was passed on the command line. */
export function forceRequested(argv = process.argv) {
  return argv.includes("--force");
}
