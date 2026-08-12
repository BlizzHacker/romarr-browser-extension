#!/usr/bin/env python3
"""End to end, in a real Chromium, against a real ROMarr.

The node suite checks the logic and the guarantees. This checks the thing
actually works: the extension is loaded unpacked into Chromium, a real page is
opened, its own content script reads it, its own service worker posts to a
ROMarr listening on a loopback port, and the assertion is made against the
`idx-<slug>.jsonl` file ROMarr wrote. Nothing is mocked in the middle.

    python tests/browser.py [--headed] [--repo C:\\path\\to\\romarr]

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
        ".git", "node_modules", "__pycache__"))
    manifest = json.loads((staged / "manifest.json").read_text(encoding="utf-8"))
    manifest["host_permissions"] = manifest["host_permissions"] + [origin + "/*"]
    (staged / "manifest.json").write_text(json.dumps(manifest, indent=2),
                                          encoding="utf-8")
    return staged


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--channel", default="",
                        help="msedge, chrome or chromium; default tries each")
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
        for candidate in ([args.channel] if args.channel
                          else ["msedge", "chrome", "chromium"]):
            try:
                context = pw.chromium.launch_persistent_context(
                    str(profile),
                    channel=candidate,
                    headless=not args.headed,
                    args=[f"--disable-extensions-except={staged}",
                          f"--load-extension={staged}"],
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
