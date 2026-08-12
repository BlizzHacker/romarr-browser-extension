/**
 * Site adapters, as data.
 *
 * The extension this grew out of hardcoded one site across four files. Adding
 * a second would have meant a second extension. So a site here is a
 * descriptor: which hosts it covers, which of its pages carry catalogue rows,
 * and where each field lives on them. The interpreter is extract.js and it is
 * the same for every site.
 *
 * WHICH SITES ARE HERE, AND WHY ONLY THESE
 * ----------------------------------------
 * An adapter is only worth writing for a site a plain HTTP client genuinely
 * cannot read. ROMarr already has plugins for the sites it can read, and
 * duplicating one here would mean asking a person to browse pages a server
 * could have fetched on its own. The four below each fail for a different
 * reason that a real browser answers honestly, and the four that are absent
 * are listed in the README with the reason each is absent. Read that before
 * adding a fifth.
 *
 * WHAT A DESCRIPTOR MAY NOT DO
 * ----------------------------
 * There is no `crawl`, no `follow`, no `nextPage`. A descriptor describes how
 * to read the page in front of the user and nothing else, because the
 * extension's whole claim to being honest rests on it having seen only what
 * the user saw. That is enforced rather than promised: tests/no-crawling.test
 * fails the build if a fetch of a site origin appears anywhere in src/.
 */

