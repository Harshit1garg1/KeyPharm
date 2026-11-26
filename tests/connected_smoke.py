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
    trigger = page.get_by_role("button",name="Hold demo trigger")
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
                    page = browser.new_page(viewport={"width":1280,"height":800},
                        http_credentials={"username":"testing","password":password})
                    page.goto(base)
                    expect(page.get_by_label("Role",exact=True)).to_have_value("operator")
                    page.get_by_label("Role",exact=True).select_option(role)
                    return page

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
                expect(lead.locator(".theme-sun")).to_be_visible()
                lead.screenshot(path=str(root / "build/connected-inventory.png"),full_page=True)
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
                expect(lead.locator("[data-total=activity]")).to_be_visible()
                expect(lead.locator("#recent-sessions-count")).to_have_text("0")
                assert lead.locator("#overview-reports").bounding_box()["x"] > lead.locator(".dashboard-heading").bounding_box()["x"]
                lead.screenshot(path=str(root / "build/overview-desktop.png"),full_page=True)
                lead.get_by_role("link", name="Devices & Setup").click()
                lead.get_by_text("Administrator settings",exact=True).click()
                lead.get_by_label("Test plan").fill("KP-OUT-40 Outbound presentation")
                lead.get_by_label("Requested Power (dBm)").fill("15")
                lead.get_by_role("button",name="Save test settings").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                lead.get_by_role("link", name="Outbound").click()
                lead.get_by_role("button", name="+ New session").click()
                zone = lead.locator("#workspace-create [data-csv-drop]")
                expect(zone).to_be_visible()
                sample_button = lead.get_by_role("button",name="Use Sample CSV")
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
                lead.get_by_label("Test ID").fill("KP-OUT-40")
                lead.get_by_role("button", name="Use Sample CSV").click()
                lead.get_by_role("button", name="Create session").click()
                expect(lead.get_by_role("link", name="KP-OUT-40")).to_be_visible()
                expect(lead.get_by_role("button",name="Reserve cartons")).to_have_count(0)
                lead.screenshot(path=str(root / "build/connected-sessions.png"),full_page=True)

                supervisor = dashboard("supervisor")
                supervisor.goto(base + "/#manage")
                lead.get_by_role("row",name="KP-OUT-40",exact=False).get_by_role("button",name="More actions").click()
                lead.get_by_role("button",name="Record physical check").click()
                lead.get_by_label("Check notes").fill("Simulated pallet check for demonstration")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("cell",name="Ready to scan")).to_be_visible()
                expect(lead.get_by_role("dialog",name="Physical check recorded")).to_be_visible()
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
                    scanReceiptBarcode(id) { window.receiptBarcodeRequest = id; },
                    useReceiptBarcodeCamera(id) {
                      setTimeout(() => window.keypharmEvent('receipt-barcode',{id,value:'SUP-001'}),0);
                    },
                    cancelReceiptBarcode(){},
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
                expect(lead.locator("#workspace-device-pill")).to_contain_text("a01234b56789cdef")
                assert lead.locator("#workspace-lead-settings").bounding_box()["y"] < lead.locator(".devices-section").bounding_box()["y"]
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
                mobile.get_by_label("Role",exact=True).select_option("reviewer")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                expect(mobile.locator("#who")).to_have_text("Reviewer")
                expect(mobile.get_by_role("button",name="Sign in")).to_have_count(0)
                mobile.get_by_label("Role",exact=True).select_option("operator")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                expect(mobile.locator("#who")).to_have_text("Operator")
                nav = mobile.get_by_role("navigation",name="Main menu")
                expect(nav.locator("button svg")).to_have_count(3)
                for tab in ("Home","LookUp","Settings"):
                    expect(nav.get_by_role("button",name=tab,exact=True)).to_be_visible()
                expect(mobile.get_by_role("heading",name="PoC test plan")).to_be_hidden()
                heights = [mobile.locator(selector).bounding_box()["height"] for selector in
                    ["#workspace-role","[data-workspace=retry]","[data-workspace=logout]"]]
                assert max(heights) == min(heights), heights
                mobile.locator("#workspace-role").focus()
                lead.get_by_label("Test ID").fill("KP-HANDOFF")
                lead.get_by_role("button", name="Use Sample CSV").click()
                lead.get_by_role("button",name="Create session").click()
                expect(lead.locator("#workspace-message")).to_contain_text("assigned to KP-OUT-40")
                expect(lead.get_by_label("Test ID")).to_have_value("KP-HANDOFF")
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
                expect(lead.get_by_role("button",name="Use Sample CSV")).to_have_attribute("aria-pressed","false")
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
                expect(mobile.get_by_text("Simulation",exact=False).first).to_be_visible()
                mobile.evaluate("window.keypharmEvent('back',{})")
                expect(mobile.get_by_role("heading",name="Sessions")).to_be_visible()
                mobile.get_by_role("button",name="KP-OUT-40",exact=False).click()
                transport["online"] = False
                mobile.get_by_role("button",name="Open pallet scanner").click()
                expect(mobile.locator("#workspace-connection")).to_be_hidden()
                expect(mobile.locator("#who")).to_be_hidden()
                mobile.evaluate("window.keypharmEvent('back',{})")
                expect(mobile.get_by_role("button",name="Open pallet scanner")).to_be_visible()
                mobile.get_by_role("button",name="Open pallet scanner").click()
                mobile.get_by_role("button",name="Hold demo trigger").tap()
                expect(mobile.get_by_label("Rescan reason")).to_have_count(0)
                expect(mobile.get_by_label("Demo reads")).to_have_value("Clean match")
                assert mobile.evaluate("document.activeElement.id") != "scenario"
                mobile.get_by_label("Demo reads").select_option("Missing and unexpected")
                hold(mobile)
                expect(mobile.locator("#scan-results")).to_contain_text("Hold")
                expect(mobile.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
                mobile.get_by_role("button",name="Scan results").click()
                expect(mobile.get_by_role("heading",name="Scan attempts")).to_be_visible()
                expect(mobile.get_by_role("list",name="Test progress")).to_be_visible()
                expect(mobile.locator(".steps li")).to_have_count(4)
                expect(mobile.get_by_text("Test setup",exact=True)).to_have_count(0)
                expect(mobile.get_by_role("button",name="Export this test")).to_be_visible()
                expect(mobile.get_by_text("Session log",exact=False).first).to_be_visible()
                mobile.reload()
                mobile.get_by_role("button",name="Open carton scanner").click()
                expect(mobile.get_by_label("Demo reads")).to_have_value("Clean match")
                expect(mobile.get_by_label("Rescan reason")).to_have_value("Missing cartons and extra EPCs detected")
                hold(mobile)
                expect(mobile.get_by_label("Rescan reason")).to_have_value("")
                trigger = mobile.get_by_role("button",name="Hold demo trigger")
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
                expect(viewer.get_by_role("button",name="Reset demo data")).to_have_count(0)

                mobile.evaluate("window.keypharmEvent('back',{})")
                mobile.get_by_label("Role",exact=True).select_option("admin")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                mobile.get_by_role("button",name="Settings",exact=True).click()
                mobile.get_by_role("button",name="Reset demo data").click()
                reset = mobile.get_by_role("dialog",name="Reset demo data")
                reset.get_by_label("Type RESET").fill("WRONG")
                reset.get_by_role("button",name="Reset demo data").click()
                expect(reset).to_be_visible()
                reset.get_by_role("button",name="Cancel").click()
                mobile.get_by_role("button",name="Home",exact=True).click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_be_visible()
                mobile.get_by_role("button",name="Settings",exact=True).click()
                mobile.get_by_role("button",name="Reset demo data").click()
                reset.get_by_label("Type RESET").fill("RESET")
                reset.get_by_role("button",name="Reset demo data").click()
                expect(mobile.get_by_role("dialog",name="Demo data reset")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_have_count(0)
                expect(mobile.locator("#who")).to_have_text("Administrator")
                assert mobile.evaluate("window.closeCalls ?? 0") == 0
                mobile.evaluate("window.keypharmEvent('back',{})")
                assert mobile.evaluate("window.closeCalls") == 1
                supervisor.get_by_role("button",name="Refresh records").click()
                expect(supervisor.get_by_role("row",name="Physalis 20 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Tiger Balm 15 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Biotona 35 0")).to_be_visible()
                assert lead.request.post(base + "/api/sync",data={"generation":0},
                    headers={"Authorization":auth,"X-KeyPharm-Role":"admin"}).status == 409
                lead.reload()
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()
                lead.get_by_role("link",name="Devices & Setup").click()
                settings = lead.locator("#workspace-lead-settings")
                if settings.get_attribute("open") is None:
                    settings.locator("summary").click()
                expect(lead.get_by_label("Test plan")).to_have_value("")
                expect(lead.get_by_role("button",name="Reset demo data")).to_be_visible()

                lead.get_by_role("link",name="Outbound").click()
                lead.get_by_role("button",name="+ New session").click()
                lead.get_by_label("Test ID").fill("KP-RESET-DEMO")
                lead.get_by_role("button",name="Use Sample CSV").click()
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
                lead.get_by_role("button",name="Reset demo data").click()
                lead.get_by_role("dialog").get_by_label("Type RESET").fill("RESET")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Demo data reset")).to_be_visible()
                transport["online"] = True
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.get_by_role("button",name="KP-UNSYNCED-OLD",exact=False)).to_have_count(0,timeout=15000)
                lead.get_by_role("button",name="Done").click()
                lead.get_by_role("link",name="Outbound").click()
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()

                receiving = dashboard("operator")
                receiving.goto(base + "/#inbound")
                expect(receiving.get_by_role("heading",name="KP-IN-40")).to_be_visible()
                expect(receiving.get_by_role("button",name="Run simulation")).to_have_count(0)
                generation = receiving.evaluate("async () => (await (await fetch('/api/workspace')).json()).generation")
                assert receiving.request.post(base + "/api/stock-action",data={"action":"scan","scenario":"partial","generation":generation},
                    headers={"Authorization":auth,"X-KeyPharm-Role":"operator"}).status == 403
                mobile.get_by_label("Role",exact=True).select_option("operator")
                mobile.get_by_role("button",name="Stock tasks").click(timeout=15000)
                expect(mobile.get_by_role("heading",name="Select product")).to_be_visible()
                for received in range(1,41):
                    mobile.get_by_role("button",name="Scan barcode").click()
                    mobile.get_by_role("button",name="Simulate EPC").click()
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
                expect(receiving.get_by_role("button",name="Run simulation")).to_have_count(0)
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
                expect(mobile.get_by_role("button",name="KP-RECEIVED-40",exact=False)).to_be_visible(timeout=15000)
                lead.get_by_role("link",name="Inventory",exact=True).click()
                lead.locator("#inventory-location").select_option("Storage")
                expect(lead.get_by_role("row",name="Physalis 14 0")).to_be_visible()
                received_carton = lead.locator('[data-carton="D50000000000000000000001"]')
                expect(received_carton).to_have_text(re.compile(r"^Physalis-(XS|S|M|L)-\d+$"))
                carton_label = received_carton.inner_text()
                received_carton.click()
                expect(lead.get_by_role("heading",name=f"{carton_label} history")).to_be_visible()
                expect(lead.get_by_text("Received",exact=True)).to_be_visible()
                expect(lead.get_by_label("Destination").locator("option")).to_have_text(["Receiving","Storage (current)","Staging","Hold"])
                expect(lead.get_by_label("Destination").locator('option[value="Storage"][disabled]')).to_have_count(1)
                expect(lead.get_by_role("button",name="Place on hold")).to_have_count(0)
                lead.get_by_label("Destination").select_option("Hold")
                lead.get_by_label("Reason").fill("Check carton label")
                lead.get_by_role("button",name="Move carton").click()
                lead.get_by_role("dialog",name="Place on hold").get_by_role("button",name="Confirm",exact=True).click()
                expect(received_carton).to_have_count(0)
                lead.locator("#inventory-location").select_option("Hold")
                expect(lead.get_by_role("row",name=re.compile(rf"{re.escape(carton_label)}.*Held"))).to_be_visible()
                lead.goto(base + "/#devices")
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
                mobile.get_by_label("Role",exact=True).select_option("reviewer")
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
                mobile.get_by_label("Role",exact=True).select_option("admin")
                transport["online"] = False
                mobile.get_by_label("Recommended Power (dBm)").fill("23")
                mobile.get_by_role("button",name="Save power").click()
                mobile.wait_for_function("() => window.appliedPowers?.at(-1) === 23")
                transport["online"] = True
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                lead.get_by_role("button",name="Refresh records").click()
                expect(power_row).to_contain_text("Recommended: 23 dBm")
                lead.goto(base + "/#inbound")
                lead.get_by_text("Import receipt",exact=True).click()
                lead.get_by_label("Receipt CSV").set_input_files({
                    "name":"supplier-receipt.csv","mimeType":"text/csv",
                    "buffer":(b"receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier,batch_lot,units_per_carton\n"
                              b"KP-IN-SKU,Factory,Receiving,Physalis,2,,,SUP-001,LOT-01,10\n"),
                })
                lead.get_by_role("button",name="Preview receipt").click()
                expect(lead.get_by_text("Batch/lot LOT-01 · 10 units per carton",exact=True)).to_be_visible()
                lead.get_by_role("button",name="Create receipt").click()
                expect(lead.get_by_role("heading",name="KP-IN-SKU")).to_be_visible()
                mobile.evaluate("window.keypharmEvent('back',{})")
                mobile.get_by_label("Role",exact=True).select_option("operator")
                mobile.get_by_role("button",name="Stock tasks").click(timeout=15000)
                expect(mobile.get_by_role("option",name="KP-IN-SKU")).to_have_count(1,timeout=15000)
                mobile.get_by_label("Task").select_option(label="KP-IN-SKU")
                expect(mobile.get_by_label("Product Identifier")).to_have_value("SUP-001")
                expect(mobile.get_by_label("Demo barcode")).to_be_checked()
                mobile.get_by_label("Demo barcode").uncheck()
                mobile.get_by_role("button",name="Scan barcode").click()
                expect(mobile.get_by_role("button",name="Scanning barcode…")).to_be_disabled()
                mobile.get_by_role("button",name="Use camera").click()
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
                mobile.get_by_label("Demo barcode").check()
                mobile.get_by_role("button",name="Scan barcode").click()
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                expect(mobile.locator("#notice")).to_have_text("This EPC is already tagged to Physalis in this task.")
                assert mobile.evaluate("window.lastToast") == "This EPC is already tagged to Physalis in this task."
                mobile.get_by_label("Role",exact=True).select_option("admin")
                expect(mobile.get_by_label("Stock Task Power (dBm)")).to_have_value("10")
                mobile.get_by_label("Stock Task Power (dBm)").fill("12")
                mobile.get_by_role("button",name="Save power").click()
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                mobile.get_by_role("button",name="Untag carton",exact=True).click()
                mobile.get_by_role("dialog",name="Untag carton").get_by_label("Reason").fill("Wrong carton")
                mobile.get_by_role("button",name="Confirm untag").click()
                expect(mobile.get_by_role("dialog",name="Carton untagged")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                expect(mobile.get_by_text("AB0001",exact=True)).to_have_count(0)
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                mobile.get_by_label("Role",exact=True).select_option("operator")
                expect(mobile.locator("#who")).to_have_text("Operator")
                mobile.get_by_role("button",name="Scan barcode").click()
                mobile.get_by_role("button",name="Scan EPC",exact=True).click()
                assert mobile.evaluate("window.stockRead.powerDbm") == 12
                mobile.get_by_role("button",name="Confirm",exact=True).click()
                expect(mobile.get_by_role("dialog",name="Carton tagged")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                lead.goto(base + "/#manifests")
                lead.get_by_label("Pallet reference").fill("PAL-LOOKUP")
                lead.get_by_role("button",name="Request pallet scan").click()
                expect(lead.get_by_text("Awaiting pallet scan · RFID handheld",exact=False)).to_be_visible()
                mobile.get_by_role("button",name="PAL-LOOKUP",exact=True).click(timeout=15000)
                mobile.evaluate("window.testPalletReads = [{epc:'AC0011',rssi:-70},{epc:'AC0001',rssi:-48}]")
                mobile.get_by_role("button",name="Scan pallet",exact=True).click()
                expect(mobile.get_by_text("Scanned pallet tag",exact=True)).to_be_visible()
                expect(mobile.get_by_text("AC0001",exact=True)).to_be_visible()
                assert mobile.evaluate("window.stockRead.powerDbm") == 15
                assert mobile.evaluate("window.stockStop === window.stockRead.id")
                mobile.get_by_role("button",name="Clear pallet tag and rescan").click()
                mobile.get_by_role("button",name="Scan pallet",exact=True).click()
                expect(mobile.get_by_text("AC0001",exact=True)).to_be_visible()
                mobile.get_by_role("button",name="Send Scan",exact=True).click()
                confirm_pallet = mobile.get_by_role("dialog",name="Send pallet scan")
                expect(confirm_pallet).to_contain_text("AC0001")
                confirm_pallet.screenshot(path=str(root / "build/pallet-confirm-dialog.png"))
                confirm_pallet.get_by_role("button",name="Cancel",exact=True).click()
                expect(confirm_pallet).to_be_hidden()
                mobile.get_by_role("button",name="Send Scan",exact=True).click()
                confirm_pallet.get_by_role("button",name="Confirm",exact=True).click()
                mobile.evaluate("delete window.testPalletReads")
                expect(mobile.locator("#notice")).to_have_text("Pallet scan sent to the dashboard.")
                lead.get_by_role("button",name="Refresh records").click()
                lead.locator('input[name="epc"][value="AB0001"]').check()
                lead.evaluate("document.activeElement?.blur()")
                lead.wait_for_timeout(5300)
                expect(lead.locator('input[name="epc"][value="AB0001"]')).to_be_checked()
                lead.get_by_role("button",name="Preview manifest").click()
                expect(lead.get_by_role("heading",name="Preview pickup list")).to_be_visible()
                expect(lead.get_by_role("row",name="Physalis",exact=False)).to_contain_text("Receiving")
                lead.get_by_role("button",name="Generate manifest").click()
                lead.get_by_text("Add another pallet",exact=True).click()
                expect(lead.get_by_role("button",name="Request new pallet scan")).to_be_visible()
                lead.get_by_label("Pallet reference",exact=True).fill("PAL-LOOKUP-2")
                lead.get_by_role("button",name="Request pallet scan",exact=True).click()
                mobile.get_by_role("button",name="PAL-LOOKUP-2",exact=True).click(timeout=15000)
                mobile.evaluate("window.testPalletReads = [{epc:'AC0002',rssi:-48}]")
                mobile.get_by_role("button",name="Scan pallet",exact=True).click()
                expect(mobile.get_by_text("AC0002",exact=True)).to_be_visible()
                mobile.get_by_role("button",name="Send Scan",exact=True).click()
                confirm_pallet = mobile.get_by_role("dialog",name="Send pallet scan")
                expect(confirm_pallet).to_contain_text("AC0002")
                confirm_pallet.get_by_role("button",name="Confirm",exact=True).click()
                mobile.evaluate("delete window.testPalletReads")
                expect(mobile.locator("#notice")).to_have_text("Pallet scan sent to the dashboard.")
                lead.get_by_role("button",name="Refresh records").click()
                expect(lead.locator('input[name="epc"][value="AB0001"]')).to_have_count(0)
                second_carton = lead.locator('input[name="epc"]').first
                second_epc = second_carton.get_attribute("value")
                second_carton.check()
                lead.get_by_role("button",name="Preview manifest").click()
                lead.get_by_role("button",name="Generate manifest").click()
                expect(lead.get_by_role("link",name="Download CSV")).to_be_visible()
                lead.get_by_label("Manifest requests").select_option(label="PAL-LOOKUP · Manifest ready")
                lead.get_by_text("Add another pallet",exact=True).click()
                lead.get_by_label("Existing pallet").select_option(value="AC0002")
                lead.get_by_role("button",name="Add existing pallet").click()
                expect(lead.get_by_role("option",name="PAL-LOOKUP-2 · Manifest ready")).to_have_count(0)
                with lead.expect_download() as pending_download:
                    lead.get_by_role("link",name="Download CSV").click()
                download = pending_download.value
                assert download.suggested_filename == "pallet-manifest.csv"
                csv_lines = Path(download.path()).read_text(encoding="utf-8").splitlines()
                assert len(csv_lines) == 3 and "AC0001" in csv_lines[1] and "AC0002" in csv_lines[2], csv_lines
                assert "AB0001" in csv_lines[1] and second_epc in csv_lines[2], csv_lines
                lead.get_by_role("button",name="Create session from manifest").click()
                expect(lead.get_by_role("link",name="Open session")).to_be_visible()
                mobile.get_by_role("button",name="Sessions",exact=True).click()
                mobile.get_by_role("button",name="LookUp",exact=True).click()
                expect(mobile.get_by_role("option",name="PAL-LOOKUP · Staging")).to_have_count(1,timeout=15000)
                mobile.get_by_label("Session",exact=True).select_option(label="PAL-LOOKUP · Staging")
                mobile.get_by_role("button",name="Start lookup").click()
                mobile.evaluate("window.keypharmEvent('reads',{id:window.lookupReadId,reads:[{epc:'AB0001',rssi:-30},{epc:'AC0001',rssi:-48}]})")
                expect(mobile.locator("#lookup-rssi")).to_have_text("RSSI -48 dBm")
                mobile.wait_for_function("window.lookupBeeps > 0")
                mobile.get_by_role("button",name="Stop lookup").click()
                lead.goto(base + "/#manage")
                multi = lead.get_by_role("row").filter(has_text="PAL-LOOKUP")
                multi.get_by_role("button",name="More actions").click()
                multi.get_by_role("button",name="Record physical check").click()
                lead.get_by_role("dialog").get_by_role("button",name="Confirm",exact=True).click()
                lead.get_by_role("button",name="Done").click()
                mobile.get_by_role("button",name="Home",exact=True).click()
                mobile.get_by_role("button",name="PAL-LOOKUP",exact=False).click(timeout=15000)
                mobile.get_by_role("button",name="Open pallet scanner",exact=True).click(timeout=15000)

                def scan_outbound(epcs):
                    mobile.evaluate("(epcs) => { window.testOutboundReads = epcs; }",epcs)
                    mobile.get_by_role("button",name="Start scan",exact=True).click()
                    mobile.get_by_role("button",name="Stop scan",exact=True).click()
                    expect(mobile.get_by_role("button",name="Start scan",exact=True)).to_be_visible()

                scan_outbound(["AC0001"])
                expect(mobile.get_by_role("heading",name="Scan cartons")).to_be_visible()
                scan_outbound(["AB0001"])
                mobile.get_by_role("button",name="Next pallet").click()
                expect(mobile.get_by_text("Pallet 2 of 2",exact=False)).to_be_visible()
                scan_outbound(["AC0001"])
                expect(mobile.get_by_role("heading",name="Scan pallet")).to_be_visible()
                scan_outbound(["AC0002"])
                scan_outbound([second_epc])
                mobile.get_by_role("button",name="Continue",exact=True).click()
                expect(mobile.get_by_role("dialog",name="All pallets matched")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                mobile.evaluate("delete window.testOutboundReads")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced",timeout=15000)
                lead.get_by_role("button",name="Refresh records").click()
                expect(multi.get_by_text("2 of 2 pallets matched")).to_be_visible()
                expect(multi.get_by_role("checkbox",name="Select PAL-LOOKUP for dispatch")).to_be_enabled()
                mobile.get_by_role("button",name="Sessions",exact=True).click()
                mobile.get_by_role("button",name="LookUp",exact=True).click()
                lead.goto(base + "/#scans")
                expect(lead.locator("#catalog-tabs")).to_be_visible()
                expect(lead.locator("#detail")).not_to_contain_text("C72")
                lead.goto(base + "/#manifests")
                lead.get_by_role("button",name="Remove pallet manifest").click()
                lead.get_by_role("dialog").get_by_role("button",name="Confirm",exact=True).click()
                expect(lead.get_by_role("option",name=re.compile(r"^PAL-LOOKUP ·"))).to_have_count(0)
                lead.goto(base + "/#devices")
                lead.get_by_text("Administrator settings",exact=True).click()
                lead.get_by_label("Pallet Scan Power (dBm)").fill("16")
                lead.get_by_label("LookUp Power (dBm)").fill("13")
                with lead.expect_response(lambda response: response.url.endswith("/api/settings") and response.ok):
                    lead.get_by_role("button",name="Save test settings").click()
                lead.reload()
                lead.get_by_text("Administrator settings",exact=True).click()
                expect(lead.get_by_label("Pallet Scan Power (dBm)")).to_have_value("16")
                expect(lead.get_by_label("LookUp Power (dBm)")).to_have_value("13")
                lead.goto(base + "/#manage")
                row = lead.get_by_role("row").filter(has_text="PAL-LOOKUP")
                row.get_by_text("More actions",exact=True).click()
                row.get_by_role("button",name="Remove session").click()
                lead.get_by_role("dialog").get_by_role("button",name="Confirm",exact=True).click()
                expect(row).to_have_count(0)
                expect(mobile.get_by_role("option",name="PAL-LOOKUP · Staging")).to_have_count(0,timeout=15000)
                browser.close()
                print("Connected browser flow passed: offline outbound, reset, paired receiving, count review, carton history and C72 handoff.")
        finally:
            server.terminate()
            server.wait(timeout=10)
