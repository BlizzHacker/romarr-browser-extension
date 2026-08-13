/**
 * The test suite. No dependencies -- `node --test` and the files themselves.
 *
 *   npm test        (or: node --test tests/)
 *
 * Two kinds of thing are checked here:
 *
 *   * the pure logic an adapter is written against -- size parsing, host
 *     matching, URL rules -- which is where the quiet wrong answers live, and
 *   * the guarantees the README makes, above all that this extension cannot
 *     crawl. A promise in a README is a hope; a promise a test enforces is a
 *     property.
 *
 * The DOM half is not tested here on purpose. Faking a DOM well enough to
 * trust the result is harder than driving a real one, so extraction is tested
 * against real Chromium in tests/browser.py, which loads this extension
 * unpacked and runs it against fixture pages and a real ROMarr.
 */

import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {loadGlobalScript, patternsFromAdapters} from "../scripts/sync-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {RomarrExtract} = loadGlobalScript("src/extract.js");
const {RomarrAdapters} = loadGlobalScript("src/adapters.js");
const catalogScope = {};
for (const file of ["adapters.js", "catalog.js"]) {
  const source = readFileSync(join(ROOT, "src", file), "utf8");
  new Function("globalThis", "self", "window", source)(
    catalogScope, catalogScope, catalogScope);
}
const {RomarrCatalog} = catalogScope;
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const srcFile = (name) => readFileSync(join(ROOT, "src", name), "utf8");
const srcFiles = () => readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".js"));

test("every extension script parses as JavaScript", () => {
  for (const name of srcFiles()) {
    const file = join(ROOT, "src", name);
    const checked = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, `${name} does not parse:\n${checked.stderr}`);
  }
});

// --- the extension cannot crawl --------------------------------------------
//
// The README's central claim. The previous, site-specific extension had a
// frontier, a visited set and a delay slider -- it was a crawler with a
// browser attached, and it followed a hidden decoy anchor into a catalogue
// entry for a game that does not exist. These tests are what stop that
// growing back.

