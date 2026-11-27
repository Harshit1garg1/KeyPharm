"""Exercise the desktop controls and actual handheld code against an isolated local backend."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parents[1]
assets = root / "app/src/main/assets"
types = {".html":"text/html", ".mjs":"text/javascript", ".css":"text/css", ".png":"image/png"}

def serve_assets(route):
    asset = assets / route.request.url.rsplit("/",1)[-1]
    if asset.suffix in types and asset.is_file():
        route.fulfill(path=asset,content_type=types[asset.suffix])
    else:
        route.fulfill(status=404)

def hold(page):
    trigger = page.get_by_role("button",name="Hold trigger *")
    trigger.focus()
    page.keyboard.down("Space")
    expect(page.locator("#scan-results")).to_contain_text("Reading")
    page.keyboard.up("Space")

with tempfile.TemporaryDirectory(dir=root / "build",prefix="workspace-test-") as directory:
    accounts_file = Path(directory) / "accounts.json"
    accounts_file.write_text(json.dumps({"lead":{"password":"testing123","secret":"retired"},
        "handheld":{"password":"testing123","secret":"retired"}}),encoding="utf-8")
    env = dict(os.environ,KEYPHARM_LOCAL_DATA=directory,KEYPHARM_PORT="0")
    with subprocess.Popen(["node","tools/workspace-server.mjs"],cwd=root,env=env,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as server:
        try:
            line = server.stdout.readline().strip()
            assert line.startswith("KeyPharm workspace: "), "Local workspace failed to start"
            base = line.split(" ",2)[2]
            accounts = json.loads(accounts_file.read_text(encoding="utf-8"))
            assert list(accounts) == ["testing"]
            password = accounts["testing"]["password"]
            assert password == "testing123"
            auth = "Basic " + base64.b64encode(("testing:" + password).encode()).decode()
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                def dashboard(role):
                    page = browser.new_page(viewport={"width":1280,"height":800})
                    page.goto(base)
                    page.get_by_label("Username").fill("testing")
                    page.get_by_label("Password").fill(password)
                    page.get_by_role("button",name="Sign in").click()
                    expect(page.get_by_label("Role",exact=True)).to_have_value("operator")
                    page.get_by_label("Role",exact=True).select_option(role)
                    return page

                signed_out = dashboard("admin")
                old_session = next(cookie["value"] for cookie in signed_out.context.cookies() if cookie["name"] == "keypharm_dashboard")
                signed_out.get_by_role("button",name="Sign out",exact=True).click()
                expect(signed_out.get_by_role("heading",name="Sign in")).to_be_visible()
                assert signed_out.request.get(base + "/api/workspace",headers={"Authorization":auth}).status == 401
                assert signed_out.request.get(base + "/api/workspace",headers={"Cookie":"keypharm_dashboard=" + old_session}).status == 401
                expect(signed_out.locator("html")).to_have_attribute("data-theme","light")
                signed_out.get_by_role("button",name="Dark mode").click()
                expect(signed_out.locator("html")).to_have_attribute("data-theme","dark")
                signed_out.get_by_label("Username").fill("testing")
                signed_out.get_by_label("Password").fill(password)
                signed_out.get_by_role("button",name="Sign in").click()
                expect(signed_out.get_by_label("Role",exact=True)).to_have_value("operator")
                expect(signed_out.locator("html")).to_have_attribute("data-theme","dark")
                cookie = next(c for c in signed_out.context.cookies() if c["name"] == "keypharm_dashboard")
                assert 43190 <= cookie["expires"] - time.time() <= 43200
                signed_out.reload()
                expect(signed_out.get_by_label("Role",exact=True)).to_be_visible()
                signed_out.close()

                lead = dashboard("admin")
                for retired in ("lead","operator","supervisor","viewer","handheld"):
                    retired_auth = "Basic " + base64.b64encode((retired + ":" + password).encode()).decode()
                    assert lead.request.get(base + "/api/workspace",headers={"Authorization":retired_auth}).status == 401
                lead.goto(base + "/#inventory")
                expect(lead.locator("#connection")).to_have_text("")
                expect(lead.get_by_text("Test environment / Sample data",exact=False)).to_have_count(0)
                expect(lead.get_by_role("row",name="Physalis 20 0")).to_be_visible()
                expect(lead.get_by_role("row",name="Tiger Balm 15 0")).to_be_visible()
                expect(lead.get_by_role("row",name="Biotona 35 0")).to_be_visible()
                expect(lead.get_by_role("row",name="Total 70 0")).to_be_visible()
                expect(lead.locator(".workspace-table caption")).to_have_text("Carton stock (70)")
                expect(lead.get_by_role("heading",name="Physalis cartons (20)")).to_be_visible()
                expect(lead.locator(".workspace-subtabs [href='#inventory'] .tab-count")).to_have_text("70")
                expect(lead.get_by_role("columnheader",name="Reserved",exact=True)).to_have_count(0)
                assert lead.evaluate("async () => (await document.fonts.load('600 15px Inter'))[0]?.status") == "loaded"
                expect(lead.locator(".theme-moon")).to_be_visible()
                lead.screenshot(path=str(root / "build/connected-inventory.png"),full_page=True)
                lead.get_by_role("button",name="Dark mode",exact=True).click()
                expect(lead.locator(".theme-sun")).to_be_visible()
                lead.get_by_role("button",name="Light mode",exact=True).click()
                expect(lead.get_by_role("row",name="Biotona 35 0")).to_be_visible()
                expect(lead.locator(".theme-moon")).to_be_visible()
                assert lead.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"
                expect(lead.get_by_role("img",name="KeyPharm Laboratories")).to_have_attribute("src","keypharm-logo-hd.png")
                assert lead.get_by_role("img",name="KeyPharm Laboratories").evaluate(
                    "(logo) => logo.naturalWidth > 339 && getComputedStyle(logo).filter === 'none'")
                lead.screenshot(path=str(root / "build/connected-inventory-light.png"),full_page=True)
                stock_row = lead.get_by_role("row",name="Biotona 35 0",exact=False)
                assert stock_row.get_by_role("button",name="View Biotona cartons").bounding_box()["x"] < \
                    stock_row.get_by_role("rowheader",name="Biotona").bounding_box()["x"]
                stock_row.get_by_role("cell",name="35",exact=True).first.click()
                expect(lead.get_by_role("heading",name="Biotona cartons")).to_be_visible()
                expect(lead.get_by_role("heading",name="Physalis cartons")).to_have_count(0)
                stock_table = lead.locator(".workspace-inventory > .workspace-table").bounding_box()
                details_pane = lead.locator("#inventory-cartons").bounding_box()
                assert stock_table["width"] <= 352 and details_pane["x"] > stock_table["x"] + stock_table["width"]
                expect(stock_row.get_by_role("button",name="Hide Biotona cartons")).to_have_attribute("aria-expanded","true")
                stock_row.get_by_role("button",name="Hide Biotona cartons").press("Enter")
                expect(lead.get_by_role("heading",name="Biotona cartons")).to_be_hidden()
                stock_row.get_by_role("button",name="View Biotona cartons").press("Enter")
                expect(lead.get_by_role("heading",name="Biotona cartons")).to_be_visible()
                rail = lead.locator(".dashboard-rail")
                expect(rail.locator("nav a")).to_have_count(6)
                expect(rail.locator("nav a").last).to_have_text("Activity")
                pane = lead.locator("#content")
                sidebar = rail.bounding_box()
                pane.evaluate("(pane) => pane.scrollTop = pane.scrollHeight")
                assert pane.evaluate("(pane) => pane.scrollTop") > 0
                assert rail.bounding_box() == sidebar
                lead.get_by_role("link", name="Overview").click()
                expect(lead.locator("#overview-reports")).to_be_visible()
                expect(lead.get_by_role("link", name="Pallets on hand 0")).to_be_visible()
                expect(lead.locator("#recent-sessions-count")).to_have_text("0")
                heading_box = lead.locator(".dashboard-heading").bounding_box()
                sessions_box = lead.locator(".dashboard-sessions").bounding_box()
                outcomes_box = lead.locator(".dashboard-outcomes").bounding_box()
                reports_box = lead.locator("#overview-reports").bounding_box()
                assert outcomes_box["x"] > sessions_box["x"]
                assert abs(outcomes_box["y"] - sessions_box["y"]) < 2
                assert reports_box["y"] > sessions_box["y"]
                assert abs(reports_box["width"] - heading_box["width"]) < 4
                kpi_cards = lead.locator("#totals .dashboard-total").evaluate_all(
                    "(els) => els.map((el) => { const r = el.getBoundingClientRect(); return {w: r.width, h: r.height}; })")
                assert len(kpi_cards) == 8
                assert max(c["w"] for c in kpi_cards) - min(c["w"] for c in kpi_cards) < 2
                assert max(c["h"] for c in kpi_cards) - min(c["h"] for c in kpi_cards) < 2
                report_cards = lead.locator("#overview-reports .report-card").evaluate_all(
                    "(els) => els.map((el) => { const r = el.getBoundingClientRect(); return {w: r.width, h: r.height}; })")
                assert len(report_cards) == 5
                assert max(c["w"] for c in report_cards) - min(c["w"] for c in report_cards) < 2
                assert max(c["h"] for c in report_cards) - min(c["h"] for c in report_cards) < 2
                lead.screenshot(path=str(root / "build/overview-desktop.png"),full_page=True)
                lead.get_by_role("link", name="Devices & Setup").click()
                lead.get_by_text("Locations",exact=True).click()
                location_list = lead.get_by_role("table",name="Locations")
                expect(location_list.get_by_role("row",name="Hold Protected")).to_be_visible()
                lead.get_by_label("New location name").fill("Dock North")
                lead.get_by_role("button",name="Add location",exact=True).click()
                dock = location_list.get_by_role("row").filter(has_text="Dock North")
                dock.get_by_label("Rename Dock North").fill("Dock South")
                dock.get_by_role("button",name="Save name").click()
                lead.goto(base + "/#counts")
                expect(lead.get_by_role("option",name="Dock South",exact=True)).to_have_count(1)
                lead.goto(base + "/#devices")
                lead.get_by_text("Locations",exact=True).click()
                dock = location_list.get_by_role("row").filter(has_text="Dock South")
                dock.get_by_role("button",name="Archive",exact=True).click()
                lead.get_by_role("dialog",name="Archive location?").get_by_role("button",name="Confirm").click()
                expect(dock).to_contain_text("Archived")
                if lead.locator("#workspace-lead-settings").get_attribute("open") is None:
                    lead.get_by_text("Administrator settings",exact=True).click()
                lead.get_by_label("Test plan").fill("KP-OUT-40 Outbound presentation")
                lead.get_by_label("Requested Power (dBm)").fill("15")
                lead.get_by_role("button",name="Save test settings").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                lead.get_by_role("link", name="Outbound").click()
                lead.get_by_role("button", name="+ New session").click()
                zone = lead.locator("#workspace-create [data-csv-drop]")
                expect(zone).to_be_visible()
                sample_button = lead.get_by_role("button",name="Use CSV *")
                create_button = lead.get_by_role("button",name="Create session")
                assert zone.bounding_box()["x"] < sample_button.bounding_box()["x"] < create_button.bounding_box()["x"]
                assert abs(zone.bounding_box()["y"] - create_button.bounding_box()["y"]) < 2
                expect(lead.locator(".workspace-csv-divider")).to_have_text("\\")
                assert zone.evaluate("(zone) => getComputedStyle(zone).borderTopStyle") == "dashed"
                size = zone.bounding_box()
                assert size["width"] <= 360 and size["height"] <= 56, size
                zone.screenshot(path=str(root / "build/csv-picker-light.png"))
                lead.get_by_role("button",name="Dark mode",exact=True).click()
                assert zone.evaluate("(zone) => getComputedStyle(zone).borderTopStyle") == "dashed"
                zone.screenshot(path=str(root / "build/csv-picker-dark.png"))
                lead.get_by_label("Session ID").fill("KP-OUT-40")
                lead.get_by_role("button", name="Use CSV *").click()
                lead.get_by_role("button", name="Create session").click()
                expect(lead.get_by_role("link", name="KP-OUT-40")).to_be_visible()
                expect(lead.get_by_role("button",name="Reserve cartons")).to_have_count(0)
                lead.screenshot(path=str(root / "build/connected-sessions.png"),full_page=True)

                supervisor = dashboard("supervisor")
                supervisor.goto(base + "/#manage")
                lead.get_by_role("row",name="KP-OUT-40",exact=False).get_by_role("button",name="More actions").click()
                lead.get_by_role("button",name="Record verification").click()
                lead.get_by_label("Check notes").fill("Simulated pallet check for demonstration")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("cell",name="Ready to scan")).to_be_visible()
                expect(lead.get_by_role("dialog",name="Verification recorded")).to_be_visible()
                lead.get_by_role("button",name="Done").click()

                mobile = browser.new_page(viewport={"width":360,"height":740},has_touch=True)
                mobile.route("https://handheld.test/**",serve_assets)
                transport = {"online": True}
                def bridge(_source,path,authorization,body):
                    if not transport["online"]:
                        return {"status":0,"body":"{}"}
                    request = urllib.request.Request(base + "/api/" + path,
                        data=body.encode("utf-8") if body is not None else None,
                        headers={"Authorization":authorization,"Content-Type":"application/json","X-KeyPharm-Device-Id":"a01234b56789cdef"})
                    try:
                        with urllib.request.urlopen(request,timeout=5) as response:
                            return {"status":response.status,"body":response.read().decode("utf-8")}
                    except urllib.error.HTTPError as error:
                        return {"status":error.code,"body":error.read().decode("utf-8")}
                mobile.expose_binding("testTransport",bridge)
                mobile.add_init_script("""
                  window.KeypharmAndroid = {
                    workspaceRequest(id,path,authorization,body) {
                      testTransport(path,authorization,body).then(reply =>
                        window.keypharmEvent('workspace-response',{id,...reply}));
                    },
                    showToast(message) { window.lastToast = message; },
                    feedback(kind) { if (kind === 'lookup') window.lookupBeeps = (window.lookupBeeps ?? 0) + 1; },
                    startReader(id) {
                      window.lookupReadId = id;
                      if (window.testOutboundReads) {
                        const reads = window.testOutboundReads.map(epc => ({epc}));
                        setTimeout(() => window.keypharmEvent('reads',{id,reads}),0);
                      }
                    },
                    publishSnapshot(){}, closeApp(){ window.closeCalls = (window.closeCalls ?? 0) + 1; },
                    connectReader() {
                      setTimeout(() => window.keypharmEvent('reader',{ready:true,profile:{region:'ETSI',powerDbm:20}}),0);
                    },
                    startStockReader(id,powerDbm) {
                      window.stockRead = {id,powerDbm};
                      const reads = window.testPalletReads ?? (window.testCountEpcs ?? [window.testStockEpc]).map(epc => ({epc}));
                      setTimeout(() => {
                        window.keypharmEvent('started',{id,profile:{region:'ETSI',powerDbm}});
                        window.keypharmEvent('reads',{id,reads});
                      },0);
                    },
                    stopReader(id) {
                      window.stockStop = id;
                      setTimeout(() => window.keypharmEvent('ended',{id,reads:(window.testCountEpcs || window.testPalletReads || window.testOutboundReads) ? [] : [{epc:'AB00FF'}]}),0);
                    },
                    setReaderPower(id,powerDbm) {
                      window.appliedPowers = [...(window.appliedPowers ?? []),powerDbm];
                      setTimeout(() => window.keypharmEvent('reader-power',{id,ok:true,profile:{region:'ETSI',powerDbm}}),0);
                    }
                  };
                """)
                mobile.goto("https://handheld.test/handheld.html")
                expect(mobile.get_by_text("Test environment / Sample data",exact=True)).to_have_count(0)
                expect(mobile.get_by_label("Username")).to_have_value("testing")
                mobile.get_by_label("Password").fill(password)
                mobile.get_by_role("button",name="Sign in").click()
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                lead.goto(base + "/#devices")
                expect(lead.get_by_role("heading",name="Connected handhelds (1)")).to_be_visible()
                expect(lead.get_by_role("heading",name="RFID handheld a01234b56789cdef")).to_be_visible()
                expect(lead.get_by_text("C72 reader",exact=False)).to_have_count(0)
                expect(lead.locator("#workspace-device-pill")).to_have_count(0)
                expect(lead.locator(".device-details")).to_contain_text("Connected")
                lead.wait_for_function("""() => {
                  const settings = document.querySelector('#workspace-lead-settings');
                  const devices = document.querySelector('.devices-section');
                  return settings && devices && settings.getBoundingClientRect().top < devices.getBoundingClientRect().top;
                }""")
                lead.screenshot(path=str(root / "build/devices-desktop.png"),full_page=True)
                for width,height,tag in [(768,1024,"tablet"),(360,740,"mobile")]:
                    lead.set_viewport_size({"width":width,"height":height})
                    for hash_path in ("#overview","#inventory","#inbound","#manage","#sessions","#devices"):
                        lead.goto(base + "/" + hash_path)
                        if hash_path == "#overview":
                            expect(lead.locator("#overview-reports")).to_be_visible()
                        elif hash_path == "#sessions":
                            expect(lead.locator("#catalog-tabs")).to_be_visible()
                        else:
                            expect(lead.locator("#workspace-panel")).to_be_visible()
                            lead.wait_for_function("() => !document.querySelector('#workspace-panel')?.textContent.includes('Loading workspace')")
                        assert lead.evaluate("document.documentElement.scrollWidth <= innerWidth"), (tag, hash_path)
                        assert lead.locator("#content").evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), (tag, hash_path)
                        if hash_path in ("#overview","#devices"):
                            lead.screenshot(path=str(root / f"build/{hash_path[1:]}-{tag}.png"),full_page=True)
                lead.set_viewport_size({"width":1280,"height":800})
                lead.goto(base + "/#manage")
                lead.get_by_role("button",name="+ New session").click()
                zone = lead.locator("#workspace-create [data-csv-drop]")
                expect(mobile.locator(".workspace-bubble")).to_have_attribute("data-visible","false")
                mobile.get_by_role("button",name="Sync now").click()
                mobile.wait_for_function("window.lastToast === 'Synced'")
                expect(mobile.locator(".workspace-bubble")).to_have_attribute("data-visible","false")
                expect(mobile.get_by_label("Role",exact=True).get_by_role("option")).to_have_text(["Operator","Administrator","Supervisor"])
                expect(mobile.locator("#who")).to_be_hidden()
                nav = mobile.get_by_role("navigation",name="Main menu")
                expect(nav.locator("button svg")).to_have_count(4)
                for tab in ("Home","Search","Lookup","Settings"):
                    expect(nav.get_by_role("button",name=tab,exact=True)).to_be_visible()
                expect(mobile.get_by_role("heading",name="PoC test plan")).to_be_hidden()
                heights = [mobile.locator(selector).bounding_box()["height"] for selector in
                    ["[data-workspace=retry]","[data-workspace=logout]"]]
                assert max(heights) == min(heights) == 44, heights
                header = mobile.locator("#workspace-header-actions")
                expect(header.get_by_role("button")).to_have_count(2)
                expect(header.locator("button svg")).to_have_count(2)
                assert header.get_by_role("button",name="Sync now").bounding_box()["x"] < header.get_by_role("button",name="Sign out").bounding_box()["x"]
                mobile.get_by_role("button",name="Sync now").focus()
                lead.get_by_label("Session ID").fill("KP-HANDOFF")
                lead.get_by_role("button", name="Use CSV *").click()
                lead.get_by_role("button",name="Create session").click()
                expect(lead.locator("#workspace-message")).to_contain_text("assigned to KP-OUT-40")
                expect(lead.get_by_label("Session ID")).to_have_value("KP-HANDOFF")
                expect(lead.get_by_role("link",name="KP-HANDOFF")).to_have_count(0)
                csv = lead.evaluate("""async () => {
                    const headers = {'X-KeyPharm-Role':'admin'};
                    const { inventory, sessions } = await (await fetch('api/workspace',{headers})).json();
                    const assigned = new Set(sessions.find(s => s.testId === 'KP-OUT-40').manifest.cartons.map(c => c.epc));
                    const carton = inventory.find(c => c.state === 'available' && !assigned.has(c.epc));
                    return 'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\\nKP-HANDOFF,E0A1,Handoff carton,' + carton.epc + ',' + carton.sku;
                }""")
                with lead.expect_file_chooser() as file_chooser:
                    lead.get_by_label("Choose a CSV").click()
                file_chooser.value.set_files({"name":"browser-manifest.csv","mimeType":"text/csv","buffer":csv.encode()})
                expect(zone.get_by_role("status")).to_have_text("browser-manifest.csv")
                expect(lead.get_by_role("button",name="Use CSV *")).to_have_attribute("aria-pressed","false")
                lead.get_by_role("button", name="Create session").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_be_visible(timeout=12000)
                handoff_row = lead.get_by_role("row",name="KP-HANDOFF",exact=False)
                handoff_row.get_by_role("button",name="More actions").click()
                handoff_row.get_by_role("button",name="Change CSV").click()
                drop = lead.get_by_role("dialog").locator("[data-csv-drop]")
                drop.evaluate("""(zone) => {
                    const transfer = new DataTransfer();
                    transfer.items.add(new File(['not a CSV'], 'wrong.txt', {type:'text/plain'}));
                    zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
                }""")
                expect(drop.get_by_role("status")).to_have_text("Choose a non-empty CSV file.")
                drop.evaluate("""(zone,csv) => {
                    const transfer = new DataTransfer();
                    transfer.items.add(new File([csv], 'dropped-manifest.csv', {type:'text/csv'}));
                    zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
                    zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
                }""",csv)
                expect(drop.get_by_role("status")).to_have_text("dropped-manifest.csv")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                mobile.get_by_role("button",name="KP-OUT-40",exact=False).click()
                expect(mobile.get_by_text("Scan *",exact=False).first).to_be_visible()
                mobile.evaluate("window.keypharmEvent('back',{})")
                expect(mobile.get_by_role("heading",name="Sessions")).to_be_visible()
                mobile.get_by_role("button",name="KP-OUT-40",exact=False).click()
                transport["online"] = False
                mobile.get_by_role("button",name="Open pallet scanner").click()
                expect(mobile.locator("#workspace-connection")).to_be_hidden()
                expect(mobile.locator("#who")).to_be_hidden()
                expect(mobile.locator("#workspace-header-actions")).to_be_hidden()
                mobile.evaluate("window.keypharmEvent('back',{})")
                expect(mobile.get_by_role("button",name="Open pallet scanner")).to_be_visible()
                mobile.get_by_role("button",name="Open pallet scanner").click()
                mobile.get_by_role("button",name="Hold trigger *").tap()
                expect(mobile.get_by_label("Rescan reason")).to_have_count(0)
                expect(mobile.get_by_label("Reads *")).to_have_value("Clean match")
                assert mobile.evaluate("document.activeElement.id") != "scenario"
                mobile.get_by_label("Reads *").select_option("Missing and unexpected")
                hold(mobile)
                expect(mobile.locator("#scan-results")).to_contain_text("Hold")
                expect(mobile.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
                mobile.get_by_role("button",name="Scan results").click()
                expect(mobile.get_by_role("heading",name="Scan attempts")).to_be_visible()
                expect(mobile.get_by_role("list",name="Test progress")).to_be_visible()
                expect(mobile.locator(".steps li")).to_have_text(["Scan","Close"])
                expect(mobile.get_by_text("Test setup",exact=True)).to_have_count(0)
                expect(mobile.get_by_role("button",name="Export this test")).to_be_visible()
                expect(mobile.get_by_text("Session log",exact=False).first).to_be_visible()
                mobile.reload()
                mobile.get_by_role("button",name="Open carton scanner").click()
                expect(mobile.get_by_label("Reads *")).to_have_value("Clean match")
                expect(mobile.get_by_label("Rescan reason")).to_have_value("Missing cartons and extra EPCs detected")
                hold(mobile)
                expect(mobile.get_by_label("Rescan reason")).to_have_value("")
                trigger = mobile.get_by_role("button",name="Hold trigger *")
                trigger.press("Space")
                expect(mobile.get_by_text("Enter a rescan reason before starting another carton scan.")).to_be_visible()
                mobile.get_by_label("Rescan reason").fill("Checking repeatability")
                hold(mobile)
                reasons = mobile.evaluate("JSON.parse(localStorage.getItem('keypharm-connected-records-v1')).sessions.find(s => s.testId === 'KP-OUT-40').runs.map(r => r.reason)")
                assert reasons == ["", "Missing cartons and extra EPCs detected", "Checking repeatability"], reasons
                mobile.get_by_role("button",name="Continue",exact=True).click()
                expect(mobile.get_by_role("dialog",name="Pallet match recorded")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                mobile.get_by_label("Coverage and missing-test reason").fill("Both scan attempts reviewed.")
                mobile.get_by_label("Results reviewed and signed off").check()
                mobile.get_by_role("button",name="Close test session").click()
                expect(mobile.get_by_role("dialog",name="Test session closed")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                expect(mobile.locator("#workspace-connection")).to_contain_text("Scans saved on this handheld will sync when it reconnects.")

                transport["online"] = True
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.locator("#workspace-connection")).to_contain_text("Synced",timeout=25000)
                mobile.reload()
                expect(mobile.get_by_role("heading",name="Session closed")).to_be_visible()
                lead.get_by_role("button",name="Refresh records").click()
                closed_row = lead.get_by_role("row",name="KP-OUT-40",exact=False)
                expect(closed_row.get_by_role("cell", name="Closed",exact=True)).to_be_visible()
                lead.get_by_label("Role",exact=True).select_option("supervisor")
                expect(closed_row.get_by_role("button",name="Dispatch",exact=True)).to_be_disabled()
                lead.get_by_label("Role",exact=True).select_option("admin")
                expect(closed_row.get_by_role("button",name="Dispatch",exact=True)).to_be_enabled()
                expect(lead.get_by_role("button",name="Reopen session")).to_have_count(0)
                more = closed_row.get_by_role("button",name="More actions")
                more.click()
                floating = closed_row.get_by_role("group",name="Actions for KP-OUT-40")
                expect(floating).to_be_visible()
                expect(floating.get_by_role("button",name="Approve dispatch")).to_be_visible()
                assert closed_row.evaluate("row => row.cells.length") == 7
                more.press("Escape")
                expect(floating).to_be_hidden()
                more.click()
                expect(lead.get_by_role("button",name="Reopen session")).to_be_visible()
                lead.get_by_role("button",name="Reopen session").click()
                lead.get_by_role("dialog",name="Reopen session").get_by_role("button",name="Cancel").click()
                expect(floating).to_be_hidden()
                dispatch = lead.get_by_role("button",name="Confirm dispatch")
                expect(dispatch).to_be_disabled()
                expect(closed_row.get_by_role("button",name="Dispatch",exact=True)).to_be_enabled()
                closed_row.get_by_role("button",name="Dispatch",exact=True).click()
                direct = lead.get_by_role("dialog",name="Confirm dispatch")
                expect(direct).to_contain_text("This records approval")
                direct.get_by_role("button",name="Cancel").click()
                expect(lead.get_by_role("checkbox",name="Select KP-OUT-40 for dispatch")).to_be_enabled()
                viewer = dashboard("reviewer")
                viewer.goto(base + "/#manage")
                viewer.get_by_role("row",name="KP-OUT-40",exact=False).get_by_role("button",name="Approve dispatch",exact=True).click()
                viewer.get_by_role("dialog",name="Approve dispatch").get_by_role("button",name="Confirm").click()
                expect(viewer.get_by_role("dialog",name="Dispatch approved")).to_be_visible()
                viewer.get_by_role("button",name="Done").click()
                lead.get_by_role("button",name="Refresh records").click()
                expect(lead.get_by_role("checkbox",name="Select KP-HANDOFF for dispatch")).to_be_disabled()
                lead.get_by_role("checkbox",name="Select all dispatchable sessions").check()
                expect(lead.get_by_role("checkbox",name="Select KP-OUT-40 for dispatch")).to_be_checked()
                dispatch.click()
                lead.get_by_role("dialog",name="Confirm dispatch").get_by_role("button",name="Cancel").click()
                closed_row.get_by_role("button",name="Dispatch",exact=True).click()
                expect(lead.get_by_role("dialog",name="Confirm dispatch").get_by_role("listitem")).to_have_text("KP-OUT-40")
                with lead.expect_request("**/api/dispatch"):
                    lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Dispatch recorded")).to_be_visible()
                lead.get_by_role("button",name="Done").click()
                expect(lead.get_by_role("cell",name="Dispatched")).to_be_visible()
                supervisor.get_by_role("link",name="Inventory").click()
                expect(supervisor.get_by_role("row",name="Physalis 6 14")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Tiger Balm 5 10")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Biotona 19 16")).to_be_visible()
                viewer.reload()
                expect(viewer.get_by_role("cell",name="Dispatched")).to_be_visible()
                expect(viewer.get_by_role("button",name="Create session")).to_have_count(0)
                reviewer_headers = {"Authorization":auth,"X-KeyPharm-Role":"reviewer"}
                assert viewer.request.post(base + "/api/session",data={"testId":"Forbidden"},
                    headers=reviewer_headers).status == 403
                assert viewer.request.post(base + "/api/reset",data={"confirm":"RESET","generation":0},
                    headers=reviewer_headers).status == 403
                expect(viewer.get_by_role("button",name="Reset data *")).to_have_count(0)

                mobile.evaluate("window.keypharmEvent('back',{})")
                lead.goto(base + "/#devices")
                if lead.locator("#workspace-lead-settings").get_attribute("open") is None:
                    lead.get_by_text("Administrator settings",exact=True).click()
                lead.get_by_role("button",name="Reset data *").click()
                reset = lead.get_by_role("dialog",name="Reset data *")
                reset.get_by_label("Type RESET").fill("WRONG")
                reset.get_by_role("button",name="Confirm").click()
                expect(reset).to_be_visible()
                reset.get_by_role("button",name="Cancel").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_be_visible()
                lead.get_by_role("button",name="Reset data *").click()
                reset.get_by_label("Type RESET").fill("RESET")
                reset.get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Data reset *")).to_be_visible()
                lead.get_by_role("button",name="Done").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_have_count(0,timeout=15000)
                assert mobile.evaluate("window.closeCalls ?? 0") == 0
                mobile.evaluate("window.keypharmEvent('back',{})")
                assert mobile.evaluate("window.closeCalls") == 1
                supervisor.get_by_role("button",name="Refresh records").click()
                expect(supervisor.get_by_role("row",name="Physalis 20 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Tiger Balm 15 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Biotona 35 0")).to_be_visible()
                assert lead.request.post(base + "/api/sync",data={"generation":0},
                    headers={"Authorization":auth,"X-KeyPharm-Role":"admin"}).status == 409
                lead.goto(base + "/#manage")
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()
                lead.get_by_role("link",name="Devices & Setup").click()
                settings = lead.locator("#workspace-lead-settings")
                if settings.get_attribute("open") is None:
                    settings.locator("summary").click()
                expect(lead.get_by_label("Test plan")).to_have_value("")
                expect(lead.get_by_role("button",name="Reset data *")).to_be_visible()

                lead.get_by_role("link",name="Outbound").click()
                lead.get_by_role("button",name="+ New session").click()
                lead.get_by_label("Session ID").fill("KP-RESET-DEMO")
                lead.get_by_role("button",name="Use CSV *").click()
                lead.get_by_role("button",name="Create session").click()
                expect(mobile.get_by_role("button",name="KP-RESET-DEMO",exact=False)).to_be_visible(timeout=12000)
                transport["online"] = False
                mobile.evaluate("""() => {
                    const key = 'keypharm-connected-records-v1';
                    const records = JSON.parse(localStorage.getItem(key));
                    const session = structuredClone(records.sessions[0]);
                    session.id = crypto.randomUUID();
                    session.testId = 'KP-UNSYNCED-OLD';
                    session.workspaceRevision = 0;
                    records.sessions.push(session);
                    localStorage.setItem(key, JSON.stringify(records));
                }""")
                mobile.reload()
                expect(mobile.get_by_role("button",name="KP-UNSYNCED-OLD",exact=False)).to_be_visible()
                lead.get_by_role("link",name="Devices & Setup").click()
                if settings.get_attribute("open") is None:
                    settings.locator("summary").click()
                lead.get_by_role("button",name="Reset data *").click()
                lead.get_by_role("dialog").get_by_label("Type RESET").fill("RESET")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Data reset *")).to_be_visible()
                transport["online"] = True
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.get_by_role("button",name="KP-UNSYNCED-OLD",exact=False)).to_have_count(0,timeout=15000)
                lead.get_by_role("button",name="Done").click()
                lead.get_by_role("link",name="Outbound").click()
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()

                receiving = dashboard("operator")
                receiving.goto(base + "/#inbound")
                expect(receiving.get_by_role("heading",name="KP-IN-40")).to_be_visible()
                expect(receiving.get_by_role("button",name="Run count *")).to_have_count(0)
                generation = receiving.evaluate("async () => (await (await fetch('/api/workspace')).json()).generation")
                assert receiving.request.post(base + "/api/stock-action",data={"action":"scan","scenario":"partial","generation":generation},
                    headers={"Authorization":auth,"X-KeyPharm-Role":"operator"}).status == 403
                mobile.get_by_role("button",name="Stock tasks").click(timeout=15000)
                product = mobile.get_by_label("Product",exact=True)
                sku = mobile.get_by_label("SKU",exact=True)
                expect(product).to_be_visible()
                for received in range(1,41):
                    product.select_option(index=1)
                    sku.select_option(index=1)
                    mobile.get_by_role("button",name="EPC *").click()
                    mobile.get_by_role("button",name="Confirm",exact=True).click()
                    tagged = mobile.get_by_role("dialog",name="Carton tagged")
                    expect(tagged.get_by_role("heading",name="Tagged cartons")).to_be_visible()
                    if received == 40:
                        expect(tagged.get_by_text("Receipt complete.")).to_be_visible()
                    tagged.get_by_role("button",name="Done").click()
                    expect(mobile.get_by_text(f"{received} received · {40-received} outstanding",exact=True)).to_be_visible()
                receiving.get_by_role("button",name="Refresh records").click()
                expect(receiving.get_by_text("Storage · Completed",exact=False)).to_be_visible()
                expect(receiving.get_by_role("button",name="Confirm 40 cartons")).to_have_count(0)
                receiving.get_by_role("link",name="Stock counts").click()
                receiving.get_by_label("Location").select_option("Storage")
                receiving.get_by_role("button",name="Open count").click()
                expect(receiving.get_by_role("heading",name="Count Storage")).to_be_visible()
                expect(receiving.get_by_role("button",name="Run count *")).to_have_count(0)
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.get_by_role("option",name="Count Storage")).to_have_count(1)
                mobile.get_by_label("Task").select_option(label="Count Storage")
                count_epcs = [f"D5{index:022X}" for index in range(1,41)]
                mobile.evaluate("(epcs) => { window.testCountEpcs = [...epcs,epcs[0]]; }",count_epcs)
                mobile.get_by_role("button",name="Start count scan").click()
                transport["online"] = False
                mobile.get_by_role("button",name="Stop count scan").click()
                retry_count = mobile.get_by_role("button",name="Retry count upload")
                expect(retry_count).to_be_visible()
                transport["online"] = True
                retry_count.click()
                expect(mobile.get_by_text("40 matched · 0 missing · 0 extra")).to_be_visible()
                count_run = receiving.evaluate("""async () => (await (await fetch('/api/stock-workflows')).json())
                    .tasks.find(task => task.type === 'count').runs.at(-1)""")
                assert count_run["source"] == "C72 hardware" and count_run["observations"][count_epcs[0]] == 2
                mobile.evaluate("delete window.testCountEpcs")
                receiving.get_by_role("button",name="Refresh records").click()
                expect(receiving.get_by_text("40 expected · 40 observed · 40 matched",exact=True)).to_have_count(1)
                mobile.evaluate("window.keypharmEvent('back',{})")

                supervisor.goto(base + "/#counts")
                supervisor.get_by_role("button",name="Confirm count review").click()
                supervisor.get_by_role("dialog").get_by_role("button",name="Confirm",exact=True).click()
                expect(supervisor.get_by_role("dialog",name="Count reviewed")).to_be_visible()
                supervisor.get_by_role("button",name="Done").click()
                lead.goto(base + "/#inbound")
                lead.get_by_role("button",name="Prepare outbound pallet").click()
                lead.get_by_role("dialog").get_by_role("button",name="Confirm",exact=True).click()
                expect(lead.get_by_role("dialog",name="Pallet prepared")).to_be_visible()
                lead.get_by_role("button",name="Done").click()
                mobile.bring_to_front()
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.get_by_role("button",name="KP-RECEIVED-40",exact=False)).to_be_visible(timeout=30000)
                lead.get_by_role("link",name="Inventory",exact=True).click()
                lead.locator("#inventory-location").select_option("Storage")
                expect(lead.get_by_role("row",name="Physalis 14 0")).to_be_visible()
                lead.get_by_role("button",name="View Physalis cartons").click()
                received_carton = lead.locator('[data-carton="D50000000000000000000001"]')
                expect(received_carton).to_have_text(re.compile(r"^PHYSALIS-(XS|S|M|L)$"))
                carton_label = received_carton.inner_text()
                received_carton.click()
                carton_history = lead.get_by_role("heading",name=f"{carton_label} (00001) history")
                expect(carton_history).to_be_visible()
                lead.get_by_role("button",name="Close carton history").press("Enter")
                expect(carton_history).to_have_count(0)
                expect(received_carton).to_be_focused()
                received_carton.click()
                expect(carton_history).to_be_visible()
                expect(lead.get_by_text("Received",exact=True)).to_be_visible()
                expect(lead.get_by_role("button",name="Move carton",exact=True)).to_have_count(0)
                hold_form = lead.locator('[data-stock-action="hold"]')
                hold_form.get_by_label("Reason").fill("Check carton label")
                hold_form.get_by_role("button",name="Place on hold").click()
                lead.get_by_role("dialog",name="Place on hold").get_by_role("button",name="Confirm",exact=True).click()
                expect(received_carton).to_have_count(0)
                lead.locator("#inventory-location").select_option("Hold")
                expect(lead.get_by_role("row",name=re.compile(rf"{re.escape(carton_label)}.*Held"))).to_be_visible()
                lead.goto(base + "/#devices")
                if lead.locator("#workspace-lead-settings").get_attribute("open") is None:
                    lead.get_by_text("Administrator settings",exact=True).click()
                lead.get_by_label("Requested Power (dBm)").fill("17")
                lead.get_by_role("button",name="Save test settings").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                lead_headers = {"Authorization":auth,"X-KeyPharm-Role":"admin"}
                workspace = lead.request.get(base + "/api/workspace",headers=lead_headers).json()
                response = lead.request.post(base + "/api/session",headers=lead_headers,data={
                    "generation":workspace["generation"],"testId":"KP-POWER","location":"Staging","source":"C72 hardware"
                })
                assert response.status == 201, response.text()
                mobile.get_by_role("button",name="KP-POWER",exact=False).click(timeout=15000)
                expect(mobile.get_by_text("Recommended: 17 dBm",exact=True)).to_be_visible()
                mobile.wait_for_function("() => window.appliedPowers?.at(-1) === 17")
                lead.get_by_label("Requested Power (dBm)").fill("")
                lead.get_by_role("button",name="Save test settings").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                expect(mobile.get_by_text("Recommended: 30 dBm",exact=True)).to_be_visible(timeout=15000)
                mobile.wait_for_function("() => window.appliedPowers?.at(-1) === 30")
                lead.goto(base + "/#manage")
                power_row = lead.get_by_role("row",name="KP-POWER",exact=False)
                power_row.get_by_role("button",name="More actions").click()
                lead.get_by_role("button",name="Change recommended power").click()
                power_dialog = lead.get_by_role("dialog",name="Change recommended power")
                power_dialog.get_by_label("Recommended Power (dBm)").fill("21")
                power_dialog.get_by_role("button",name="Confirm").click()
                expect(power_row).to_contain_text("Recommended: 21 dBm")
                expect(mobile.get_by_text("Recommended: 21 dBm",exact=True)).to_be_visible(timeout=15000)
                mobile.wait_for_function("() => window.appliedPowers?.at(-1) === 21")
                expect(mobile.get_by_role("button",name="Save power")).to_have_count(0)
                lead.goto(base + "/#inbound")
                lead.get_by_text("Import receipt",exact=True).click()
                lead.get_by_label("Receipt CSV").set_input_files({
                    "name":"supplier-receipt.csv","mimeType":"text/csv",
                    "buffer":(b"receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier,batch_lot,units_per_carton\n"
                              b"KP-IN-SKU,Factory,Receiving,Physalis,2,,,SUP-001,LOT-01,10\n"
                              b"KP-IN-SKU,Factory,Receiving,Tiger Balm,1,,,SUP-002,LOT-02,10\n"),
                })
                lead.get_by_role("button",name="Preview receipt").click()
                expect(lead.get_by_text("Batch/lot LOT-01 · 10 units per carton",exact=True)).to_be_visible()
                lead.get_by_role("button",name="Create receipt").click()
                expect(lead.get_by_role("heading",name="KP-IN-SKU")).to_be_visible()
                mobile.evaluate("window.keypharmEvent('back',{})")
                mobile.get_by_role("button",name="Stock tasks").click(timeout=15000)
                expect(mobile.get_by_role("option",name="KP-IN-SKU")).to_have_count(1,timeout=15000)
                mobile.get_by_label("Task").select_option(label="KP-IN-SKU")
                product = mobile.get_by_label("Product",exact=True)
                sku = mobile.get_by_label("SKU",exact=True)
                product.select_option("SUP-002")
                expect(sku.get_by_role("option",name="TIGER BALM-M",exact=True)).to_have_count(1)
                expect(sku.get_by_role("option",name="PHYSALIS-M",exact=True)).to_have_count(0)
                product.select_option("SUP-001")
                expect(sku.get_by_role("option",name="PHYSALIS-M",exact=True)).to_have_count(1)
                expect(mobile.get_by_role("button",name="Scan EPC",exact=True)).to_have_count(0)
                sku.select_option(label="PHYSALIS-M")
                mobile.evaluate("window.testStockEpc = 'AB0001'")
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                assert mobile.evaluate("window.stockRead.powerDbm") == 10
                expect(mobile.get_by_text("AB0001",exact=True)).to_be_visible()
                assert mobile.evaluate("window.stockStop === window.stockRead.id")
                expect(mobile.get_by_text("AB00FF",exact=True)).to_have_count(0)
                pending_inventory = lead.request.get(base + "/api/workspace",headers=lead_headers).json()["inventory"]
                assert all(carton["epc"] != "AB0001" for carton in pending_inventory)
                mobile.get_by_role("button",name="Remove scanned tag").click()
                expect(mobile.get_by_text("AB0001",exact=True)).to_have_count(0)
                expect(mobile.get_by_role("button",name="Confirm",exact=True)).to_have_count(0)
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                mobile.get_by_role("button",name="Confirm",exact=True).click()
                tagged = mobile.get_by_role("dialog",name="Carton tagged")
                expect(tagged.get_by_text("AB0001",exact=True)).to_be_visible()
                saved_inventory = lead.request.get(base + "/api/workspace",headers=lead_headers).json()["inventory"]
                received_carton = next(carton for carton in saved_inventory if carton["epc"] == "AB0001")
                assert (received_carton["sku"],received_carton["batch_lot"],received_carton["units_per_carton"]) == ("Physalis","LOT-01",10)
                tagged.get_by_role("button",name="Done").click()
                assert received_carton["variant_size"] == "M"
                product.select_option("SUP-001")
                sku.select_option(label="PHYSALIS-M")
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                expect(mobile.locator("#notice")).to_have_text("This EPC is already tagged to Physalis in this task.")
                assert mobile.evaluate("window.lastToast") == "This EPC is already tagged to Physalis in this task."
                expect(mobile.get_by_role("button",name="Untag carton",exact=True)).to_have_count(0)
                sku.select_option(label="PHYSALIS-L")
                mobile.evaluate("window.testStockEpc = 'AB0002'")
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                mobile.get_by_role("button",name="Confirm",exact=True).click()
                tagged.get_by_role("button",name="Done").click()
                saved_inventory = lead.request.get(base + "/api/workspace",headers=lead_headers).json()["inventory"]
                mobile.get_by_role("button",name="Register a pallet").click()
                mobile.locator('select[name="material"]').select_option("WOOD")
                mobile.locator('select[name="size"]').select_option("M")
                expect(mobile.get_by_text("Shape",exact=True)).to_have_count(0)
                mobile.evaluate("window.testPalletReads = [{epc:'AC0003',rssi:'-35'}]")
                mobile.get_by_role("button",name="Scan pallet",exact=True).click()
                expect(mobile.get_by_text("AC0003",exact=True)).to_be_visible()
                mobile.get_by_role("button",name="Save pallet").click()
                mobile.get_by_role("dialog",name="Pallet registered").get_by_role("button",name="Done").click()
                mobile.evaluate("window.testPalletReads = undefined")
                lead.goto(base + "/#pallet-inventory")
                expect(lead.get_by_role("row").filter(has_text="AC0003")).to_contain_text("PAL-AC0003")
                lead.get_by_role("button",name="Configure pallets").click()
                builder = lead.get_by_role("dialog",name="Configure pallets")
                config = builder.get_by_role("region",name="Inventory configuration")
                material = config.locator('form[data-inventory-option="add"]').first
                material.get_by_label("Name").fill("Aluminum")
                material.get_by_role("button",name="Add material").click()
                remove = config.get_by_role("button",name="Remove Aluminum from materials")
                expect(remove).to_be_visible()
                expect(config.get_by_text("Aluminum · ALUM",exact=True)).to_be_visible()
                remove.click()
                expect(remove).to_have_count(0)
                builder.get_by_role("button",name="Close",exact=True).click()
                expect(builder).to_have_count(0)
                expect(lead.get_by_role("button",name="Configure pallets")).to_be_focused()
                lead.get_by_label("Pallet inventory CSV").set_input_files({
                    "name":"pallets.csv","mimeType":"text/csv",
                    "buffer":b"pallet_ref,pallet_epc,material,size\nPAL-SKU,AC0001,WOOD,M\nPAL-SKU-2,AC0002,PLAS,L\n",
                })
                lead.get_by_role("button",name="Import pallets").click()
                expect(lead.get_by_role("row",name=re.compile(r"PAL-SKU.*PAL-WOOD-M.*Wood"))).to_be_visible()
                lead.goto(base + "/#manifests")
                create_manifest = lead.locator('[data-manifest-form="sku-pallet"]').first
                received_sku = re.sub(r"-(\d+)$","",received_carton["carton"])
                other = next(c for c in saved_inventory if c["epc"] == "AB0002")
                other_sku = re.sub(r"-(\d+)$","",other["carton"])
                create_manifest.get_by_label("Pallet type").select_option("PAL-WOOD-M")
                quantity = create_manifest.locator(f'input[name="sku:{received_sku}"]')
                real_capacity = sum(c["physical"] and c["state"] == "available" and
                                    re.sub(r"-(\d+)$","",c["carton"]) == received_sku for c in saved_inventory)
                expect(quantity).to_have_attribute("max", str(real_capacity))
                quantity.fill("1")
                create_manifest.get_by_role("button",name="Generate manifest").click()
                lead.get_by_text("Add another pallet",exact=True).click()
                add = lead.locator('[data-manifest-form="sku-pallet"]').last
                add.get_by_label("Pallet type").select_option("PAL-PLAS-L")
                add.locator(f'input[name="sku:{other_sku}"]').fill("1")
                add.get_by_role("button",name="Add pallet to manifest").click()
                expect(lead.get_by_text("PAL-SKU-2 · 1 carton",exact=True)).to_be_visible()
                with lead.expect_download() as latest_download:
                    lead.get_by_role("link",name="Download CSV").click()
                content = Path(latest_download.value.path()).read_text(encoding="utf-8")
                assert "quantity" in content and "pallet_type" in content and received_sku.upper() in content and "AB0001" not in content
                lead.get_by_label("Session ID").fill("PAL-SKU")
                lead.get_by_role("button",name="Create session from manifest").click()
                expect(lead.get_by_role("link",name="Open session")).to_be_visible()
                lead.goto(base + "/#manage")
                row = lead.get_by_role("row").filter(has_text="PAL-SKU")
                mobile.get_by_role("button",name="Sessions",exact=True).click()
                mobile.get_by_role("button",name="PAL-SKU",exact=False).click(timeout=15000)
                expect(mobile.get_by_role("heading",name="Waiting for setup")).to_be_visible()
                expect(mobile.get_by_role("list",name="Test progress").get_by_role("listitem")).to_have_text(["Scan","Close"])
                expect(mobile.get_by_role("button",name="Record verification")).to_have_count(0)
                picker = mobile.get_by_label("Role",exact=True)
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                picker.select_option("supervisor")
                expect(picker).to_have_value("supervisor")
                expect(mobile.locator("#who")).to_be_hidden()
                mobile.get_by_label("Contents and label assignment verified").check()
                mobile.get_by_role("button",name="Record verification").click()
                mobile.get_by_role("dialog",name="Verification recorded").get_by_role("button",name="Done").click()
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                picker.select_option("operator")
                expect(mobile.get_by_role("button",name="Open pallet scanner",exact=True)).to_be_visible(timeout=15000)
                alternative = other["epc"]
                mobile.get_by_role("button",name="Sessions",exact=True).click()
                mobile.get_by_role("button",name="Search",exact=True).click()
                mobile.get_by_label("Session",exact=True).select_option(label="PAL-SKU · Outbound staging")
                mobile.locator("#lookup-sku").select_option("@pallet")
                mobile.locator("#lookup-target").select_option("AC0001")
                expect(mobile.get_by_role("button",name="Start search")).to_be_enabled()
                mobile.locator("#lookup-sku").select_option(received_sku)
                mobile.locator("#lookup-target").select_option("AB0001")
                expect(mobile.locator("#lookup-target option:checked")).to_contain_text("Physalis / PHYSALIS-M")
                mobile.get_by_label("EPC",exact=True).fill("AB0001")
                mobile.get_by_role("button",name="Find EPC").click()
                expect(mobile.get_by_text(received_sku.upper(),exact=True)).to_be_visible()
                for _ in range(2):
                    mobile.get_by_role("button",name="Start search").click()
                    popup = mobile.get_by_role("dialog",name="Searching")
                    expect(popup.get_by_text("AB0001")).to_be_visible()
                    popup.get_by_role("button",name="Stop search").click()
                    expect(popup).to_have_count(0)
                transport["online"] = False
                mobile.get_by_role("button",name="Home",exact=True).click()
                mobile.get_by_role("button",name="PAL-SKU",exact=False).click()
                mobile.reload()
                mobile.get_by_role("button",name="Open pallet scanner",exact=True).click()

                def scan_outbound(epcs):
                    mobile.evaluate("(epcs) => { window.testOutboundReads = epcs; }",epcs)
                    mobile.get_by_role("button",name="Start scan",exact=True).click()
                    mobile.get_by_role("button",name="Stop scan",exact=True).click()
                    expect(mobile.get_by_role("button",name="Start scan",exact=True)).to_be_visible()

                scan_outbound(["AC0001"])
                scan_outbound(["AC0001","AB0001"])
                mobile.get_by_role("button",name="Next pallet").click()
                scan_outbound(["AC0002"])
                scan_outbound(["AB0001"])
                expect(mobile.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
                scan_outbound([alternative])
                mobile.get_by_role("button",name="Continue",exact=True).click()
                expect(mobile.get_by_role("dialog",name="All pallets matched")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                transport["online"] = True
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                lead.get_by_role("button",name="Refresh records").click()
                expect(row.get_by_text("2 of 2 pallets matched")).to_be_visible()
                expect(row.get_by_role("checkbox",name="Select PAL-SKU for dispatch")).to_be_enabled()
                browser.close()
                print("Connected browser flow passed: offline outbound, reset, paired receiving, count review, carton history and C72 handoff.")
        finally:
            server.terminate()
            server.wait(timeout=10)
