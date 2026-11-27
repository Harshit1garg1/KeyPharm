"""Run with an installed Python Playwright and Chromium."""
import copy
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
types = {".html":"text/html", ".mjs":"text/javascript", ".css":"text/css", ".png":"image/png", ".woff2":"font/woff2"}


# The APK serves only the files listed in MainActivity.ASSETS; a file the handheld loads but the list misses
# works here (served from disk) yet breaks on the device, as the 0.8.0 header logo did.
java = (assets.parent / "java/be/keypharm/rfid/MainActivity.java").read_text(encoding="utf-8")
start = java.index("ASSETS = Set.of(")
served = set(re.findall(r'"(/[\w.-]+)"', java[start:java.index(");", start)]))
loaded, queue = set(), ["handheld.html"]
while queue:
    name = queue.pop()
    loaded.add("/" + name)
    if not name.endswith((".html", ".mjs", ".css")):
        continue
    text = (assets / name).read_text(encoding="utf-8")
    refs = re.findall(r'(?:src|href)="([\w.-]+)"', text) + re.findall(r"from '\./([\w.-]+)'", text) + re.findall(r"url\(([\w.-]+)\)", text)
    queue += [ref for ref in refs if "/" + ref not in loaded and ref not in queue]
assert loaded <= served, "Add to MainActivity.ASSETS: " + ", ".join(sorted(loaded - served))


def serve_assets(route):
    name = route.request.url.split("/")[-1]
    file = assets / name
    if file.suffix in types and file.is_file():
        route.fulfill(path=file, content_type=types[file.suffix])
    else:
        route.fulfill(status=404)


def pick_role(page, role, close=True):
    # Role and name live in the identity menu at the top right; it floats over the screen while open.
    if page.locator("#who-menu").get_attribute("open") is None:
        page.get_by_label("Role and name").click()
    page.locator("#role").select_option(role)
    if close:
        page.get_by_label("Role and name").click()


def as_person(page, role, name):
    pick_role(page, role, close=False)
    page.get_by_label("Your name").fill(name)  # no Tab: tapping the menu chip closed must also save the name
    page.get_by_label("Role and name").click()