test("only the service worker makes network requests", () => {
  for (const name of srcFiles()) {
    if (name === "background.js") continue;
    const source = srcFile(name);
    assert.ok(!/\bfetch\s*\(/.test(source),
              `${name} calls fetch; only background.js may make a request`);
    assert.ok(!/XMLHttpRequest|sendBeacon|EventSource|new WebSocket/.test(source),
              `${name} opens a connection by another name`);
  }
});

test("the service worker makes requests to exactly one place", () => {
  const source = srcFile("background.js");
  const calls = source.match(/\bfetch\s*\(/g) || [];
  assert.equal(calls.length, 2, "expected exactly two fetch call sites: the "
                                + "capture post and the connection test");
  // Both are built from the configured base URL. A literal http(s) URL in
  // this file would be a request to somewhere the operator did not choose.
  const literals = source.match(/["'`]https?:\/\/(?!\*)[^"'`\s]+/g) || [];
  const allowed = literals.filter((url) => /example|localhost|127\.0\.0\.1/.test(url));
  assert.deepEqual(literals, allowed,
                   "background.js names a remote URL literally: " + literals);
});

test("no adapter can describe following a link", () => {
  // Descriptors are read by content.js, which has no code to act on any of
  // these. Asserted anyway: the day somebody adds `nextPage` to a descriptor
  // is the day somebody adds the loop to consume it.
  const forbidden = ["crawl", "follow", "nextPage", "frontier", "delay", "queue"];
  const source = srcFile("adapters.js");
  for (const key of forbidden) {
    assert.ok(!new RegExp("\\b" + key + "\\s*:").test(source),
              `adapters.js declares "${key}", which a descriptor must not do`);
  }
});

test("the content script only ever reads the document it was injected into", () => {
  const source = srcFile("content.js");
  for (const bad of ["window.open", "document.createElement(\"iframe\")",
                     "importScripts", "eval("]) {
    assert.ok(!source.includes(bad), `content.js uses ${bad}`);
  }
});

// --- the manifest and the adapters agree ------------------------------------

test("manifest host patterns match the adapter list", () => {
  const patterns = patternsFromAdapters();
  assert.deepEqual(manifest.host_permissions, patterns);
  assert.deepEqual(manifest.content_scripts[0].matches, patterns);
});

test("the manifest is v3 and asks for no more than it needs", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "unlimitedStorage", "tabs"]);
  // The operator's ROMarr is on an address only they know, so it is asked for
  // at the moment they type it rather than claimed up front.
  assert.ok(!manifest.host_permissions.includes("https://*/*"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
});

test("every content script file exists", () => {
  for (const file of manifest.content_scripts[0].js.concat(
       [manifest.background.service_worker, manifest.options_page,
        manifest.action.default_popup])) {
    assert.ok(readFileSync(join(ROOT, file), "utf8").length, file);
  }
});

// --- adapters are well formed ----------------------------------------------

test("every adapter declares what ROMarr needs to accept it", () => {
  for (const adapter of RomarrAdapters.ADAPTERS) {
    assert.match(adapter.source, /^[a-z0-9][a-z0-9-]{0,31}$/,
                 `${adapter.id}: source must match romarr/capture.py SOURCES`);
    assert.ok(adapter.hosts.length, `${adapter.id}: no hosts`);
    assert.ok(adapter.pages.length, `${adapter.id}: no pages`);
    for (const page of adapter.pages) {
      assert.ok(page.path instanceof RegExp, `${adapter.id}: path must be a regex`);
      assert.ok(["list", "detail", "json"].includes(page.kind), `${adapter.id}: kind`);
      for (const required of ["id", "title"]) {
        assert.ok(page.fields[required],
                  `${adapter.id}/${page.kind}: no rule for ${required}`);
      }
      if (page.kind === "list") {
        assert.ok(page.rows, `${adapter.id}: a list page needs a row selector`);
      }
      if (page.kind === "json") {
        // A JSON page has no row selector -- its rows are objects. It must
        // still say how to recognise one, or the walker would collect the
        // whole document.
        assert.ok(page.collect, `${adapter.id}: a json page needs a collect block`);
        assert.ok(page.urlFrom,
                  `${adapter.id}: a json row has no href of its own, so the `
                  + `descriptor must build one`);
      }
    }
  }
});

test("every field rule names a picker and transforms that exist", () => {
  for (const adapter of RomarrAdapters.ADAPTERS) {
    for (const page of adapter.pages) {
      const groups = Object.assign({}, page.fields, page.pageFields || {});
      for (const [field, rules] of Object.entries(groups)) {
        for (const rule of [].concat(rules)) {
          const [name] = Object.keys(rule).filter((k) => k !== "then");
          const picker = name === "const" ? "const_" : name;
          assert.ok(RomarrExtract.PICKERS[picker],
                    `${adapter.id}.${field}: no picker "${name}"`);
          for (const step of [].concat(rule.then || [])) {
            const transform = typeof step === "string" ? step : step[0];
            assert.ok(RomarrExtract.TRANSFORMS[transform],
                      `${adapter.id}.${field}: no transform "${transform}"`);
          }
        }
      }
    }
  }
});

test("adapter ids and sources are unique", () => {
  const ids = RomarrAdapters.ADAPTERS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

// --- host matching ----------------------------------------------------------

test("a host resolves to its adapter, subdomains included", () => {
  assert.equal(RomarrAdapters.forHost("vimm.net").id, "vimm");
  assert.equal(RomarrAdapters.forHost("www.vimm.net").id, "vimm");
  assert.equal(RomarrAdapters.forHost("dl3.vimm.net").id, "vimm");
});

test("a lookalike host resolves to nothing", () => {
  // The check is a boundary match, not a suffix match. `endsWith("vimm.net")`
  // would happily accept this one.
  assert.equal(RomarrAdapters.forHost("vimm.net.evil.example"), null);
  assert.equal(RomarrAdapters.forHost("notvimm.net"), null);
  assert.equal(RomarrAdapters.forHost(""), null);
});

test("paths route to the right page descriptor", () => {
  const vimm = RomarrAdapters.forHost("vimm.net");
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/3393").page.kind, "detail");
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/3393").groups[1], "3393");
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/GB/A").page.kind, "list");
  assert.equal(RomarrAdapters.forPath(vimm, "/about"), null);
});

test("a whole-system vault listing is a catalogue page", () => {
  // https://vimm.net/vault/NES answered "not a catalogue page" on a live
  // check: the descriptor demanded a letter after the system. That is the
  // page a person actually lands on when they open a console.
  const vimm = RomarrAdapters.forHost("vimm.net");
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/NES").page.kind, "list");
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/Genesis").page.kind, "list");
  // Widening it must not have stolen the all-digits form from the detail page.
  assert.equal(RomarrAdapters.forPath(vimm, "/vault/265").page.kind, "detail");
});

test("The ROM Depot's API route reads as JSON, not as markup", () => {
  const depot = RomarrAdapters.forHost("theromdepot.com");
  assert.equal(RomarrAdapters.forPath(depot, "/api/getContents").page.kind, "json");
});

test("the four ROM Hub companions route to browser capture pages", () => {
  const cases = [
    ["coolrom.com", "/roms/nes/693/Contra_(USA).php", "detail"],
    ["romulation.org", "/roms/search", "list"],
    ["www.emuparadise.me", "/roms/search.php", "list"],
    ["www.webmulator.com", "/games/nintendo/contra", "detail"],
    ["www.webmulator.com", "/search.php", "list"],
  ];
  for (const [host, path, kind] of cases) {
    const adapter = RomarrAdapters.forHost(host);
    assert.ok(adapter, host);
    assert.equal(RomarrAdapters.forPath(adapter, path).page.kind, kind,
                 `${host}${path}`);
  }
});

test("browser adapters use the providers' canonical platform mappings", () => {
  const web = RomarrAdapters.forHost("webmulator.com");
  const matched = RomarrAdapters.forPath(web, "/games/sega-genesis/sonic");
  const platform = RomarrExtract.field(matched.page.fields.platform, {
    groups: matched.groups, scope: {}, document: {}, url: "https://webmulator.com/"
  });
  assert.equal(platform, "genesis-slash-megadrive");

  const emu = RomarrAdapters.forPath(
    RomarrAdapters.forHost("emuparadise.me"), "/roms/search.php").page;
  const mapping = emu.fields.platform[0].then[0][1];
  assert.equal(mapping["13"], "nes");
  assert.equal(mapping["41"], "ps2");
  assert.equal(mapping["26"], undefined, "ambiguous Neo Geo stays unmapped");
});

// --- the JSON vocabulary ----------------------------------------------------

test("base64 in an attribute decodes, and rubbish does not throw", () => {
  const {fromBase64} = RomarrExtract;
  // Exactly what vimm.net/vault/265 carries on its title canvas.
  assert.equal(fromBase64("RG91YmxlIERyYWdvbiBJSTogVGhlIFJldmVuZ2U="),
               "Double Dragon II: The Revenge");
  assert.equal(fromBase64("not base64!"), "");
  assert.equal(fromBase64(""), "");
});

test("a JSON tree yields the objects that name a file and state its size", () => {
  const tree = {
    contents: [
      {name: "NES", children: [
        {name: "Contra (USA).zip", size: 131072, id: "a1"},
        {name: "notes", children: []}
      ]},
      {name: "SNES", children: [{name: "Chrono Trigger.sfc", size: "4 MB", id: "b2"}]}
    ]
  };
  const found = RomarrExtract.jsonFiles(tree, {});
  assert.equal(found.length, 2, "a folder with no size is not a file");
  assert.equal(found[0].name, "Contra (USA).zip");
  // The folder it was found under is what states the console.
  assert.deepEqual(found[0]._trail, ["NES"]);
  assert.deepEqual(found[1]._trail, ["SNES"]);
});

test("the JSON walker survives a shape nobody predicted", () => {
  // The point of matching on keys rather than on a path: an unexpected
  // nesting must read fewer fields, not zero rows.
  const odd = {payload: {tree: {roms: [{fileName: "x.bin", fileSize: 10}]}}};
  const found = RomarrExtract.jsonFiles(odd, {});
  assert.equal(found.length, 1);
  assert.equal(found[0].fileName, "x.bin");
});

test("a byte count that is already a number is not re-parsed as a size string", () => {
  assert.equal(RomarrExtract.TRANSFORMS.int(131072), 131072);
  assert.equal(RomarrExtract.TRANSFORMS.int("131072"), 131072);
  assert.equal(RomarrExtract.TRANSFORMS.int("nope"), null);
});

test("site decoration comes off a platform and a region", () => {
  const {beforeParen, inParen} = RomarrExtract.TRANSFORMS;
  // Retrostic states these exactly so, live.
  assert.equal(beforeParen("NES (Get Emulator)"), "NES");
  assert.equal(inParen("(US)"), "US");
});

test("URL-encoded directory names decode without breaking on bad escapes", () => {
  const {urlDecode} = RomarrExtract.TRANSFORMS;
  assert.equal(urlDecode("Nintendo%2064"), "Nintendo 64");
  assert.equal(urlDecode("bad%2"), "bad%2");
});

// --- the value cleaners -----------------------------------------------------

test("sizes parse to bytes", () => {
  const {bytes} = RomarrExtract;
  assert.equal(bytes("1 KB"), 1024);
  assert.equal(bytes("1.5 MB"), 1572864);
  assert.equal(bytes("2 GiB"), 2147483648);
  assert.equal(bytes("57 bytes"), 57);
  assert.equal(bytes("1,234 KB"), 1263616);
  assert.equal(bytes("92K"), 94208, "EmuParadise uses a one-letter unit");
});

test("path-shaped source ids hash to a stable capture-safe value", () => {
  const value = RomarrExtract.idHash("/rom/Game_Boy_Color/Contra-J");
  assert.match(value, /^[a-f0-9]{8}$/);
  assert.equal(value, RomarrExtract.idHash("/rom/Game_Boy_Color/Contra-J"));
  assert.notEqual(value, RomarrExtract.idHash("/rom/NES/Contra"));
});

test("a size with no unit is not guessed at", () => {
  // Returning a bare number here would file "58368" as 58 KB or 58 GB
  // depending on nothing at all. ROMarr rejects a row with no size, which is
  // the right outcome.
  assert.equal(RomarrExtract.bytes("58368"), null);
  assert.equal(RomarrExtract.bytes(""), null);
  assert.equal(RomarrExtract.bytes("unknown"), null);
});

test("a decimal comma is not read as a thousands separator", () => {
  assert.equal(RomarrExtract.bytes("1,5 GB"), Math.round(1.5 * 1024 ** 3));
});

test("only https URLs survive", () => {
  const {httpsUrl} = RomarrExtract;
  assert.equal(httpsUrl("https://vimm.net/vault/1"), "https://vimm.net/vault/1");
  assert.equal(httpsUrl("http://vimm.net/vault/1"), "");
  assert.equal(httpsUrl("javascript:alert(1)"), "");
  assert.equal(httpsUrl("/vault/1", "https://vimm.net/x"), "https://vimm.net/vault/1");
  assert.equal(httpsUrl("not a url"), "");
});

test("a query parameter comes out of a URL", () => {
  assert.equal(RomarrExtract.param("https://dl3.vimm.net/?mediaId=3279", "mediaId"),
               "3279");
  assert.equal(RomarrExtract.param("https://vimm.net/", "mediaId"), "");
});

test("whitespace from page markup is folded", () => {
  assert.equal(RomarrExtract.clean("  Fun\n\t  Pak "), "Fun Pak");
  assert.equal(RomarrExtract.clean(null), "");
});

test("an id is pulled out of a slug", () => {
  assert.equal(RomarrExtract.digits("contra-388"), "388");
  assert.equal(RomarrExtract.digits("no-digits-here"), "");
});

// --- the safe local catalogue ----------------------------------------------

test("a v0.2.6 Vimm row imports as metadata without action URLs", () => {
  const legacy = RomarrCatalog.normalize("", {
    vault_id: "3393",
    title: "4-in-1 Fun Pak",
    platform: "Game Boy",
    page_url: "https://vimm.net/vault/3393",
    downloadable: true,
    download_url: "https://dl3.vimm.net/?mediaId=3279",
    playable: true,
    play_url: "https://vimm.net/vault/?p=play&mediaId=3279",
    media_id: "3279",
    size_bytes: 58368
  });
  assert.equal(legacy.url, "https://vimm.net/vault/3393");
  assert.equal(legacy.size, 58368);
  assert.equal(legacy.media_id, "3279");
  assert.ok(!("download_url" in legacy));
  assert.ok(!("play_url" in legacy));
});

test("catalogue merge enriches a row seen more than once", () => {
  const first = RomarrCatalog.merge([], "vimm", [{
    id: "3393", title: "4-in-1 Fun Pak", platform: "Game Boy",
    url: "https://vimm.net/vault/3393"
  }]);
  const again = RomarrCatalog.merge(first, "vimm", [{
    id: "3393", title: "4-in-1 Fun Pak", size: 58368,
    media_id: "3279", url: "https://vimm.net/vault/3393"
  }]);
  assert.equal(again.length, 1);
  assert.equal(again[0].platform, "Game Boy");
  assert.equal(again[0].size, 58368);
});

test("The ROM Depot getContents tree flattens completely and keeps directory URLs", () => {
  const rows = RomarrCatalog.fromTheRomDepotTree({
    path: "./files", name: "files", type: "directory", children: [{
      path: "Nintendo 64", name: "Nintendo 64", type: "directory", children: [{
        path: "Nintendo 64/Europe", name: "Europe", type: "directory", children: [{
          path: "Nintendo 64/Europe/Homebrew Demo.z64",
          name: "Homebrew Demo.z64", type: "file", size: 8797553,
          mtime: "2021-07-16T04:17:00.000Z"
        }]
      }]
    }]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "Nintendo 64/Europe/Homebrew Demo.z64");
  assert.equal(rows[0].platform, "Nintendo 64");
  assert.equal(rows[0].region, "Europe");
  assert.equal(rows[0].size, 8797553);
  assert.equal(rows[0].url, "https://theromdepot.com/Nintendo%2064/Europe");
  assert.ok(!("download_url" in rows[0]));
});
