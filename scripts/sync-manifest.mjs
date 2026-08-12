/**
 * Regenerate the manifest's host lists from the adapter data.
 *
 * Manifest V3 requires content-script matches and host permissions to be
 * declared statically, which makes them a second copy of something
 * adapters.js already states. A second copy drifts: an adapter added without
 * its host reaching the manifest is an adapter that silently never runs, and
 * that failure looks exactly like a broken selector.
 *
 * So the adapter list is the source and this writes the copy. `--check` fails
 * instead of writing, which is what the test suite runs.
 *
 *   node scripts/sync-manifest.mjs          rewrite manifest.json
 *   node scripts/sync-manifest.mjs --check  fail if it would change
 */

import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Load a plain (non-module) src file and return what it hung on globalThis. */
export function loadGlobalScript(relative) {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const scope = {};
  new Function("globalThis", "self", "window", source)(scope, scope, scope);
  return scope;
}

export function patternsFromAdapters() {
  const {RomarrAdapters} = loadGlobalScript("src/adapters.js");
  return RomarrAdapters.matchPatterns();
}

function main() {
  const path = join(ROOT, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const patterns = patternsFromAdapters();

  const before = JSON.stringify(manifest);
  manifest.host_permissions = patterns;
  manifest.content_scripts[0].matches = patterns;
  const after = JSON.stringify(manifest);

  if (process.argv.includes("--check")) {
    if (before !== after) {
      console.error(
        "manifest.json does not match src/adapters.js.\n"
        + "Run: node scripts/sync-manifest.mjs");
      process.exit(1);
    }
    console.log("manifest.json matches the adapter list (" + patterns.length
                + " host patterns)");
    return;
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("wrote " + patterns.length + " host patterns into manifest.json");
}

if (process.argv[1] && process.argv[1].endsWith("sync-manifest.mjs")) main();