def hold(page):
    trigger = page.get_by_role("button", name="Hold trigger *")
    trigger.focus()
    page.keyboard.down("Space")
    expect(page.locator("#scan-results")).to_contain_text("Reading")
    page.keyboard.up("Space")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    device = browser.new_page(viewport={"width":360, "height":700}, has_touch=True)
    errors = []
    device.on("pageerror", lambda error: errors.append(str(error)))
    device.route("https://handheld.test/**", serve_assets)
    device.goto("https://handheld.test/handheld.html")
    assert device.get_by_role("img", name="KeyPharm Laboratories").evaluate("(logo) => logo.complete && logo.naturalWidth === 681")
    assert device.locator(".brand").bounding_box()["x"] < device.locator("#who").bounding_box()["x"]
    pick_role(device, "admin")
    device.get_by_role("button", name="Settings",exact=True).click()
    device.get_by_label("One test per line: Test ID, then description").fill("KP-TEST-01 Mixed pallet check\nKP-TEST-02 Ginger pallet")
    device.get_by_role("button", name="Save test plan").click()
    expect(device.get_by_text("Not run", exact=True)).to_have_count(2)
    device.get_by_role("button", name="Home",exact=True).click()
    device.get_by_role("button", name="New test session").click()
    expect(device.get_by_label("Session ID")).to_have_value("KP-TEST-01")
    device.get_by_role("button", name="Create session").click()
    expect(device.locator("#notice")).to_contain_text("Enter your name")
    as_person(device, "operator", "Operator C")
    device.get_by_role("button", name="Create session").click()
    expect(device.get_by_role("button", name="Use CSV *")).to_have_count(0)
    as_person(device, "admin", "Lead A")
    device.get_by_role("button", name="Use CSV *").click()
    device.get_by_role("button", name="Save manifest").click()
    as_person(device, "supervisor", "Verifier B")
    device.get_by_label("Contents and label assignment verified").check()
    device.get_by_role("button", name="Record verification").click()
    pick_role(device, "operator", close=False)
    device.get_by_label("Your name").fill("Operator C")  # picked again from the remembered list
    device.get_by_label("Your name").press("Tab")
    device.get_by_label("Role and name").click()
    assert device.locator("#people option").count() == 3
    device.get_by_role("button", name="Open pallet scanner").click()
    expect(device.get_by_role("heading", name="Scan pallet")).to_be_visible()
    expect(device.get_by_role("heading", name="Expected cartons")).to_have_count(0)
    device.evaluate("window.keypharmEvent('press', {key: 139})")
    expect(device.locator("#scan-results")).to_contain_text("Reading")
    device.evaluate("window.keypharmEvent('release', {key: 139})")
    expect(device.get_by_role("heading", name="Scan cartons")).to_be_visible()
    expect(device.get_by_text("Pallet verified by UHF EPC.")).to_be_visible()
    expect(device.get_by_label("Rescan reason")).to_have_count(0)
    expect(device.get_by_label("Reads *")).to_have_value("Clean match")
    expect(device.get_by_role("dialog")).to_have_count(0)
    proceed = device.get_by_role("button", name="Continue", exact=True)

    device.get_by_label("Reads *").select_option("Missing one")
    device.evaluate("window.keypharmEvent('press', {key: 139})")
    expect(device.locator("#scan-results")).to_contain_text("Reading")
    device.evaluate("window.keypharmEvent('release', {key: 139})")
    expect(proceed).to_be_disabled()
    expect(device.locator("#scan-results")).to_contain_text("Incomplete")
    expect(device.locator(".tag-row[data-tag-status=matched]")).to_have_count(3)
    expect(device.locator(".tag-row[data-tag-status=missing]")).to_have_count(1)
    expect(device.get_by_label("Rescan reason")).to_have_value("Missing cartons")
    device.get_by_role("button", name="Session details").click()
    device.get_by_label("Note on the current run").fill("Carton behind stretch wrap")
    device.reload()  # the open session and the half-typed note both come back from localStorage
    expect(device.get_by_label("Note on the current run")).to_have_value("Carton behind stretch wrap")
    device.get_by_role("button", name="Save run note").click()
    by_sku = device.locator(".by-sku").last  # current run: a mixed pallet reads per SKU (AT-02)
    by_sku.locator("summary").click()
    expect(by_sku).to_contain_text("Ginger 2 of 2 matched")
    expect(by_sku).to_contain_text("Physalis 0 of 1 matched / 1 missing")

    # Manifest revision after a scan: needs a reason, then verification and pallet identification again.
    as_person(device, "admin", "Lead A")
    device.locator("summary", has_text="Expected cartons").click()
    device.get_by_role("button", name="Use CSV *").click()
    device.get_by_label("Revision reason").fill("Wrong carton list exported")
    device.get_by_role("button", name="Save manifest").click()
    as_person(device, "supervisor", "Verifier B")
    expect(device.locator(".next").get_by_text("KP-DEMO-01 / 4 cartons / Revision 2")).to_be_visible()
    device.get_by_label("Contents and label assignment verified").check()
    device.get_by_role("button", name="Record verification").click()
    as_person(device, "operator", "Operator C")
    device.get_by_role("button", name="Open pallet scanner").click()
    hold(device)
    expect(device.get_by_role("heading", name="Scan cartons")).to_be_visible()

    device.get_by_label("Reads *").select_option("Unexpected extra")
    expect(device.get_by_label("Rescan reason")).to_have_count(0)
    expect(device.locator("#scan-results")).to_contain_text("Ready to scan")
    hold(device)
    expect(device.get_by_label("Rescan reason")).to_have_value("Extra EPCs detected")
    expect(proceed).to_be_disabled()
    expect(device.locator("#scan-results .status")).to_have_text("Hold: unexpected reads")
    expect(device.locator(".tag-row[data-tag-status=unexpected]")).to_contain_text("Unexpected")
    device.get_by_role("button", name="Session details").click()
    device.get_by_label("Action").select_option("Neighbouring tag")
    device.get_by_label("Investigation note").fill("Neighbor label removed")
    device.get_by_role("button", name="Save investigation").click()
    device.get_by_role("button", name="Open carton scanner").click()
    expect(proceed).to_be_disabled()

    device.get_by_label("Reads *").select_option("Clean match")
    trigger = device.get_by_role("button", name="Hold trigger *")
    trigger.scroll_into_view_if_needed()
    box = trigger.bounding_box()
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    device.mouse.move(x, y)
    device.mouse.down()
    expect(proceed).to_be_disabled()
    expect(device.locator("#scan-results")).to_contain_text("Reading")
    expect(device.locator(".scan-signal")).to_have_attribute("data-reading", "true")
    assert device.locator(".scan-signal").evaluate("(el) => getComputedStyle(el, '::after').animationName !== 'none'")
    device.emulate_media(reduced_motion="reduce")
    assert device.locator(".scan-signal").evaluate("(el) => getComputedStyle(el, '::after').animationName === 'none'")
    device.emulate_media(reduced_motion="no-preference")
    device.screenshot(path="build/handheld-reading.png")
    device.mouse.up()
    expect(proceed).to_be_enabled()
    expect(device.get_by_label("Rescan reason")).to_have_value("")
    expect(device.locator("#rescan-reasons option")).to_have_count(5)
    device.screenshot(path="build/handheld-smoke.png", full_page=True)
    proceed.click()
    expect(device.get_by_text("Clean carton match confirmed.")).to_be_visible()
    expect(device.get_by_label("Coverage and missing-test reason")).to_have_value("Successful Run")
    device.get_by_label("Coverage and missing-test reason").fill("Planned mixed pallet check executed")
    device.get_by_label("Results reviewed and signed off").check()
    device.get_by_role("button", name="Close test session").click()
    expect(device.get_by_role("heading", name="Session closed")).to_be_visible()

    device.reload()  # reopens on the same session
    expect(device.get_by_role("heading", name="Session closed")).to_be_visible()
    snapshot = device.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1'))")
    assert snapshot["sessions"][0]["closure"]["coverage"] == "Planned mixed pallet check executed"
    runs = snapshot["sessions"][0]["runs"]
    assert [run["result"]["status"] for run in runs] == ["Incomplete", "Hold", "Match"]
    assert len(runs[0]["result"]["missing"]) == 1 and len(runs[1]["result"]["extra"]) == 1
    assert runs[2]["reason"] == "Extra EPCs detected"
    record = snapshot["sessions"][0]
    assert (record["creator"], record["verifiedBy"], runs[0]["operator"], record["closure"]["actor"]) ==         ("Operator C", "Verifier B", "Operator C", "Operator C"), record
    assert any(log["action"] == "Unexpected EPC neighbouring tag" for log in record["logs"])
    assert [run["manifestRevision"] for run in runs] == [1, 2, 2], runs

    downloads = []
    device.on("download", lambda download: downloads.append(download))
    device.get_by_role("button", name="Sessions").click()
    device.get_by_role("button", name="Settings",exact=True).click()
    expect(device.locator(".export-state")).to_have_text("1 of 1 sessions not exported since their last change: KP-TEST-01")
    device.get_by_role("button", name="Export CSV and summary").click()
    device.wait_for_timeout(1000)
    expect(device.locator(".export-state")).to_have_text("Every session is exported.")
    files = {d.suggested_filename: Path(d.path()).read_text(encoding="utf-8-sig") for d in downloads}
    assert sorted(files) == ["keypharm-evidence.csv", "keypharm-records.csv", "keypharm-summary.txt"], sorted(files)
    evidence = files["keypharm-evidence.csv"].splitlines()
    assert evidence[0].startswith('"SessionID","Mode","TransactionRef","PalletRef","TestID","RunID"'), evidence[0]
    assert len(evidence) == 1 + 4 + 5 + 4, len(evidence)  # header + 4 cartons per run + the extra EPC on run 2
    assert '"Neighbouring tag"' in files["keypharm-evidence.csv"] and '"Operator C"' in files["keypharm-evidence.csv"]
    assert "Carton behind stretch wrap" in files["keypharm-evidence.csv"]
    assert "KP-TEST-01 Mixed pallet check: Done" in files["keypharm-summary.txt"], files["keypharm-summary.txt"]
    assert "KP-TEST-02 Ginger pallet: Not run" in files["keypharm-summary.txt"]

    device.get_by_role("button", name="Home",exact=True).click()
    device.get_by_role("button", name="KP-TEST-01", exact=False).click()
    device.get_by_role("button", name="Export this test").click()
    device.wait_for_timeout(1000)
    assert len(downloads) == 6, len(downloads)
    device.get_by_role("button", name="Sessions").click()
    device.get_by_role("button", name="Settings",exact=True).click()
    device.locator("summary", has_text="Close PoC day").click()
    device.get_by_label("Coverage reviewed and signed off").check()
    device.get_by_role("button", name="Close PoC day").click()
    expect(device.locator("#notice")).to_contain_text("KP-TEST-02: give a reason")
    device.get_by_label("Why was KP-TEST-02 not run?").fill("No ginger labels encoded")
    device.get_by_role("button", name="Close PoC day").click()
    expect(device.get_by_text("PoC day closed by Operator C", exact=False)).to_be_visible()

    reset = device.get_by_role("button", name="Reset all local data")
    expect(reset).to_have_count(0)
    pick_role(device, "admin")
    device.get_by_role("button", name="Home",exact=True).click()
    device.get_by_role("button", name="New test session").click()
    device.get_by_label("Session ID").fill("KP-DRAFT")
    device.get_by_role("button", name="Sessions").click()
    device.get_by_role("button", name="Settings",exact=True).click()
    before_reset = device.evaluate("""() => {
      localStorage.setItem('unrelated-preference', 'keep');
      return ['keypharm-poc-v1', 'keypharm-poc-ui-v1'].map(key => localStorage.getItem(key));
    }""")
    assert "KP-DRAFT" in json.loads(before_reset[1])["drafts"].values()
    dialog_messages = []

    def cancel_reset(dialog):
        dialog_messages.append(dialog.message)
        dialog.dismiss()

    device.once("dialog", cancel_reset)
    reset.click()
    assert dialog_messages[0].startswith("Permanently delete all sessions")
    assert "form drafts" in dialog_messages[0]
    assert device.evaluate("['keypharm-poc-v1', 'keypharm-poc-ui-v1'].map(key => localStorage.getItem(key))") == before_reset
    expect(device.get_by_text("PoC day closed by Operator C", exact=False)).to_be_visible()

    device.once("dialog", lambda dialog: dialog.accept())
    reset.click()
    expect(device.locator("#notice")).to_have_text("Local data reset.")
    expect(device.get_by_text("0 of 500 labels used")).to_be_visible()
    assert device.evaluate("['keypharm-poc-v1', 'keypharm-poc-ui-v1'].map(key => localStorage.getItem(key))") == [None, None]
    assert device.evaluate("localStorage.getItem('unrelated-preference')") == "keep"
    device.reload()
    expect(device.get_by_text("No sessions yet.", exact=True)).to_be_visible()
    assert device.evaluate("localStorage.getItem('keypharm-poc-ui-v1')") is None
    device.get_by_role("button", name="Settings",exact=True).click()
    expect(device.get_by_text("No planned tests.", exact=True)).to_be_visible()
    device.get_by_role("button", name="Home",exact=True).click()
    device.get_by_label("Role and name").click()
    expect(device.locator("#role")).to_have_value("operator")
    expect(device.get_by_label("Your name")).to_have_value("")
    expect(device.locator("#people option")).to_have_count(0)
    device.get_by_role("button", name="New test session").click()
    expect(device.get_by_label("Session ID")).to_have_value("KP-TEST-01")

    # C72 path with a fake Android bridge: on-screen Start scan / Stop scan drives the same reader calls as the trigger.
    c72 = browser.new_page(viewport={"width":360, "height":700})
    c72.on("pageerror", lambda error: errors.append(str(error)))
    c72.add_init_script("""
      window.bridgeCalls = [];
      window.dashboardCalls = [];
      const fire = (name, data) => setTimeout(() => window.keypharmEvent(name, data), 10);
      window.KeypharmAndroid = {
        connectReader: () => fire('reader', {ready:true, message:'Reader ready', profile:{region:'ETSI', powerDbm:30}}),
        startReader: id => { bridgeCalls.push('start'); fire('started', {id, profile:{region:'ETSI', powerDbm:30}});
          fire('reads', {id, reads:[{epc:'A00000000000000000000001'}]}); },
        stopReader: id => { bridgeCalls.push('stop'); fire('ended', {id, reads:[], interrupted:false}); },
        feedback: () => {}, publishSnapshot: data => dashboardCalls.push(JSON.parse(data)),
        shareDashboard: enabled => {
          dashboardCalls.push(enabled);
          if (!window.deferDashboardEvents) fire('dashboard', {url: enabled ? 'http://192.0.2.12:8787/12345678-1234-5678-90ab-1234567890ab/' : ''});
        },
        copyLink: url => { window.copiedLink = url; },
        liveSampleManifest: () => %s
      };""" % json.dumps(open(assets / "model.mjs", encoding="utf-8").read().split("`")[1]))
    c72.route("https://handheld.test/**", serve_assets)
    c72.goto("https://handheld.test/handheld.html")
    c72.evaluate("localStorage.clear()")
    c72.reload()
    as_person(c72, "admin", "Lead A")
    c72.get_by_role("button", name="Settings",exact=True).click()
    c72.get_by_role("button", name="Share web dashboard").click()
    code = c72.get_by_role("img", name="Dashboard QR code")
    expect(code.locator("svg path")).to_be_visible()
    code.screenshot(path="build/dashboard-qr-smoke.png")
    assert c72.evaluate("document.documentElement.scrollWidth <= innerWidth")
    c72.get_by_role("button", name="Copy dashboard link").click()
    url = "http://192.0.2.12:8787/12345678-1234-5678-90ab-1234567890ab/"
    assert c72.evaluate("copiedLink") == url
    c72.get_by_role("button", name="Stop dashboard sharing").click()
    expect(code).to_have_count(0)
    expect(c72.get_by_text(url, exact=True)).to_have_count(0)
    c72.get_by_role("button", name="Home",exact=True).click()
    c72.get_by_role("button", name="New test session").click()
    c72.get_by_label("Reader source").select_option("C72 hardware")
    c72.get_by_role("button", name="Create session").click()
    c72.get_by_role("button", name="Use RFID CSV *").click()
    c72.get_by_role("button", name="Save manifest").click()
    as_person(c72, "supervisor", "Verifier B")
    c72.get_by_label("Contents and label assignment verified").check()
    c72.get_by_role("button", name="Record verification").click()
    as_person(c72, "operator", "Operator C")
    c72.get_by_role("button", name="Open pallet scanner").click()
    c72.get_by_role("button", name="Start scan").click()
    expect(c72.get_by_role("button", name="Stop scan")).to_be_enabled()
    c72.get_by_role("button", name="Stop scan").click()
    expect(c72.get_by_text("Pallet verified by UHF EPC.")).to_be_visible()
    expect(c72.get_by_role("button", name="Start scan")).to_be_enabled()
    assert c72.evaluate("bridgeCalls") == ["start", "stop"]

    c72.get_by_role("button", name="Session details").click()
    c72.get_by_role("button", name="Sessions").click()
    pick_role(c72, "admin")
    c72.evaluate("window.deferDashboardEvents = true")
    c72.get_by_role("button", name="Settings",exact=True).click()
    share = c72.get_by_role("button", name="Share web dashboard")
    share.click()
    assert c72.evaluate("dashboardCalls.at(-1)") is True
    assert len(c72.evaluate("dashboardCalls.at(-2).sessions")) == 1
    c72.once("dialog", lambda dialog: dialog.accept())
    c72.get_by_role("button", name="Reset all local data").click()
    assert c72.evaluate("dashboardCalls.slice(-2)") == [{"sessions": []}, False]
    c72.get_by_role("button", name="Settings",exact=True).click()
    expect(share).to_be_disabled()
    c72.evaluate("url => window.keypharmEvent('dashboard', {url})", url)
    expect(share).to_be_disabled()
    expect(code).to_have_count(0)
    expect(c72.get_by_role("button", name="Copy dashboard link")).to_have_count(0)
    c72.evaluate("window.keypharmEvent('dashboard', {url:''})")
    expect(share).to_be_enabled()
    expect(c72.get_by_role("heading",name="Settings")).to_be_visible()

    dashboard = browser.new_page(viewport={"width":1280, "height":800})
    dashboard.on("pageerror", lambda error: errors.append(str(error)))
    service = {"online":True, "records":copy.deepcopy(snapshot)}
    dashboard.route("https://dashboard.test/**", serve_assets)

    def records(route):
        if service["online"]:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(service["records"]))
        else:
            route.abort()

    dashboard.route("https://dashboard.test/records", records)
    dashboard.goto("https://dashboard.test/dashboard.html")
    assert dashboard.get_by_role("img", name="KeyPharm Laboratories").evaluate("(logo) => logo.complete && logo.naturalWidth > 339")
    assert dashboard.locator(".dashboard-brand").evaluate("(logo) => getComputedStyle(logo).backgroundColor === 'rgba(0, 0, 0, 0)'")
    assert dashboard.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"
    assert dashboard.get_by_role("img", name="KeyPharm Laboratories").evaluate(
        "(logo) => logo.naturalWidth > 339 && getComputedStyle(logo).filter === 'none'")
    assert dashboard.locator(".dashboard-brand").evaluate("(logo) => getComputedStyle(logo).backgroundColor === 'rgba(0, 0, 0, 0)'")
    dashboard.reload()
    expect(dashboard.get_by_role("button", name="Dark mode", exact=True)).to_be_visible()
    assert dashboard.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"
    dashboard.get_by_role("button", name="Dark mode", exact=True).click()
    assert dashboard.evaluate("getComputedStyle(document.documentElement).colorScheme") == "dark"
    expect(dashboard.locator("#connection")).to_have_text("")
    expect(dashboard.get_by_role("heading", name="Overview")).to_be_visible(timeout=3000)
    expect(dashboard.locator("[data-total=sessions]")).to_have_text("1")
    expect(dashboard.locator("[data-total=scans]")).to_have_text("3")
    expect(dashboard.locator(".outcome-chart strong")).to_have_text("3")
    outcome_counts = dashboard.locator(".outcome-counts dd").all_text_contents()
    assert len(outcome_counts) == 4 and sum(map(int,outcome_counts)) == 3
    assert dashboard.locator(".outcome-chart").evaluate("(chart) => getComputedStyle(chart).backgroundImage.startsWith('conic-gradient')")
    expect(dashboard.locator("[data-total=exceptions]")).to_have_text("2")
    expect(dashboard.locator("[data-total=activity]")).to_have_count(0)
    expect(dashboard.locator("#recent-sessions-count")).to_have_text("1")
    expect(dashboard.get_by_role("heading", name="Recent sessions")).to_be_visible()
    expect(dashboard.get_by_role("heading", name="Recent activity")).to_have_count(0)
    rail_box = dashboard.locator(".dashboard-rail").bounding_box()
    heading_box = dashboard.locator(".dashboard-heading").bounding_box()
    nav_box = dashboard.locator("#dashboard-nav").bounding_box()
    assert rail_box["y"] < heading_box["y"]
    assert abs((nav_box["x"] + nav_box["width"] / 2) - 640) < 120
    assert dashboard.locator(".dashboard-outcomes").bounding_box()["x"] > heading_box["x"]
    expect(dashboard.locator(".dashboard-rail nav a")).to_have_count(3)
    expect(dashboard.locator(".dashboard-rail nav a").last).to_have_text("Activity")
    assert "C72" not in dashboard.locator("#content").inner_text()
    dashboard.screenshot(path="build/dashboard-smoke.png", full_page=True)
    dashboard.locator("#recent-sessions").get_by_role("link", name="KP-TEST-01").click()
    expect(dashboard.locator("#detail").get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    dashboard.reload()
    expect(dashboard.locator("#detail").get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    dashboard.get_by_role("navigation", name="Dashboard sections").get_by_role("link", name="Scan logs").click()
    expect(dashboard.get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    assert "C72" not in dashboard.locator("#detail").inner_text()
    expect(dashboard.locator("#detail").get_by_text("Unexpected EPC neighbouring tag",exact=True)).to_be_visible()
    service["online"] = False
    dashboard.get_by_role("button", name="Refresh records").click()
    expect(dashboard.get_by_role("status")).to_contain_text("Handheld offline")
    expect(dashboard.get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    service["online"] = True
    service["records"]["sessions"][0]["testId"] = "KP-RECONNECTED"
    dashboard.get_by_role("button", name="Refresh records").click()
    expect(dashboard.get_by_role("heading", name="KP-RECONNECTED")).to_be_visible()
    for i in range(55):
        service["records"]["sessions"].append({
            "id": f"older-{i}", "testId": f"Earlier session {i:02}", "createdAt": f"2025-01-{i // 2 + 1:02}T{i % 2:02}:00:00Z",
            "runs": [], "logs": [{"action": f"Earlier event {i:02}", "at": f"2025-01-{i // 2 + 1:02}T{i % 2:02}:00:00Z"}]
        })
    service["records"]["sessions"][-1]["runs"].append({
        "id": "other-run", "state": "Finished", "endedAt": "2025-01-28T03:00:00Z",
        "result": {"status": "Hold", "extra": ["E00000000000000000000019"], "missing": [], "matched": [], "expected": 1}
    })
    dashboard.get_by_role("button", name="Refresh records").click()
    expect(dashboard.locator("[data-total=sessions]")).to_have_text("56")
    expect(dashboard.locator("#catalog-tabs [data-tab-count='sessions']")).to_have_text("56")
    expect(dashboard.get_by_text("Showing 50 of 56 records.")).to_be_visible()
    expect(dashboard.locator("#records button[data-id]")).to_have_count(50)
    expect(dashboard.get_by_role("button", name="Earlier session 00",exact=False)).to_have_count(0)
    global_search = dashboard.get_by_role("searchbox", name="Search sessions, pallets or EPCs")
    global_search.fill("Earlier session 00")
    expect(dashboard.locator("#dashboard-find-results").get_by_role("link",name="Earlier session 00",exact=False)).to_be_visible()
    global_search.press("Escape")
    expect(dashboard.locator("#dashboard-find-results")).to_be_hidden()
    global_search.press("Tab")
    global_search.focus()
    global_search.press("Enter")
    expect(dashboard.locator("#detail").get_by_role("heading",name="Earlier session 00")).to_be_visible()
    global_search.fill("does not exist")
    expect(dashboard.locator("#dashboard-find-status")).to_have_text("No matching sessions.")
    global_search.press("Escape")
    rail = dashboard.locator(".dashboard-rail")
    pane = dashboard.locator("#content")
    bounds = rail.bounding_box()
    assert bounds["width"] == 1280 and bounds["height"] < 140
    pane.evaluate("(pane) => pane.scrollTop = 650")
    assert pane.evaluate("(pane) => pane.scrollTop") > 0
    assert rail.bounding_box() == bounds
    assert dashboard.evaluate("window.scrollY") == 0
    dashboard.locator("#catalog-tabs").get_by_role("link", name="Exceptions").click()
    expect(dashboard.get_by_role("navigation", name="Dashboard sections").get_by_role("link", name="Scan logs")).to_have_attribute("aria-current", "page")
    expect(dashboard.locator("#records button[data-id]")).to_have_count(2)
    assert pane.evaluate("(pane) => pane.scrollTop") == 0
    expect(dashboard.get_by_text("Showing 2 of 2 sessions with exceptions.")).to_be_visible()
    dashboard.locator("#records").get_by_role("button", name="KP-RECONNECTED", exact=False).click()
    group = dashboard.locator("#detail")
    expect(group.get_by_role("heading", name="KP-RECONNECTED")).to_be_visible()
    expect(group).not_to_contain_text("E00000000000000000000019")
    expect(group.locator("details[data-exception] > summary [data-state=incomplete]")).to_have_text("Incomplete")
    item = group.locator("details[data-exception]").filter(has_text="E00000000000000000000009")
    trigger = item.locator(":scope > summary")
    expect(trigger.locator("[data-state=hold]")).to_have_text("Hold")
    evidence = item.locator(":scope > .exception-body .exception-subdetails > details").filter(has_text="Scan evidence")
    expect(evidence).to_be_hidden()
    trigger.press("Enter")
    expect(evidence.get_by_text("Scan evidence",exact=True)).to_be_visible()
    expect(evidence.locator(".exception-evidence-content")).to_be_hidden()
    evidence.locator(":scope > summary").click()
    expect(evidence.locator(".exception-evidence-content")).to_be_visible()
    trigger.click()
    expect(evidence).to_be_hidden()
    dashboard.get_by_label("Search recent records").fill("E00000000000000000000019")
    expect(dashboard.locator("#records button[data-id]")).to_have_count(1)
    expect(group.get_by_role("heading", name="Earlier session 54")).to_be_visible()
    expect(group).not_to_contain_text("E00000000000000000000009")
    dashboard.get_by_role("navigation", name="Dashboard sections").get_by_role("link", name="Activity").click()
    expect(dashboard.locator("#records button[data-id]")).to_have_count(50)
    dashboard.set_viewport_size({"width":360, "height":700})
    assert dashboard.evaluate("document.documentElement.scrollWidth <= innerWidth")
    dashboard.get_by_role("button", name="Light mode", exact=True).click()
    expect(dashboard.get_by_role("button", name="Dark mode", exact=True)).to_be_visible()
    dashboard.get_by_role("button", name="Dark mode", exact=True).click()
    dashboard.get_by_role("button", name="Sections").click()
    dashboard.get_by_role("navigation", name="Dashboard sections").get_by_role("link", name="Overview").click()
    expect(dashboard.get_by_role("heading", name="Overview")).to_be_visible()
    expect(dashboard.get_by_role("navigation", name="Dashboard sections")).to_be_hidden()
    dashboard.screenshot(path="build/dashboard-mobile.png")
    dashboard.get_by_role("button", name="Sections").click()
    dashboard.get_by_role("navigation", name="Dashboard sections").get_by_role("link", name="Scan logs").click()
    expect(dashboard.get_by_role("heading", name="Sessions", exact=True)).to_be_visible()
    expect(dashboard.get_by_role("navigation", name="Dashboard sections")).to_be_hidden()
    bounds = rail.bounding_box()
    pane.evaluate("(pane) => pane.scrollTop = 650")
    assert pane.evaluate("(pane) => pane.scrollTop") > 0
    assert rail.bounding_box() == bounds
    assert dashboard.evaluate("window.scrollY") == 0

    hardware = browser.new_page(viewport={"width":360, "height":700})
    hardware.on("pageerror", lambda error: errors.append(str(error)))
    hardware.route("https://handheld.test/**", serve_assets)
    hardware.add_init_script(r"""
      window.KeypharmAndroid = {
        publishSnapshot() {},
        feedback() {},
        liveSampleManifest() {
          return 'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\n' +
            'KP-LIVE-SORTED-01,A00000000000000000000001,Carton 01,C00000000000000000000001,Test SKU\n';
        },
        connectReader() {
          window.keypharmEvent('reader', {ready:true, message:'UHF reader ready', profile:{region:'ETSI',powerDbm:30}});
        },
        setReaderPower(requestId, power) {
          window.keypharmEvent('reader-power', {id:requestId, ok:true, ready:true, previousPower:30,
            message:'Reader power set to ' + power + ' dBm', profile:{region:'ETSI',powerDbm:power}});
        },
        startReader(id) {
          window.keypharmEvent('started', {id, profile:{region:'ETSI',powerDbm:18}});
        },
        stopReader(id) {
          window.keypharmEvent('ended', {id, reads:window.scanReads, interrupted:false});
        }
      };
    """)
    hardware.goto("https://handheld.test/handheld.html")
    # Reader power lives under Settings and remains restricted by role.
    as_person(hardware, "admin", "Lead A")
    hardware.get_by_role("button", name="Settings",exact=True).click()
    expect(hardware.locator(".reader-card")).to_contain_text("ETSI / 30 dBm")
    hardware.locator("#reader-card > summary").click()  # one glanceable row; tap it to change power
    hardware.locator(".reader-card").get_by_label("Output power (dBm)").fill("25")
    hardware.locator(".reader-card").get_by_role("button", name="Set power").click()
    expect(hardware.locator("#notice")).to_contain_text("Reader power set to 25 dBm")
    expect(hardware.locator(".reader-card")).to_contain_text("ETSI / 25 dBm")
    audit = lambda: hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).audit")
    assert [(a["action"], a["actor"], a["detail"]) for a in audit()] == \
        [("Reader power changed", "Lead A", "30 to 25 dBm (home screen)")], audit()  # FR-35: no session, so the device log
    expect(hardware.locator("summary", has_text="Device log (1)")).to_be_visible()
    pick_role(hardware, "operator")
    expect(hardware.locator(".reader-card")).to_contain_text("The Administrator sets reader power.")
    as_person(hardware, "operator", "Operator C")
    hardware.get_by_role("button", name="Home",exact=True).click()
    hardware.get_by_role("button", name="New test session").click()
    hardware.get_by_role("button", name="Create session").click()
    expect(hardware.get_by_role("button", name="Set power")).to_have_count(0)
    pick_role(hardware, "admin")
    hardware.get_by_role("button", name="Use RFID CSV *").click(timeout=3000)
    hardware.get_by_role("button", name="Save manifest").click()
    assert hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].manifest.demo") is False
    hardware.locator("summary", has_text="Reader settings: ETSI / 25 dBm").click(timeout=3000)
    hardware.get_by_label("Output power (dBm)").fill("18")
    hardware.get_by_role("button", name="Set power").click()
    expect(hardware.locator("#notice")).to_contain_text("Reader power set to 18 dBm")
    saved = hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].logs")
    assert saved[-1]["action"] == "Reader power changed" and "30 to 18 dBm" in saved[-1]["detail"]
    assert len(audit()) == 1, audit()  # a change inside a session stays in that session's log
    pick_role(hardware, "operator")
    expect(hardware.get_by_role("button", name="Set power")).to_have_count(0)
    expect(hardware.get_by_text("ETSI / 18 dBm")).to_be_visible()
    pick_role(hardware, "supervisor")
    expect(hardware.locator(".next").get_by_text("KP-LIVE-SORTED-01 / 1 cartons", exact=False)).to_be_visible()
    hardware.get_by_label("Contents and label assignment verified").check()
    hardware.get_by_role("button", name="Record verification").click()
    pick_role(hardware, "operator")
    hardware.get_by_role("button", name="Open pallet scanner").click()
    hardware.evaluate("window.scanReads = [{epc:'E00000000000000000000009'}]; window.keypharmEvent('press',{})")
    hardware.evaluate("window.keypharmEvent('release',{})")
    expect(hardware.get_by_role("heading", name="Scan pallet")).to_be_visible()
    expect(hardware.locator("#notice")).to_contain_text("Pallet EPC not confirmed", timeout=3000)
    hardware.evaluate("window.scanReads.push({epc:'A00000000000000000000001'}); window.keypharmEvent('press',{})")
    hardware.evaluate("window.keypharmEvent('release',{})")
    expect(hardware.get_by_role("heading", name="Scan cartons")).to_be_visible()
    saved = hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].palletAttempts.at(-1)")
    assert saved["profile"]["powerDbm"] == 18
    assert len(saved["observations"]) == 2
    hardware.evaluate("window.scanReads.push({epc:'C00000000000000000000001'}); window.keypharmEvent('press',{})")
    hardware.evaluate("window.keypharmEvent('release',{})")
    expect(hardware.locator(".tag-row[data-tag-status=unexpected]")).to_have_count(1)
    expect(hardware.get_by_role("button", name="Continue",exact=True)).to_be_disabled()

    # Verify one pallet at a time. A neighboring pallet cannot identify the requested pallet.
    multi = browser.new_page(viewport={"width":360, "height":700})
    multi.on("pageerror", lambda error: errors.append(str(error)))
    multi.route("https://handheld.test/**", serve_assets)
    multi.add_init_script(r"""
      window.KeypharmAndroid = {
        publishSnapshot() {}, feedback() {},
        liveSampleManifest() {
          return 'pallet_ref;pallet_epc;carton_ref;carton_epc;sku\n' +
            'PAL-A;A1A1;A-01;C0A1;x\nPAL-A;A1A1;A-02;C0A2;x\nPAL-B;B1B1;B-01;C0B1;y\nPAL-B;B1B1;B-02;C0B2;y\n';
        },
        connectReader() { window.keypharmEvent('reader', {ready:true, message:'UHF reader ready', profile:{region:'ETSI',powerDbm:30}}); },
        startReader(id) { window.keypharmEvent('started', {id, profile:{region:'ETSI',powerDbm:30}}); },
        stopReader(id) { window.keypharmEvent('ended', {id, reads:window.scanReads, interrupted:false}); }
      };
    """)
    multi.goto("https://handheld.test/handheld.html")
    as_person(multi, "admin", "Lead A")
    multi.get_by_role("button", name="New test session").click()
    multi.get_by_role("button", name="Create session").click()
    multi.get_by_role("button", name="Use RFID CSV *").click()
    expect(multi.get_by_text("2 pallet(s) / 4 cartons", exact=False)).to_be_visible()
    multi.get_by_role("button", name="Save manifest").click()
    as_person(multi, "supervisor", "Verifier B")
    expect(multi.locator(".next").get_by_text("2 pallets / 4 cartons", exact=False)).to_be_visible()
    multi.get_by_label("Contents and label assignment verified").check()
    multi.get_by_role("button", name="Record verification").click()
    as_person(multi, "operator", "Operator C")
    multi.get_by_role("button", name="Open pallet scanner").click()
    def multi_scan(epcs):
        multi.evaluate("(epcs) => { window.scanReads = epcs.map(epc => ({epc})); }",epcs)
        multi.get_by_role("button", name="Start scan").click()
        multi.get_by_role("button", name="Stop scan").click()

    multi_scan(["B1B1","C0A1"])
    expect(multi.get_by_role("heading", name="Scan pallet")).to_be_visible()
    multi_scan(["A1A1","B1B1"])
    expect(multi.get_by_role("heading", name="Scan cartons")).to_be_visible()
    multi_scan(["C0A1","C0A2","C0B1"])
    expect(multi.locator(".tag-row[data-tag-status=unexpected]")).to_contain_text("Belongs to pallet PAL-B")
    expect(multi.get_by_role("button", name="Next pallet", exact=True)).to_be_disabled()
    multi_scan(["C0A1","C0A2"])
    multi.get_by_role("button", name="Next pallet", exact=True).click()
    expect(multi.get_by_text("Pallet 2 of 2", exact=False)).to_be_visible()
    multi_scan(["B1B1"])
    expect(multi.get_by_role("heading", name="Scan cartons")).to_be_visible()
    multi_scan(["C0B1","C0B2"])
    multi.get_by_role("button", name="Continue", exact=True).click()
    expect(multi.get_by_role("heading", name="Review and close the test")).to_be_visible()
    verified = multi.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0]")
    assert len(verified["palletMatches"]) == 2 and verified["allocation"]["cartons"] == 4

    # Manifest generator: scan one pallet's tags on the C72, drop a stray tag, save the CSV, then load it.
    gen = browser.new_page(viewport={"width":360, "height":700})
    gen.on("pageerror", lambda error: errors.append(str(error)))
    gen.route("https://handheld.test/**", serve_assets)
    gen.add_init_script(r"""
      window.saved = [];
      window.KeypharmAndroid = {
        publishSnapshot() {}, feedback() {},
        connectReader() { window.keypharmEvent('reader', {ready:true, message:'UHF reader ready', profile:{region:'ETSI',powerDbm:30}}); },
        startReader(id) { window.keypharmEvent('started', {id}); },
        stopReader(id) { window.keypharmEvent('ended', {id, interrupted:false, reads:[{epc:'cc02', rssi:'-60'},
          {epc:'AA01', rssi:'-35'}, {epc:'CC01', rssi:'-58'}, {epc:'FFEE', rssi:'-70'}, {epc:'CC01', rssi:'-52'}]}); },
        saveTemplate(csv, name) { window.saved.push([name, csv]); }
      };
    """)
    gen.goto("https://handheld.test/handheld.html")
    as_person(gen, "admin", "Lead A")
    gen.get_by_role("button", name="Settings",exact=True).click()
    expect(gen.locator("#share-all")).to_be_checked()
    gen.get_by_role("button", name="Home",exact=True).click()
    gen.get_by_role("button", name="New test session").click()
    gen.get_by_role("button", name="Create session").click()
    # A rejected file is logged with its name and errors; a blank SKU is accepted but named before scanning (FR-04).
    gen.evaluate("""window.keypharmEvent('manifest-file', {name:'bad.csv',
      text:'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\\nP1,AA01,C1,XYZ,\\n'})""")
    expect(gen.locator("#notice")).to_contain_text("EPC must be even-length hexadecimal")
    failed = gen.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].logs.at(-1)")
    assert (failed["action"], failed["actor"]) == ("Manifest import failed", "Lead A"), failed
    assert failed["detail"].startswith("bad.csv / Row 2: EPC must be even-length hexadecimal"), failed
    gen.evaluate("""window.keypharmEvent('manifest-file', {name:'nosku.csv',
      text:'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\\nP1,AA01,C1,CC01,\\nP1,AA01,C2,CC02,Ginger\\n'})""")
    expect(gen.locator(".sku-gap")).to_have_text("1 carton has no SKU: C1")
    gen.get_by_role("button", name="Build from scan").click()
    gen.get_by_role("button", name="Start scan").click()
    gen.get_by_role("button", name="Stop scan").click()
    expect(gen.locator("#build-count")).to_have_text("4 tags read")
    expect(gen.locator("input[name=palletEpc][value=AA01]")).to_be_checked()  # strongest tag
    gen.locator("input[name=keep][value=FFEE]").uncheck()
    gen.get_by_label("SKU for all cartons (optional)").fill("Ginger")
    gen.get_by_role("button", name="Save CSV file").click()
    name, csv = gen.evaluate("window.saved")[0]
    assert name == "manifest-KP-TEST-01.csv", name
    assert csv.splitlines() == ["pallet_ref,pallet_epc,carton_ref,carton_epc,sku",
        "PAL-KP-TEST-01,AA01,Carton 01,CC01,Ginger", "PAL-KP-TEST-01,AA01,Carton 02,CC02,Ginger"], csv
    gen.get_by_role("button", name="Use as manifest").click()
    expect(gen.get_by_text("1 pallet(s) / 2 cartons", exact=False)).to_be_visible()
    expect(gen.locator(".sku-gap")).to_have_count(0)
    gen.get_by_role("button", name="Save manifest").click()
    built = gen.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].manifest")
    assert (built["palletEpc"], [c["epc"] for c in built["cartons"]]) == ("AA01", ["CC01", "CC02"]), built

    # Home screen: mode and network line, and the session search across test, level, date and status (section 6, FR-33).
    seeded = browser.new_page(viewport={"width":360, "height":700})
    seeded.on("pageerror", lambda error: errors.append(str(error)))
    seeded.route("https://handheld.test/**", serve_assets)
    seeded.add_init_script("""localStorage.setItem('keypharm-poc-v1', JSON.stringify({people:[], sessions:[
      {id:'a', testId:'KP-GINGER', location:'Dock 1', level:'Ground', source:'Simulation', createdAt:'2026-11-24T09:00:00.000Z',
        creator:'Lead A', runs:[], logs:[], allocation:{}},
      {id:'b', testId:'KP-PHYSALIS', location:'Rack', level:'Level 2', source:'Simulation', createdAt:'2026-11-25T09:00:00.000Z',
        creator:'Lead A', runs:[], logs:[], allocation:{}}]}))""")
    seeded.goto("https://handheld.test/handheld.html")
    expect(seeded.locator(".mode-line")).to_have_count(0)
    records = seeded.locator(".record")
    search = seeded.get_by_label("Search sessions")
    search.fill("level 2")
    expect(records.filter(visible=True)).to_have_count(1)
    expect(records.filter(visible=True)).to_contain_text("KP-PHYSALIS")
    search.fill("2026-11-24 waiting for setup")
    expect(records.filter(visible=True)).to_contain_text("KP-GINGER")
    search.fill("nothing like this")
    expect(records.filter(visible=True)).to_have_count(0)
    expect(seeded.locator("#no-match")).to_be_visible()
    search.fill("")
    expect(records.filter(visible=True)).to_have_count(2)

    assert not errors, errors
    print("Handheld and dashboard browser flow passed.")
