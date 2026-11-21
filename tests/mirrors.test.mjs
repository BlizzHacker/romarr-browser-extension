/**
 * File-host mirrors, split-archive parts, and the pop-up rule.
 *
 * Run with: node --test tests/mirrors.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {loadGlobalScript} from "../scripts/sync-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {RomarrMirrors: M} = loadGlobalScript("src/mirrors.js");

test("known file hosts are recognised on every domain they use", () => {
  assert.equal(M.fileHost("https://1fichier.com/?abc123").id, "1fichier");
  assert.equal(M.fileHost("https://www.alterupload.com/?x").id, "1fichier");
  assert.equal(M.fileHost("https://datanodes.to/k2/Game.part1.rar").id, "datanodes");
  assert.equal(M.fileHost("https://multiup.io/download/ab12/Game.part1.rar").id, "multiup");
  assert.equal(M.fileHost("https://edge01.fetchio.cc/f/tok?sig=s").id, "filekeeper");
  assert.equal(M.fileHost("https://datanodes.to.evil.example/x"), null);
  assert.equal(M.fileHost("https://notdatanodes.to/x"), null);
  assert.equal(M.fileHost("not a url"), null);
});

test("landing pages are told apart from direct files", () => {
  assert.equal(M.isDirect("https://edge01.fetchio.cc/f/AbC_-9?sig=xyz"), true);
  assert.equal(M.isDirect("https://edge01.fetchio.cc/f/AbC_-9"), false, "unsigned");
  assert.equal(M.isDirect("https://a-7.1fichier.com/c1234567890"), true);
  assert.equal(M.isDirect("https://1fichier.com/?abc123"), false);
  assert.equal(M.isDirect("https://www.1fichier.com/?abc123"), false);
  assert.equal(M.isDirect("https://datanodes.to/k2/Game.part1.rar"), false,
               "a DataNodes URL ending in .rar is still its landing page");
  assert.equal(M.isDirect("https://multiup.io/download/ab12/Game.part1.rar"), false);
  assert.equal(M.isDirect("https://example.com/Game.zip"), false, "not a known host");
});

test("every split-archive spelling yields a set and a part", () => {
  assert.deepEqual(M.partInfo("Zelda [0100].part03.rar"),
                   {set: "Zelda [0100].rar", part: 3, scheme: "part"});
  assert.deepEqual(M.partInfo("game.7z.002"), {set: "game.7z", part: 2, scheme: "split"});
  assert.deepEqual(M.partInfo("game.r00"), {set: "game.rar", part: 2, scheme: "rar-volume"});
  assert.deepEqual(M.partInfo("game.z01"), {set: "game.zip", part: 1, scheme: "zip-split"});
  assert.equal(M.partInfo("game.rar"), null);
  assert.equal(M.partInfo("Game (USA).nsp"), null);
  assert.equal(M.partFromLabel("Part 4"), 4);
  assert.equal(M.partFromLabel("Pt.12"), 12);
  assert.equal(M.partFromLabel("Download"), 0);
});

test("parts group per host and set, in order, with gaps named", () => {
  const link = (url, filename, label = "") =>
    Object.assign({url, filename}, M.describe(url, filename, label));
  const groups = M.groupSets([
    link("https://datanodes.to/a/G.part3.rar", "G.part3.rar"),
    link("https://datanodes.to/b/G.part1.rar", "G.part1.rar"),
    link("https://multiup.io/download/c/G.part1.rar", "G.part1.rar"),
    link("https://multiup.io/download/d/G.part2.rar", "G.part2.rar"),
    link("https://1fichier.com/?e", "1fichier.com", "Part 1"),
    link("https://1fichier.com/?f", "1fichier.com", "Part 2"),
    link("https://example.com/readme.txt", "readme.txt")
  ]);
  const by = Object.fromEntries(groups.map((g) => [g.host + ":" + g.set, g]));
  const dn = by["datanodes:G.rar"];
  assert.deepEqual(dn.parts.map((p) => p.part), [1, 3]);
  assert.deepEqual(dn.missing, [2]);
  assert.equal(dn.complete, false);
  assert.equal(dn.kind, "mirror");
  assert.equal(by["multiup:G.rar"].complete, true);
  assert.deepEqual(by["1fichier:1Fichier parts"].parts.map((p) => p.part), [1, 2]);
  assert.equal(groups.length, 3, "a lone file is not a set");
});

test("old RAR volumes and split ZIPs find their first and last parts", () => {
  const link = (filename) => Object.assign(
    {url: "https://example.com/" + filename, filename},
    M.describe("https://example.com/" + filename, filename, ""));
  const [rar] = M.groupSets([link("g.r01"), link("g.rar"), link("g.r00")]);
  assert.equal(rar.set, "g.rar");
  assert.deepEqual(rar.parts.map((p) => p.filename), ["g.rar", "g.r00", "g.r01"]);
  assert.equal(rar.complete, true);
  const [zip] = M.groupSets([link("h.zip"), link("h.z02"), link("h.z01")]);
  assert.deepEqual(zip.parts.map((p) => p.filename), ["h.z01", "h.z02", "h.zip"]);
});

test("the pop-up rule closes only foreign tabs opened by file hosts", () => {
  const host = "https://datanodes.to/k2/Game.part1.rar";
  assert.equal(M.isPopup(host, "https://casino.example/win"), true);
  assert.equal(M.isPopup("https://nxbrew.net/game", "https://ads.example/x"), true);
  assert.equal(M.isPopup(host, "https://dl3.datanodes.to/file"), false, "the download");
  assert.equal(M.isPopup(host, "https://1fichier.com/?x"), false, "another file host");
  assert.equal(M.isPopup("https://nxbrew.net/game", "https://nxbrew.net/other"), false);
  assert.equal(M.isPopup("https://example.com/", "https://ads.example/x"), false,
               "tabs opened by ordinary sites are none of our business");
  assert.equal(M.isPopup(host, "chrome://settings"), false);
});

test("page extraction reports landing pages without a file extension", () => {
  const {RomarrExtract} = loadGlobalScript("src/extract.js");
  const scope = {};
  new Function("globalThis", "self", "window",
               readFileSync(join(ROOT, "src/mirrors.js"), "utf8") + "\n"
               + readFileSync(join(ROOT, "src/extract.js"), "utf8"))(scope, scope, scope);
  const anchors = [
    ["https://1fichier.com/?abc", "Part 1"],
    ["https://datanodes.to/k2/Game.part2.rar", "Part 2"],
    ["https://example.com/about", "About"]
  ].map(([href, text]) => ({
    getAttribute: (n) => (n === "href" ? href : null),
    hasAttribute: () => false,
    textContent: text,
    closest: () => null,
    getClientRects: () => [1],
    offsetParent: {},
    style: {},
    ownerDocument: {defaultView: {getComputedStyle: () => ({display: "block", visibility: "visible"})}}
  }));
  const doc = {querySelectorAll: () => anchors, location: {href: "https://nxbrew.net/game"}};
  assert.ok(RomarrExtract.extractDownloadLinks, "the plain extractor still loads alone");
  const found = scope.RomarrExtract.extractDownloadLinks(doc, "https://nxbrew.net/game");
  assert.deepEqual(found.map((f) => [f.host, f.kind, f.part]),
                   [["1fichier", "mirror", 1], ["datanodes", "mirror", 2]]);
});

test("the ad blocklist is a valid static ruleset the manifest names", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const [resource] = manifest.declarative_net_request.rule_resources;
  assert.equal(resource.id, "ad_networks");
  const rules = JSON.parse(readFileSync(join(ROOT, resource.path), "utf8"));
  assert.ok(rules.length >= 1);
  for (const rule of rules) {
    assert.equal(rule.action.type, "block");
    assert.ok(rule.condition.requestDomains.every((d) => /^[a-z0-9.-]+$/.test(d)));
  }
});

test("background opens pages only on request and never spoofs headers", () => {
  const source = readFileSync(join(ROOT, "src/background.js"), "utf8");
  assert.ok(!/User-Agent|Referer/i.test(source), "no header spoofing");
  assert.ok(!/webRequestBlocking/.test(source));
  assert.match(source, /MAX_OPEN_PAGES = 30/);
});