(function (root) {
  "use strict";

  const ADAPTERS = [
    {
      id: "vimm",
      label: "Vimm's Lair",
      // Must match a key in romarr/capture.py SOURCES, which is what decides
      // the hosts ROMarr will accept rows about. A source ROMarr has never
      // heard of is refused there, by design.
      source: "vimm",
      hosts: ["vimm.net", "*.vimm.net"],
      notes: "Verified against live vault pages on 2026-08-12.",
      // Why a browser is required here: Vimm has no GET URL for a ROM. The
      // download control is a form POST to dl3.vimm.net carrying a mediaId,
      // and a GET to that URL answers 400. The only way to turn it into bytes
      // is to POST from a page you are genuinely on -- which is what a person
      // browsing is already doing, and what a plugin can never do.
      pages: [
        {
          kind: "detail",
          path: /^\/vault\/(\d+)\/?$/,
          // EVERY SELECTOR BELOW WAS READ OFF A LIVE PAGE (vault/265 and
          // vault/866, 2026-08-12) in real Chromium after Vimm's own JS ran.
          // The previous set was written from the vault's documented shape
          // and produced, on a live page: the wrong title, and an empty
          // platform, name, size and version -- which ROMarr then refused in
          // full, for want of a platform and a size. It reported itself as
          // working the whole time, because a blank field and a field a page
          // does not carry look identical from the outside.
          fields: {
            id: [{group: 1}],
            // Vimm draws the game's name into a <canvas> and leaves the text
            // only in base64 on `data-v`. There is no <h1> on a vault page at
            // all, so every text selector fell through to <title> and indexed
            // "The Vault: Double Dragon II: The Revenge (NES)" as the name.
            title: [{attr: ["h2 canvas#canvas[data-v]", "data-v"], then: ["base64"]},
                    {attr: ["canvas#canvas[data-v]", "data-v"], then: ["base64"]},
                    {text: "main h1"}, {text: "h1"},
                    {title: true, then: [["match", ["^The Vault: (.*?)\\s*\\([^)]*\\)$"]]]}],
            // The section heading, which reads "Nintendo" on an NES page --
            // and which ROMarr's platforms.resolve() maps to `nes`, as does
            // the "NES" in the page title. Both are kept: a page that renames
            // one has not renamed the other.
            platform: [{text: ".sectionTitle"},
                       {title: true, then: [["match", ["\\(([^)]+)\\)\\s*$"]]]},
                       {text: "select option:checked[value^='/vault/']"}],
            // The dump's own filename, in the second canvas, inside the
            // download table's `td#data-good-title`.
            name: [{attr: ["td#data-good-title canvas[data-v]", "data-v"], then: ["base64"]},
                   {attr: ["canvas#canvas2[data-v]", "data-v"], then: ["base64"]},
                   {label: "file name"}, {label: "filename"}],
            // Written by Vimm's own setFormat() into `td#dl_size` once the
            // page's JS has chosen a format -- so it exists for a browser and
            // does not exist in the HTML a plain GET receives. That asymmetry
            // is the whole reason this runs in a browser.
            size: [{text: "#dl_size", then: ["bytes"]},
                   {label: "file size", then: ["bytes"]},
                   {label: "size", then: ["bytes"]}],
            region: [{attr: ["img[src*='/flags/']", "title"]}, {label: "region"}],
            // A <select> the operator can change; `:checked` is what it reads
            // now, which is what the mediaId beside it refers to.
            version: [{text: "#dl_version option:checked"}, {label: "version"}],
            // Declared and never filled on all 23,980 rows of the previous
            // capture. It is the one actionable handle Vimm hands out, and it
            // is sitting in the download form the whole time. Confirmed live:
            // the static HTML carries a placeholder, and Vimm's setMediaId()
            // replaces it with the real id before a person could click.
            media_id: [{input: "mediaId"},
                       {shownAttr: ["a[href*='mediaId=']", "href"],
                        then: [["param", "mediaId"]]}],
            url: [{const: "https://vimm.net/vault/"}]
          },
          // The canonical detail URL, assembled from the id rather than from
          // location.href: the address bar carries tracking parameters and a
          // `?p=play` that must never be indexed as the game's page.
          urlFrom: (row) => "https://vimm.net/vault/" + row.id
        },
        {
          kind: "list",
          // /vault/<System>, /vault/<System>/<Letter>, and the vault root.
          // The bare-system form was missing and is the one a person actually
          // lands on: https://vimm.net/vault/NES answered "not a catalogue
          // page" on a live check, so opening a whole system showed nothing.
          //
          // Safe to widen only because the detail descriptor is tried first
          // and claims the all-digits form; no Vimm system is a bare number.
          path: /^\/vault\/(?:[A-Za-z0-9-]+(?:\/[A-Z0-9]?)?|)$/,
          // Vimm's listing rows are Title | Region | Version | Languages |
          // Rating. There is no file size anywhere on the page, and ROMarr
          // refuses a row without one -- rightly, because a catalogue entry
          // whose size is unknown cannot be presented as something to stream.
          //
          // So this page enumerates and does not index. Posting its rows
          // anyway would mean every listing page reported "0 indexed, 40
          // skipped", which is a wall of noise that trains an operator to
          // ignore the one report that matters. The popup shows what is here
          // and says the sizes live on the detail pages -- and stops there,
          // because fetching those pages is precisely the crawl this
          // extension does not do.
          indexes: false,
          rows: "table tr",
          fields: {
            // shownAttr, not attr: every listing row opens with a hidden
            // decoy anchor. See extract.visible.
            id: [{shownAttr: ["a[href^='/vault/']", "href"], then: ["digits"]}],
            title: [{shownText: "a[href^='/vault/']"}],
            region: [{attr: ["img[src*='/flags/']", "title"]}],
            version: [{text: "td:nth-child(3)"}],
            platform: [{const: ""}]
          },
          urlFrom: (row) => "https://vimm.net/vault/" + row.id,
          // A listing page states the system once, rather than on every row.
          // Live check: a listing has NO `.sectionTitle`, its `<h1>` is the
          // site's, and `<title>` is "The Vault - NES - A" -- whose
          // beforeSeparator is "The Vault", which resolves to no platform at
          // all. The system picker is the one place it is actually stated:
          // the option reads "Nintendo" and its value is "/vault/NES", and
          // ROMarr resolves either to `nes`.
          pageFields: {
            platform: [{text: "select option:checked[value^='/vault/']"},
                       {attr: ["select option:checked[value^='/vault/']", "value"],
                        then: [["match", ["/vault/(.+)$"]]]},
                       {title: true, then: [["match", ["^The Vault - ([^-]+)"]]]}]
          }
        }
      ]
    },

    {
      id: "retrostic",
      label: "Retrostic",
      source: "retrostic",
      hosts: ["retrostic.com", "*.retrostic.com"],
      notes: "Selectors verified live 2026-08-12; the site states no file "
             + "size, so ROMarr refuses the rows -- see the README.",
      // Why a browser: the download control is a form POST carrying a
      // per-render `session` token. A GET-only client cannot submit it, and
      // the token is minted for the page you are on -- so it exists only for
      // somebody who really loaded that page.
      pages: [
        {
          kind: "detail",
          path: /^\/roms\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+-(\d+)\/?$/,
          // Read off live pages on 2026-08-12 (nes/wheel-of-fortune-387,
          // snes/chrono-trigger-2803, cps-1/final-fight-8). The facts sit in
          // a two-column "Parameter | Info" table, so `label` reaches them --
          // but the values carry decoration that has to come off before
          // ROMarr can resolve them.
          fields: {
            id: [{group: 1}],
            // The <h1> is "Download Wheel of Fortune (USA) ROM"; the game is
            // the middle of it. The breadcrumb's last link is the same name
            // on its own, and is the better answer when the wrapper changes.
            title: [{text: "h1", then: [["match", ["^Download\\s+(.*?)\\s+ROM$"]]]},
                    {shownText: "ol li:last-child a"},
                    {text: "h1"},
                    {title: true, then: [["match", ["^(.*?)\\s+ROM Download"]]]}],
            // "NES (Get Emulator)" -- the cell carries a link to the emulator
            // page. Unstripped it resolves to no platform, which is what made
            // every live row unindexable.
            platform: [{label: "console", then: ["beforeParen"]},
                       {label: "system", then: ["beforeParen"]},
                       {input: "console_url"}],
            // Retrostic states "File Size: unknown" on every page observed.
            // The rule is kept pointing at the right cell so a page that does
            // carry a size works; `bytes` answers null for "unknown", which
            // is the honest outcome -- ROMarr then refuses the row for want
            // of a size, and the popup says so.
            size: [{label: "file size", then: ["bytes"]},
                   {label: "size", then: ["bytes"]}],
            // Stated as "(US)"; the brackets are the page's, not the fact's.
            region: [{label: "region", then: ["inParen"]}],
            name: [{label: "file name"}, {label: "filename"}]
          },
          urlFrom: (row, ctx) => ctx.canonical
        }
      ]
    },

    {
      id: "theromdepot",
      label: "The ROM Depot",
      source: "theromdepot",
      hosts: ["theromdepot.com", "*.theromdepot.com"],
      notes: "Reads the JSON at /api/getContents, which needs YOUR session. "
             + "Key names are matched from a candidate list, so an unexpected "
             + "shape reads fields rather than reporting an empty page -- but "
             + "the shape itself is unconfirmed. Check the popup on first run.",
      // Why a browser: every API call including the directory listing answers
      // 401 without a session. A plugin has its cookie jar cleared before
      // every request and so can never be signed in; the operator signing in
      // themselves is the only version of this that works, and it is also the
      // only version that is anybody's business but theirs.
      pages: [
        {
          // THE WHOLE CATALOGUE, IN ONE DOCUMENT.
          //
          // `/api/getContents` answers with the entire directory tree as JSON
          // to a signed-in browser. Opening that URL in a tab is an ordinary
          // navigation -- the browser renders the JSON as a document, the
          // content script reads the document it was injected into, and
          // nothing here fetches anything. It is the same act as opening a
          // browse page, and it is the cleanest capture of the four sites:
          // one page, no pagination, no DOM to guess at.
          kind: "json",
          path: /^\/api\/getContents\/?$/,
          // The tree's shape is the site's own and was not observed -- the
          // endpoint 401s without a session and nobody's session was used to
          // find out. So rows are recognised by the keys they carry rather
          // than by a path into the document, and each candidate list is
          // ordered most-likely-first. `_trail` carries the folder names a
          // row was found under, outermost first.
          collect: {
            nameKeys: ["name", "filename", "file_name", "fileName", "title", "path"],
            sizeKeys: ["size", "bytes", "filesize", "file_size", "fileSize", "length"],
            childKeys: ["children", "contents", "items", "files", "nodes", "entries"]
          },
          fields: {
            id: [{key: ["id", "_id", "hash", "md5", "sha1"]},
                 {key: ["path", "fullPath", "relativePath", "name"],
                  then: [["match", ["([^/\\\\]+)$"]]]}],
            title: [{key: ["title", "name", "filename", "file_name", "fileName"]}],
            name: [{key: ["filename", "file_name", "fileName", "name"]}],
            // A number of bytes when the API counts them, a "1.2 MB" string
            // when it formats them. `int` answers the first, `bytes` the
            // second, and whichever fires first wins.
            size: [{key: ["size", "bytes", "filesize", "file_size", "fileSize", "length"],
                    then: ["int"]},
                   {key: ["size", "sizeText", "size_human", "humanSize"],
                    then: ["bytes"]}],
            // On a file tree the console is the folder, never the file row.
            platform: [{key: ["platform", "console", "system"]},
                       {trail: 0},
                       {trail: -1}],
            region: [{key: ["region"]}],
            version: [{key: ["version", "revision"]}]
          },
          // ROMarr accepts a row only when its URL is https on the site's own
          // hosts, so a row whose path cannot be turned into one is dropped
          // by content.js rather than sent and refused.
          urlFrom: (row, ctx) => {
            const raw = row._href || row.name || "";
            if (/^https:\/\//i.test(raw)) return raw;
            const path = String(raw).replace(/^\/+/, "");
            return path ? "https://theromdepot.com/" + path : ctx.canonical;
          }
        },
        {
          // The browse pages, kept as a fallback for someone who would rather
          // capture what they are looking at than open the API. Still
          // provisional: the rendered DOM of the SPA was never observed.
          kind: "list",
          path: /^\/(?:browse|files|contents)(?:\/.*)?$/,
          rows: "table tbody tr, [role='row'], li[data-path]",
          fields: {
            id: [{attr: ["a[href]", "href"], then: [["match", ["([^/]+)$"]]]},
                 {attr: ["[data-path]", "data-path"], then: [["match", ["([^/]+)$"]]]}],
            title: [{text: "a[href]"}, {text: "[data-name]"}],
            size: [{text: "td:nth-child(2)", then: ["bytes"]},
                   {attr: ["[data-size]", "data-size"]}],
            name: [{text: "a[href]"}],
            platform: [{const: ""}]
          },
          urlFrom: (row, ctx) => ctx.canonical,
          pageFields: {
            platform: [{text: "h1"}, {text: "[aria-current='page']"}]
          }
        }
      ]
    },

    {
      id: "cdromance",
      label: "CDRomance",
      source: "cdromance",
      hosts: ["cdromance.org", "*.cdromance.org", "cdromance.com", "*.cdromance.com"],
      notes: "UNVERIFIED against a live page -- the site answers a Cloudflare "
             + "challenge to anything but a real person, so nobody here could "
             + "look. If the preview below is empty or a field says 'not "
             + "found', the selector is wrong, not the site. See README.",
      // Why a browser: every path on the site, robots.txt included, answers a
      // Cloudflare managed challenge to a plain client. This extension does
      // not solve that challenge and contains no code that could -- the
      // operator's browser already passed it, as a person, before any of this
      // ran. That distinction is the entire justification for the adapter and
      // it is worth being precise about it: passing because you are a person
      // is not the same act as defeating a check because you are not.
      pages: [
        {
          kind: "detail",
          // Both segments captured: 1 is the console category, 2 is the game.
          path: /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)\/?$/,
          // NONE of these selectors has been seen to match. CDRomance is a
          // WordPress site and these are the shapes WordPress themes use, in
          // the order they are most likely -- which is an educated guess and
          // is being labelled as one. Every field carries several candidates
          // so that being wrong about the theme is survivable, and the popup
          // names any field that came out empty.
          //
          // The one thing that is NOT a guess: whoever opens this page has
          // already passed the challenge as a person. Nothing here helps
          // them do that, and nothing here ever will.
          fields: {
            id: [{group: 2}],
            title: [{text: "h1.entry-title"}, {text: "article h1"}, {text: "h1"},
                    {meta: "og:title", then: ["beforeSeparator"]},
                    {title: true, then: ["beforeSeparator"]}],
            // A WordPress breadcrumb's last-but-one link is the category,
            // which on this site is the console. The URL's own first segment
            // is the same fact and does not depend on a theme at all, so it
            // is kept as the backstop.
            platform: [{text: ".breadcrumb a:nth-last-child(2)"},
                       {shownText: "nav[aria-label='breadcrumb'] a:nth-last-child(2)"},
                       {label: "console"}, {label: "platform"}, {label: "system"},
                       {text: ".cat-links a"}, {text: "a[rel='category tag']"},
                       // The address bar. Theme-independent, and the only
                       // candidate here that cannot be wrong about the markup.
                       {group: 1}],
            size: [{label: "size", then: ["bytes"]},
                   {label: "file size", then: ["bytes"]},
                   {text: ".file-size", then: ["bytes"]},
                   {text: ".download-size", then: ["bytes"]}],
            region: [{label: "region"}, {text: ".region"},
                     {attr: ["img[src*='flag']", "title"]}],
            name: [{label: "file name"}, {label: "filename"}]
          },
          urlFrom: (row, ctx) => ctx.canonical,
          // The console again, taken from the address bar. `/psx/tekken-3/`
          // means PSX whatever the theme calls its breadcrumbs, and a row
          // ROMarr cannot place a platform for is a row it refuses outright.
          pageFields: {
            platform: [{text: ".breadcrumb a:nth-last-child(2)"},
                       {text: "a[rel='category tag']"}]
          }
        }
      ]
    }
  ];

  /** Every host pattern, as manifest match patterns. Used by sync-manifest. */
  function matchPatterns() {
    const out = [];
    for (const adapter of ADAPTERS) {
      for (const host of adapter.hosts) out.push("https://" + host + "/*");
    }
    return out;
  }

  /** The adapter covering a hostname, or null. */
  function forHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    for (const adapter of ADAPTERS) {
      for (const pattern of adapter.hosts) {
        const bare = pattern.replace(/^\*\./, "");
        if (host === bare || host.endsWith("." + bare)) return adapter;
      }
    }
    return null;
  }

  /** The page descriptor matching a path within an adapter, or null. */
  function forPath(adapter, pathname) {
    if (!adapter) return null;
    for (const page of adapter.pages) {
      const found = page.path.exec(pathname);
      if (found) return {page, groups: found};
    }
    return null;
  }

  root.RomarrAdapters = {ADAPTERS, matchPatterns, forHost, forPath};
})(typeof globalThis !== "undefined" ? globalThis : self);
