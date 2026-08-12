# ROMarr capture

A browser extension that sends catalogue rows from ROM-site pages **you open
yourself** to **your own** ROMarr.

It is not a crawler. It reads the page already in front of you, and it makes
no request to any ROM site — ever. If that claim is the reason you are here,
skip to [What it will not do](#what-it-will-not-do), which explains how it is
enforced rather than promised.

---

## Why this exists

ROMarr catalogues ROM sites through ROM Hub plugins, and a plugin's HTTP
client has two hard limits:

* **`ctx.http` is GET-only.** There is no POST, so a site whose download or
  login is a form submission is not partially supported — it is unsupported.
* **Its cookie jar is cleared before every request**, deliberately, so one
  plugin's `Set-Cookie` cannot ride along on another's. A plugin therefore
  **cannot hold a session**, so it cannot be signed in.

A site that needs a session, a form POST, or a link that only exists once its
own JavaScript has run is closed to a plugin completely.

Your browser is not. When you really browse a site, you send real cookies and
a real `Referer`, and you pass a bot check because you are not a bot. This
extension does not work around any of that — it sidesteps the problem by only
ever reading a page a person genuinely visited. That distinction is the whole
design, and it is why the adapter list is short.

---

## Install

Unpacked, from source. It is not in any web store.

**Chrome / Edge / Brave / Vivaldi**

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → choose this folder (the one with `manifest.json`)
3. Open the extension's **Details → Extension options**
4. Enter your ROMarr address and API key, press **Test connection**

**Firefox** — `about:debugging` → This Firefox → **Load Temporary Add-on** →
pick `manifest.json`.

### Which browsers this was actually tested in

Being specific, because "supports MV3" covers a lot of ground:

| Browser | Status |
|---|---|
| **Microsoft Edge 1xx (Chromium), headless and headed** | **Tested end to end.** `tests/browser.py` loads the extension unpacked, opens fixture pages, and asserts against the JSONL file ROMarr wrote. 20 checks, all passing. |
| Chrome | **Not run here** — the machine this was built on could not spawn a full Chrome/Chromium binary at all (`spawn UNKNOWN`, headed or headless). Edge is the same engine and the same MV3 runtime, and nothing in the extension is Edge-specific, but this is untested rather than tested. |
| Firefox | **Not tested.** Firefox supports MV3, but its background is an event page rather than a service worker and it uses the `browser.*` namespace with `chrome.*` aliased. Expect the load to work and the service worker registration to differ. Treat as unverified. |

Run the browser suite yourself with:

```sh
python tests/browser.py                 # picks msedge, chrome or chromium
python tests/browser.py --channel chrome
```

It needs `playwright` and a ROMarr checkout (`--repo`, default
`C:\MoveWeight\romarr-work`). It contacts **no ROM site** — every page is
served from `tests/fixtures/` through Playwright's own routing.

---

## How it works

```
page you opened ──▶ content.js ──▶ background.js ──▶ POST /api/v1/capture
   (real browser)    reads DOM      holds the key       (X-Api-Key)
                     via adapter    batches, retries          │
                                                              ▼
                                              idx-<platform>.jsonl + .done
                                              — the same files every other
                                                ROMarr indexer writes
```

Four files matter:

| File | Job |
|---|---|
| `src/adapters.js` | **The data.** One descriptor per site: hosts, which pages carry rows, where each field lives. |
| `src/extract.js` | The interpreter those descriptors are written against — pickers (`text`, `label`, `attr`, `input`, …) and transforms (`bytes`, `digits`, `param`, …). |
| `src/content.js` | Runs on a page you opened. Applies the descriptor. Reads the DOM and nothing else. |
| `src/background.js` | The only file allowed to make a network request, and only to the ROMarr you configured. |

### Adding a site

Adding a site is a descriptor, not a new extension:

```js
{
  id: "example",
  label: "Example ROMs",
  source: "example",              // must match romarr/capture.py SOURCES
  hosts: ["example.com"],
  pages: [{
    kind: "detail",
    path: /^\/rom\/(\d+)$/,
    fields: {
      id:       [{group: 1}],
      title:    [{text: "h1"}],
      platform: [{label: "console"}],
      size:     [{label: "file size", then: ["bytes"]}]
    }
  }]
}
```

Then:

```sh
node scripts/sync-manifest.mjs   # regenerate the manifest's host lists
npm test
```

**And one line on the server**, in `romarr/capture.py`:

```python
SOURCES = {"example": ("Example ROMs", ("example.com",))}
```

That second step is deliberate and is not busywork. ROMarr decides which hosts
a source may claim, because the payload arrives from a web page — without it,
a page could hand your library a row pointing anywhere it liked. The server
does not take a stranger's word for which hosts are legitimate.

---

## Sites with adapters

Each of these fails for a *different* reason that a real browser answers
honestly.

| Site | Why a plain HTTP client cannot do it | Selector confidence |
|---|---|---|
| **Vimm's Lair** | No GET URL for a ROM exists. The download is a POST to `dl3.vimm.net` carrying a `mediaId`; a GET there answers 400. Only a page you are genuinely on can submit it. | **Verified** against the documented Vault structure, including both known traps. |
| **The ROM Depot** | `GET /api/getContents` returns the entire directory tree in one call — and **401** without a session. A plugin's cookie jar is cleared before every request, so it can never be signed in. You can be. | **Provisional** — the site is a React SPA and its rendered DOM was not observed. |
| **CDRomance** | Every path, `robots.txt` included, answers a Cloudflare **managed challenge** to a plain client. | **Provisional** — the site could not be surveyed, for exactly that reason. |
| **Retrostic** | Search works over plain HTTP, but the download control is a form POST carrying a **per-render `session` token** that only exists for someone who really loaded the page. | **Provisional** — form shape known from the survey; page selectors not confirmed live. |

### About "provisional"

Three of the four have selectors written from each site's *documented*
structure rather than from its live markup, because the pages were not
observed first-hand. That is stated here rather than discovered later, and the
extension is built so a wrong selector is harmless:

* **the popup previews every row before anything is sent**, so a bad selector
  reads as "nothing to capture on this page" — a bug report, not silent
  rubbish in your library;
* **ROMarr validates independently** and refuses rows with no id, no title, no
  size, an unresolvable platform, or a URL off the site's own hosts.

If you use one of these sites, open the popup on a detail page and check what
it found. Fixing an adapter is editing selectors in `src/adapters.js`.

### On CDRomance specifically

Your browser passing a Cloudflare managed challenge **because you are a
person** is not the same act as software defeating that challenge **because it
is not**. This extension contains no challenge-solving code, no clearance-cookie
handling, no fingerprint spoofing and no `navigator.webdriver` patching, and it
never will — the same line ROMarr's own headless-browser backend draws. It reads
a page you had already loaded. If you cannot load CDRomance yourself, this
extension does not help you, and that is the correct outcome.

---

## Sites deliberately **without** adapters

An adapter is only worth writing for a site a plain HTTP client genuinely
cannot read. Anything else means asking a person to browse pages a server
could have fetched on its own.

| Site | Why not |
|---|---|
| **RomuLation** | Its search already works over plain HTTP — ROMarr has a plugin. The only thing a browser would add is the download link, and that sits under `/roms/newdownload/…`, a path **its own `robots.txt` disallows**, behind a per-render encrypted token, behind a paid account. Catalogue capture would duplicate the plugin; download capture is the part we are declining. |
| **EmuParadise** | **Stopped hosting game files in 2018.** The browse tree and the entire download flow still render, and then say the game is unavailable. The catalogue is readable over plain HTTP already; a browser adds nothing. |
| **CoolROM** | Its `robots.txt` names `anthropic-ai` and `Claude-Web` with `Disallow: /`. This extension was written by one of those. The survey that produced the other adapters **stopped at `robots.txt` and fetched nothing further**, and shipping an adapter would be that same act at one remove. Whether *your* browser may visit a site you can already visit is your call, not this repository's — but it will not be pre-packaged here. |
| **Gamulator** | The origin is gone. `gamulator.com` is NXDOMAIN; `www.` resolves only to Cloudflare and returns **530 / error 1016** on every path. There is nothing to survey and nothing to index. |

---

## What it will not do

These are enforced by `tests/run.mjs`, which fails the build. They are
properties, not intentions.

* **No crawling.** There is no frontier, no visited set, no delay slider, no
  link-following. A descriptor *cannot express* one — `crawl`, `follow`,
  `nextPage`, `frontier` and `queue` are rejected as descriptor keys.
* **No requests to ROM sites, at all.** `fetch`, `XMLHttpRequest`,
  `sendBeacon`, `EventSource` and `WebSocket` are banned everywhere except
  `src/background.js`, which has exactly two call sites: the capture POST and
  the connection test. Both are built from the address you configured; a
  literal remote URL in that file fails the suite.
* **No bot-check circumvention.** No CAPTCHA solving, no Cloudflare challenge
  handling, no header spoofing, no stealth patches.
* **No credentials anywhere but your own server.** Your API key is sent as
  `X-Api-Key` to the address you configured and nowhere else. Never in a URL,
  never into a page, never logged.

The previous, site-specific version of this extension **did** crawl — it had a
frontier, a visited set and a delay control. It followed a hidden decoy anchor
(`<a href="/vault/999999" style="display:none">9</a>`) and put a game called
"9" with id 999999 at the top of a 23,980-row catalogue. `tests/browser.py`
asserts against that exact anchor, in a real browser, on a fixture that
reproduces it.

### Automatic vs manual

By default, opening a covered page sends its rows. That is still only pages
**you navigated to yourself** — nothing is opened on your behalf. Turn
automatic off in the options and nothing leaves the tab until you press
**Send** in the popup.

---

## What ROMarr does with a capture

`POST /api/v1/capture`, authenticated with your API key (`X-Api-Key`). It is
**not** an open path — a wrong key answers 401.

The payload is treated as untrusted input, because it is:

* bounded to 1 MiB, checked **before** the body is read;
* at most 500 rows, and rejected whole rather than truncated;
* `source` must be one ROMarr already knows, and every `url` must be https on
  that source's own hosts — a lookalike like `vimm.net.evil.example` fails;
* every string length-capped, every id charset-bounded, sizes bounded;
* **platforms resolved via `platforms.resolve()` and never invented.** An
  unresolvable name is reported as unmapped, not guessed. Guessing cost that
  codebase 4,173 rows filed under the wrong machine once already.

Surviving rows are appended to `idx-<slug>.jsonl` with a `.done` sidecar keyed
`<source>:<id>` — the same shape and the same namespacing the Archive.org and
Vimm indexers use, so captures load through the existing pipeline with no
special case.

The reply reports what happened, and the popup shows it:

```json
{"ok": true, "source": "vimm", "seen": 1, "indexed": 1,
 "already_indexed": 0, "skipped": 0, "skipped_reason": {},
 "unmapped_platforms": [], "platforms": {"gb": 1}}
```

`GET /api/v1/capture/status` is what **Test connection** calls. It is
authenticated on purpose — testing against `/api/health` would report success
for a key ROMarr had rejected, because health answers strangers.

---

## Two defects this design makes impossible

From the previous capture of 23,980 Vimm rows:

* **`platform` was blank on nearly every row.** It looked in exactly one
  place. Adapters now list several candidates per field, a listing page's
  system is applied to its rows, and **ROMarr refuses a row whose platform it
  cannot resolve** — so a blank one cannot be stored at all.
* **`media_id` was declared and filled on none of the 23,980.** It is Vimm's
  one actionable handle and it sits in the download form the whole time. The
  adapter reads it from there; if a page has none, the key is **omitted**
  rather than written empty. Both are asserted, in a real browser.

---

## Development

```sh
npm test                  # sync check + 20 unit/guarantee tests, no deps
npm run sync              # regenerate manifest host lists from adapters.js
python tests/browser.py   # 20 end-to-end checks in a real browser
```

`node --test` and the standard library only — there are no dependencies to
install and no build step. The extension loads from source as it sits.

---

## Licence

MIT — see `LICENSE`.
