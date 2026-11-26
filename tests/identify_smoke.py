"""Lookup tab against a fake native reader. Run with an installed Python Playwright and Chromium."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
assets = root / "app/src/main/assets"
types = {".html":"text/html", ".mjs":"text/javascript", ".css":"text/css", ".png":"image/png", ".woff2":"font/woff2"}
bridge = """
  const emit = (name,data) => setTimeout(() => window.keypharmEvent(name,data),0);
  window.testReads = [];
  window.stockReads = [];
  window.stops = 0;
  window.KeypharmAndroid = {
    publishSnapshot(){},
    showToast(message) { window.lastToast = message; },
    connectReader() { emit('reader',{ready:true,profile:{region:'ETSI',powerDbm:30}}); },
    startReader(){},
    startStockReader(id,powerDbm) {
      window.stockReads.push(powerDbm);
      emit('started',{id});
      emit('reads',{id,reads:window.testReads});
    },
    stopReader(id) { window.stops++; emit('ended',{id,reads:[]}); }
  };
"""


def serve_assets(route):
    file = assets / route.request.url.split("/")[-1]
    if file.suffix in types and file.is_file():
        route.fulfill(path=file, content_type=types[file.suffix])
    else:
        route.fulfill(status=404)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width":360, "height":700}, has_touch=True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("https://handheld.test/**", serve_assets)
    page.add_init_script(bridge)
    page.goto("https://handheld.test/handheld.html")

    page.get_by_label("Role and name").click()
    page.locator("#role").select_option("admin")
    page.get_by_label("Your name").fill("Lead A")
    page.get_by_label("Role and name").click()
    page.get_by_role("button", name="New test session").click()
    page.locator("select[name=source]").select_option("Simulation")
    page.get_by_role("button", name="Create session").click()
    page.get_by_role("button", name="Use CSV *").click()
    page.get_by_role("button", name="Save manifest").click()
    expect(page.get_by_role("list", name="Test progress")).not_to_contain_text("Physical check")
    page.get_by_role("button", name="Sessions").click()
    manifest = page.evaluate("JSON.parse(localStorage.getItem('keypharm-poc-v1')).sessions[0].manifest")
    carton = manifest["cartons"][0]
    stored = page.evaluate("localStorage.getItem('keypharm-poc-v1')")

    nav = page.get_by_role("navigation", name="Main menu")
    expect(nav.get_by_role("button")).to_have_count(4)
    assert nav.get_by_role("button").evaluate_all("(list) => list.map(b => b.ariaLabel)") == [
        "Home", "Search", "Lookup", "Settings"]
    nav.get_by_role("button", name="Search").click()
    expect(page.get_by_role("heading", name="Search for a tag")).to_be_visible()

    def scan(reads):
        page.evaluate("(reads) => { window.testReads = reads; }", reads)
        page.locator("[data-action=utility-scan]").click()

    nav.get_by_role("button", name="Lookup").click()
    expect(page.get_by_role("heading", name="Look up a tag")).to_be_visible()
    # A stray tag with a weaker signal loses to the tag held close.
    scan([{"epc":"ABCDEF012345", "rssi":"-71.0"}, {"epc":carton["epc"], "rssi":"-40.4"}])
    result = page.locator(".tag-result")
    expect(result.get_by_role("heading", name=carton["carton"], exact=True)).to_be_visible()
    expect(result).to_contain_text(carton["sku"])
    expect(result).to_contain_text("KP-TEST-01")
    expect(result).to_contain_text(carton["epc"])
    expect(result).to_contain_text("RSSI -40 dBm")
    assert page.evaluate("window.stockReads") == [10]
    assert page.evaluate("window.stops") == 1
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    (root / "build").mkdir(exist_ok=True)
    page.screenshot(path=str(root / "build/lookup-carton.png"), full_page=True)

    # Hardware trigger starts the same read.
    page.evaluate("(reads) => { window.testReads = reads; window.keypharmEvent('press',{}); window.keypharmEvent('release',{}); }",
        [{"epc":manifest["palletEpc"], "rssi":"-38"}])
    expect(result.get_by_role("heading", name="Pallet " + manifest["pallet"])).to_be_visible()

    scan([{"epc":"ABCDEF012345", "rssi":"-50"}])
    expect(result.get_by_role("heading", name="Not in records")).to_be_visible()
    expect(result).to_contain_text("ABCDEF012345")

    scan([])
    page.wait_for_function("window.lastToast === 'No tag read.'")
    expect(result).to_have_count(0)

    scan([{"epc":carton["epc"], "rssi":"-40"}])
    expect(result).to_have_count(1)
    nav.get_by_role("button", name="Home").click()
    nav.get_by_role("button", name="Lookup").click()
    expect(result).to_have_count(0)

    assert page.evaluate("localStorage.getItem('keypharm-poc-v1')") == stored, "Lookup must not write records"
    assert not errors, json.dumps(errors)
    browser.close()
    print("Lookup smoke test passed")
