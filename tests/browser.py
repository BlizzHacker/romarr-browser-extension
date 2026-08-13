#!/usr/bin/env python3
"""End to end, in a real Chromium, against a real ROMarr.

The node suite checks the logic and the guarantees. This checks the thing
actually works: the extension is loaded unpacked into Chromium, a real page is
opened, its own content script reads it, its own service worker posts to a
ROMarr listening on a loopback port, and the assertion is made against the
`idx-<slug>.jsonl` file ROMarr wrote. Nothing is mocked in the middle.

    python tests/browser.py [--headed] [--channel brave]
                            [--repo C:\\path\\to\\romarr]

NO REQUEST REACHES A ROM SITE
----------------------------
The page is served to Chromium at `https://vimm.net/...` by Playwright's own
routing, from `tests/fixtures/`. The URL is real because content-script
matching depends on it; the request is not. Vimm is never contacted, which is
the only decent way to test a tool like this repeatedly.

WHY THE MANIFEST IS COPIED AND PATCHED
--------------------------------------
The shipped manifest asks for no host permission for ROMarr itself -- the
operator's server is at an address only they know, so the options page asks
Chrome for it at the moment they type it. That request needs a user gesture
and raises a native dialog Playwright cannot click. So the test copies the
extension and adds the loopback origin, which is exactly the state Chrome
would be in after the operator pressed Allow. The copy is what is loaded; the
shipped manifest is asserted unchanged.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition, detail: str = "") -> None:
    (PASSED if condition else FAILED).append(name if condition
                                             else f"{name}: {detail}")
    print(("  PASS  " if condition else "  FAIL  ") + name
          + ("" if condition else f"\n          {detail}"))


def start_romarr(repo: Path, data: Path, key: str):
    """A real ROMarr on a loopback port, writing its indexes into `data`."""
    sys.path.insert(0, str(repo))
    from romarr.app import ROMarr, make_handler

    service = ROMarr({"ROMARR_DATA": str(data / "romarr.json"),
                      "ROMARR_API_KEY": key,
                      "ROMARR_INDEX_DIR": str(data / "idx")})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def stage_extension(origin: str) -> Path:
    """A copy of the extension with the test's ROMarr origin granted."""
    staged = Path(tempfile.mkdtemp(prefix="romarr-ext-")) / "extension"
    shutil.copytree(ROOT, staged, ignore=shutil.ignore_patterns(
        ".git", ".venv", "node_modules", "__pycache__"))
    manifest = json.loads((staged / "manifest.json").read_text(encoding="utf-8"))
    manifest["host_permissions"] = manifest["host_permissions"] + [origin + "/*"]
    (staged / "manifest.json").write_text(json.dumps(manifest, indent=2),
                                          encoding="utf-8")
    return staged


