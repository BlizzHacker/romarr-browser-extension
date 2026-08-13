#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

await import("../src/adapters.js");
await import("../src/catalog.js");

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("usage: node scripts/theromdepot-catalog.mjs getContents.json [catalog.json]");
  process.exit(2);
}

const root = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
const items = globalThis.RomarrCatalog.fromTheRomDepotTree(root);
if (!items.length) throw new Error("the input is not a The ROM Depot getContents tree");

const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  source: "The ROM Depot /api/getContents",
  items
};
const target = path.resolve(output || "theromdepot-catalog.json");
fs.writeFileSync(target, JSON.stringify(payload));

const bytes = items.reduce((total, item) => total + (item.size || 0), 0);
const platforms = new Set(items.map((item) => item.platform).filter(Boolean));
console.log(JSON.stringify({
  input: path.resolve(input),
  output: target,
  items: items.length,
  platforms: platforms.size,
  represented_bytes: bytes
}, null, 2));
