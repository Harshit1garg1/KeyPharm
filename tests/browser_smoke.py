"""Run with an installed Python Playwright and Chromium."""
import copy
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
types = {".html":"text/html", ".mjs":"text/javascript", ".css":"text/css", ".png":"image/png"}


def serve_assets(route):
    name = route.request.url.split("/")[-1]
    file = assets / name
    if file.suffix in types and file.is_file():
        route.fulfill(path=file, content_type=types[file.suffix])
    else:
        route.fulfill(status=404)


def hold(page):
    trigger = page.get_by_role("button", name="Hold demo trigger")
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
    assert device.get_by_role("img", name="KeyPharm Laboratories").evaluate("(logo) => logo.complete && logo.naturalWidth === 339")
    device.get_by_role("button", name="New test session").click()
    device.get_by_role("button", name="Create session").click()
    expect(device.get_by_role("button", name="Use sample manifest")).to_have_count(0)
    device.get_by_label("Local identity").select_option("admin")
    device.get_by_role("button", name="Use sample manifest").click()
    device.get_by_role("button", name="Save manifest").click()
    device.get_by_label("Local identity").select_option("supervisor")
    device.get_by_label("Contents and label assignment verified").check()
    device.get_by_role("button", name="Record verification").click()
    device.get_by_label("Local identity").select_option("operator")
    device.get_by_role("button", name="Open pallet scanner").click()
    expect(device.get_by_role("heading", name="Scan pallet")).to_be_visible()
    expect(device.get_by_role("heading", name="Expected cartons")).to_have_count(0)
    hold(device)
    expect(device.get_by_role("heading", name="Scan cartons")).to_be_visible()
    expect(device.get_by_text("Pallet verified by UHF EPC.")).to_be_visible()
    proceed = device.get_by_role("button", name="Continue", exact=True)

    hold(device)
    expect(proceed).to_be_disabled()
    expect(device.locator("#scan-results")).to_contain_text("Incomplete")
    expect(device.locator(".tag-row[data-tag-status=matched]")).to_have_count(3)
    expect(device.locator(".tag-row[data-tag-status=missing]")).to_have_count(1)

    device.get_by_label("Demo reads").select_option("Unexpected extra")
    device.get_by_label("Rescan reason").fill("Check neighboring tags")
    hold(device)
    expect(proceed).to_be_disabled()
    expect(device.locator("#scan-results")).to_contain_text("Hold")
    expect(device.locator(".tag-row[data-tag-status=unexpected]")).to_contain_text("Unexpected")
    device.get_by_role("button", name="Session details").click()
    device.get_by_label("Investigation note").fill("Neighbor label removed")
    device.get_by_role("button", name="Save investigation").click()
    device.get_by_role("button", name="Open carton scanner").click()
    expect(proceed).to_be_disabled()

    device.get_by_label("Demo reads").select_option("Clean match")
    device.get_by_label("Rescan reason").fill("Neighbor label was removed")
    trigger = device.get_by_role("button", name="Hold demo trigger")
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
    device.screenshot(path="build/handheld-smoke.png", full_page=True)
    proceed.click()
    expect(device.get_by_text("Clean carton match confirmed.")).to_be_visible()
    device.get_by_text("Review and close session").click()
    device.get_by_label("Coverage and missing-test reason").fill("Planned mixed pallet check executed")
    device.get_by_label("Results reviewed and signed off").check()
    device.get_by_role("button", name="Close test session").click()
    expect(device.get_by_role("heading", name="Session closed")).to_be_visible()

    device.reload()
    device.get_by_role("button", name="KP-TEST-01", exact=False).click()
    expect(device.get_by_role("heading", name="Session closed")).to_be_visible()
    snapshot = device.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1'))")
    runs = snapshot["sessions"][0]["runs"]
    assert [run["result"]["status"] for run in runs] == ["Incomplete", "Hold", "Match"]
    assert len(runs[0]["result"]["missing"]) == 1 and len(runs[1]["result"]["extra"]) == 1

    downloads = []
    device.on("download", lambda download: downloads.append(download))
    device.get_by_role("button", name="Sessions").click()
    device.get_by_role("button", name="Export CSV and summary").click()
    device.wait_for_timeout(1000)
    files = {d.suggested_filename: Path(d.path()).read_text(encoding="utf-8-sig") for d in downloads}
    assert sorted(files) == ["keypharm-evidence.csv", "keypharm-records.csv", "keypharm-summary.txt"], sorted(files)
    evidence = files["keypharm-evidence.csv"].splitlines()
    assert evidence[0].startswith('"SessionID","Mode","TransactionRef","PalletRef","TestID","RunID"'), evidence[0]
    assert len(evidence) == 1 + 4 + 5 + 4, len(evidence)  # header + 4 cartons per run + the extra EPC on run 2

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
    assert dashboard.get_by_role("img", name="KeyPharm Laboratories").evaluate("(logo) => logo.complete && logo.naturalWidth === 339")
    expect(dashboard.get_by_role("status")).to_contain_text("Handheld online")
    expect(dashboard.get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    expect(dashboard.get_by_text("Unexpected EPC investigated",exact=True)).to_be_visible()
    dashboard.screenshot(path="build/dashboard-smoke.png", full_page=True)
    service["online"] = False
    dashboard.get_by_role("button", name="Refresh records").click()
    expect(dashboard.get_by_role("status")).to_contain_text("Handheld offline")
    expect(dashboard.get_by_role("heading", name="KP-TEST-01")).to_be_visible()
    service["online"] = True
    service["records"]["sessions"][0]["testId"] = "KP-RECONNECTED"
    dashboard.get_by_role("button", name="Refresh records").click()
    expect(dashboard.get_by_role("heading", name="KP-RECONNECTED")).to_be_visible()
    dashboard.set_viewport_size({"width":360, "height":700})
    assert dashboard.evaluate("document.documentElement.scrollWidth <= innerWidth")

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
    hardware.get_by_role("button", name="New test session").click()
    hardware.get_by_role("button", name="Create session").click()
    expect(hardware.get_by_role("button", name="Set power")).to_have_count(0)
    hardware.get_by_label("Local identity").select_option("admin")
    hardware.get_by_role("button", name="Use live sample").click(timeout=3000)
    hardware.get_by_role("button", name="Save manifest").click()
    expect(hardware.get_by_text("KP-LIVE-SORTED-01 / 1 cartons", exact=False)).to_be_visible()
    assert hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].manifest.demo") is False
    expect(hardware.get_by_role("heading", name="Reader settings")).to_be_visible(timeout=3000)
    hardware.get_by_label("Output power (dBm)").fill("18")
    hardware.get_by_role("button", name="Set power").click()
    expect(hardware.locator("#notice")).to_contain_text("Reader power set to 18 dBm")
    saved = hardware.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].logs")
    assert saved[-1]["action"] == "Reader power changed" and "30 to 18 dBm" in saved[-1]["detail"]
    hardware.get_by_label("Local identity").select_option("operator")
    expect(hardware.get_by_role("button", name="Set power")).to_have_count(0)
    expect(hardware.get_by_text("ETSI / 18 dBm")).to_be_visible()
    hardware.get_by_label("Local identity").select_option("supervisor")
    hardware.get_by_label("Contents and label assignment verified").check()
    hardware.get_by_role("button", name="Record verification").click()
    hardware.get_by_label("Local identity").select_option("operator")
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
    assert not errors, errors
    print("Handheld and dashboard browser flow passed.")