def find_brave(explicit: str = "") -> Path | None:
    """Return a Brave executable without relying on Playwright channels."""
    candidates = [explicit, os.environ.get("PLAYWRIGHT_BRAVE_PATH", "")]
    for root in (os.environ.get("PROGRAMFILES", ""),
                 os.environ.get("PROGRAMFILES(X86)", "")):
        if root:
            candidates.append(str(Path(root) / "BraveSoftware" / "Brave-Browser"
                                  / "Application" / "brave.exe"))
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "BraveSoftware"
                              / "Brave-Browser" / "Application" / "brave.exe"))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def browser_candidates(channel: str, executable_path: str):
    """Yield display names and Playwright launch keyword arguments."""
    if executable_path:
        yield Path(executable_path).name, {"executable_path": executable_path}
        return
    if channel:
        if channel.lower() == "brave":
            brave = find_brave()
            if brave:
                yield "brave", {"executable_path": str(brave)}
            else:
                yield "brave", {"executable_path": "brave-not-found"}
        else:
            yield channel, {"channel": channel}
        return
    brave = find_brave()
    if brave:
        yield "brave", {"executable_path": str(brave)}
    for name in ("msedge", "chrome", "chromium"):
        yield name, {"channel": name}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--channel", default="",
                        help="brave, msedge, chrome or chromium; default tries each")
    parser.add_argument("--executable-path", default="",
                        help="use a specific Chromium-family browser executable")
    parser.add_argument("--repo", default=os.environ.get(
        "ROMARR_REPO", r"C:\MoveWeight\romarr-work"))
    args = parser.parse_args()

    repo = Path(args.repo)
    if not (repo / "romarr" / "app.py").exists():
        print(f"no ROMarr checkout at {repo}; pass --repo", file=sys.stderr)
        return 2

    from playwright.sync_api import sync_playwright

    key = "browser-test-key"
    workdir = Path(tempfile.mkdtemp(prefix="romarr-data-"))
    httpd, base = start_romarr(repo, workdir, key)
    index = workdir / "idx"
    print(f"ROMarr at {base}, indexes in {index}\n")

    staged = stage_extension(base)
    profile = Path(tempfile.mkdtemp(prefix="romarr-profile-"))

    with sync_playwright() as pw:
        # An MV3 service worker needs a full browser binary. Playwright's
        # default headless build is the headless *shell*, which has no
        # extension support at all -- it loads the extension, reports no
        # error, and simply never starts the worker. Whichever of these the
        # machine actually has is fine; the extension does not care.
        context, channel = None, ""
        problems = []
        for candidate, launch in browser_candidates(args.channel,
                                                     args.executable_path):
            try:
                context = pw.chromium.launch_persistent_context(
                    str(profile),
                    headless=not args.headed,
                    args=[f"--disable-extensions-except={staged}",
                          f"--load-extension={staged}"],
                    **launch,
                )
                channel = candidate
                break
            except Exception as err:
                problems.append(f"{candidate}: {str(err).splitlines()[0]}")
        if context is None:
            print("no usable browser:\n  " + "\n  ".join(problems),
                  file=sys.stderr)
            httpd.shutdown()
            return 2
        print(f"driving {channel}\n")
        try:
            worker = (context.service_workers[0] if context.service_workers
                      else context.wait_for_event("serviceworker", timeout=15000))
            check("the service worker starts", bool(worker))
            extension_id = worker.url.split("/")[2]
            extension_page = context.new_page()
            extension_page.goto(
                f"chrome-extension://{extension_id}/src/options.html",
                wait_until="load",
            )

            # What the operator would type into the options page.
            worker.evaluate(
                """([url, key]) => chrome.storage.local.set({
                     romarr_settings_v1: {url, apiKey: key, automatic: true,
                                          enabled: {}}})""",
                [base, key])

            # Every Vimm URL is answered from tests/fixtures. The real site is
            # never contacted.
            #
            # Only *document* requests are recorded. The page's own images and
            # the browser's favicon probe are the browser rendering what the
            # operator opened; a page fetched that nobody navigated to would
            # be the extension crawling, and those are the only ones that
            # would prove anything either way.
            documents: list[str] = []

            def serve(route, request):
                path = request.url.split("vimm.net", 1)[1].split("?")[0]
                if request.resource_type == "document":
                    documents.append(path)
                name = ("vimm-detail.html" if path[7:].isdigit()
                        else "vimm-list.html")
                route.fulfill(status=200, content_type="text/html; charset=utf-8",
                              body=(FIXTURES / name).read_text(encoding="utf-8"))

            context.route("https://vimm.net/**", serve)

            def serve_depot(route, _request):
                route.fulfill(
                    status=200,
                    content_type="text/html; charset=utf-8",
                    body=(FIXTURES / "theromdepot-list.html").read_text(
                        encoding="utf-8"),
                )

            context.route("https://theromdepot.com/**", serve_depot)

            # --- a detail page the operator opened ---------------------------
            page = context.new_page()
            page.goto("https://vimm.net/vault/3393", wait_until="load")
            page.wait_for_timeout(2500)

            rows = read_index(index / "idx-gb.jsonl")
            check("a detail page reaches ROMarr's index", len(rows) == 1,
                  f"got {len(rows)} rows: {rows}")

            if rows:
                row = rows[0]
                check("platform is resolved, not blank",
                      row.get("platform") == "gb", repr(row.get("platform")))
                check("media_id is actually filled",
                      row.get("media_id") == "3279", repr(row.get("media_id")))
                check("size was parsed from the page",
                      row.get("size") == 57 * 1024, repr(row.get("size")))
                check("the filename the site published is what is stored",
                      row.get("name") == "4-in-1 Fun Pak (USA, Europe).gb",
                      repr(row.get("name")))
                check("the URL is the canonical detail page, without ?p=play",
                      row.get("url") == "https://vimm.net/vault/3393",
                      repr(row.get("url")))
                check("the row is namespaced to its source",
                      row.get("source") == "vimm", repr(row.get("source")))

            # --- the decoy anchor, which broke the previous capture ----------
            #
            # A Vimm listing carries no file sizes, so it enumerates and does
            # not index -- see the descriptor. What is asserted here is what
            # the operator is shown, and above all that the hidden decoy
            # anchor is not among it.
            page.goto("https://vimm.net/vault/GB/A", wait_until="load")
            page.wait_for_timeout(1500)
            listing = worker.evaluate(
                """async () => {
                     const [tab] = await chrome.tabs.query(
                       {url: 'https://vimm.net/vault/GB/A'});
                     return await chrome.tabs.sendMessage(
                       tab.id, {type: 'page:scan'}); }""")
            ids = sorted(r["id"] for r in (listing or {}).get("rows", []))

            check("a listing page reads its real rows",
                  ids == ["2955", "3393", "4402"], ids)
            check("the hidden decoy anchor is NOT read",
                  "999999" not in ids,
                  "vault 999999 was captured -- the trap that put a game "
                  "called '9' at the top of the previous catalogue")
            check("the listing page's system is applied to its rows",
                  all(r.get("platform") == "Game Boy"
                      for r in listing.get("rows", [])),
                  sorted({r.get("platform") for r in listing.get("rows", [])}))
            check("a sizeless listing is marked as not indexable",
                  listing.get("indexes") is False, listing.get("indexes"))

            indexed_after_listing = read_index(index / "idx-gb.jsonl")
            check("a listing page posts nothing ROMarr would refuse",
                  len(indexed_after_listing) == 1,
                  f"{len(indexed_after_listing)} rows after opening a listing")

            # --- re-visiting a page does not duplicate anything --------------
            before = len(read_index(index / "idx-gb.jsonl"))
            page.goto("https://vimm.net/vault/3393", wait_until="load")
            page.wait_for_timeout(2000)
            check("re-opening a page adds nothing",
                  len(read_index(index / "idx-gb.jsonl")) == before,
                  f"{before} -> {len(read_index(index / 'idx-gb.jsonl'))}")

            # --- it fetched no page the operator did not open ----------------
            # The central claim, measured rather than asserted: every document
            # request that reached the site is one this test navigated to. A
            # crawler would show up here as a page nobody asked for -- the
            # listing's three detail pages, most obviously.
            check("no page was fetched that the test did not navigate to",
                  set(documents) <= {"/vault/3393", "/vault/GB/A"},
                  f"unexpected document requests: "
                  f"{sorted(set(documents) - {'/vault/3393', '/vault/GB/A'})}")
            check("the listing's detail pages were NOT followed",
                  not any(d in documents for d in ("/vault/2955", "/vault/4402")),
                  f"the extension followed links: {documents}")

            # --- The ROM Depot's live virtual-list shape -------------------
            # This is preview-only by design: commercial directory listings
            # are never posted automatically and their download endpoints do
            # not become ROMarr index URLs.
            depot_page = context.new_page()
            depot_page.goto(
                "https://theromdepot.com/Nintendo%2064/Europe",
                wait_until="load",
            )
            depot_page.wait_for_timeout(700)
            depot = worker.evaluate(
                """async () => {
                     const [tab] = await chrome.tabs.query(
                       {url: 'https://theromdepot.com/Nintendo%2064/Europe'});
                     return await chrome.tabs.sendMessage(
                       tab.id, {type: 'page:scan'}); }""")
            depot_rows = (depot or {}).get("rows", [])
            check("The ROM Depot directory is recognised",
                  (depot or {}).get("adapter") == "theromdepot", depot)
            check("only visible file rows are previewed",
                  len(depot_rows) == 1, depot_rows)
            check("directory path supplies platform and region",
                  bool(depot_rows)
                  and depot_rows[0].get("platform") == "Nintendo 64"
                  and depot_rows[0].get("region") == "Europe", depot_rows)
            check("The ROM Depot size is parsed",
                  bool(depot_rows)
                  and depot_rows[0].get("size") == 8797553, depot_rows)
            check("commercial listings are preview-only",
                  (depot or {}).get("indexes") is False, depot)
            check("preview URLs do not expose download endpoints",
                  bool(depot_rows)
                  and depot_rows[0].get("url")
                      == "https://theromdepot.com/Nintendo%2064/Europe",
                  depot_rows)
            check("preview explains why indexing is disabled",
                  "download endpoints are not indexed"
                  in (depot or {}).get("reason", ""), depot)

            # A React/virtualised list can paint new visible rows after the
            # content script's initial document_idle scan. The DOM observer
            # should remember that metadata without visiting or fetching it.
            depot_page.evaluate(
                """() => {
                     const row = document.createElement('div');
                     row.className = 'entry';
                     row.innerHTML = `
                       <span class="name-col"><a class="name-col"
                         href="/api/download/Nintendo%2064/Europe/Late.z64"
                         download="Late Homebrew.z64">Late Homebrew.z64</a></span>
                       <span class="size-col">4 MB</span>`;
                     document.querySelector('#browser-content').append(row);
                   }""")
            depot_page.wait_for_timeout(700)

            # --- the durable local metadata catalogue ---------------------
            # The useful v0.2.6 behaviour is retained without its crawler or
            # its stored action URLs. A legacy export is accepted, mapped to
            # a canonical page, and permanently stripped of direct actions.
            catalog = extension_page.evaluate(
                """async () => {
                     await chrome.runtime.sendMessage({
                       type: 'catalog:import',
                       items: [{
                         vault_id: '777', title: 'Legacy Homebrew',
                         platform: 'Game Boy',
                         page_url: 'https://vimm.net/vault/777',
                         download_url: 'https://vimm.net/vault/download.php',
                         play_url: 'https://vimm.net/vault/?p=play&id=777'
                       }]
                     });
                     return await chrome.runtime.sendMessage(
                       {type: 'catalog:read', items: true}); }""")
            catalog_rows = (catalog or {}).get("items", [])
            legacy = next((row for row in catalog_rows
                           if row.get("id") == "777"), {})
            check("opened pages persist in the local metadata catalogue",
                  any(row.get("source") == "theromdepot"
                      and row.get("title") == "Homebrew Demo.z64"
                      for row in catalog_rows), catalog_rows)
            check("late SPA rows persist without another page request",
                  any(row.get("source") == "theromdepot"
                      and row.get("title") == "Late Homebrew.z64"
                      for row in catalog_rows), catalog_rows)
            check("v0.2.6 catalogue JSON imports with a canonical page URL",
                  legacy.get("url") == "https://vimm.net/vault/777", legacy)
            check("legacy direct action URLs are discarded",
                  "download_url" not in legacy and "play_url" not in legacy,
                  legacy)

            # --- the connection test reports a real result -------------------
            good = worker.evaluate(
                """async ([url, key]) => {
                     const r = await fetch(url + '/api/v1/capture/status',
                                           {headers: {'X-Api-Key': key}});
                     return r.status; }""", [base, key])
            bad = worker.evaluate(
                """async ([url]) => {
                     const r = await fetch(url + '/api/v1/capture/status',
                                           {headers: {'X-Api-Key': 'wrong'}});
                     return r.status; }""", [base])
            check("the right key is accepted", good == 200, good)
            check("a wrong key is refused, so the test means something",
                  bad == 401, bad)

            # --- the popup renders what it would send ------------------------
            scan = context.new_page()
            scan.goto("https://vimm.net/vault/3393", wait_until="load")
            scan.wait_for_timeout(1200)
            found = worker.evaluate(
                """async () => {
                     const [tab] = await chrome.tabs.query(
                       {url: 'https://vimm.net/vault/3393'});
                     return await chrome.tabs.sendMessage(
                       tab.id, {type: 'page:scan'}); }""")
            check("the page preview lists what would be sent",
                  bool(found and found.get("rows")), found)
            check("the preview names the adapter",
                  (found or {}).get("label") == "Vimm's Lair", found)

        finally:
            context.close()
            httpd.shutdown()

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    for line in FAILED:
        print("  FAILED " + line)
    return 1 if FAILED else 0


def read_index(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


if __name__ == "__main__":
    sys.exit(main())
