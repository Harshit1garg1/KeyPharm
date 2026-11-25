"""Exercise the desktop controls and actual handheld code against an isolated local backend."""
import base64
import json
import os
from pathlib import Path
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
    env = dict(os.environ,KEYPHARM_LOCAL_DATA=directory,KEYPHARM_PORT="0")
    with subprocess.Popen(["node","tools/workspace-server.mjs"],cwd=root,env=env,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as server:
        try:
            line = server.stdout.readline().strip()
            assert line.startswith("KeyPharm workspace: "), "Local workspace failed to start"
            base = line.split(" ",2)[2]
            accounts = json.loads((Path(directory) / "accounts.json").read_text(encoding="utf-8"))
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                def dashboard(account):
                    return browser.new_page(viewport={"width":1280,"height":800},
                        http_credentials={"username":account,"password":accounts[account]["password"]})

                lead = dashboard("lead")
                lead.goto(base + "/#inventory")
                expect(lead.locator("#connection")).to_have_text("")
                expect(lead.get_by_text("Test environment / Sample data",exact=False)).to_have_count(0)
                expect(lead.get_by_role("row",name="Juice 20 0")).to_be_visible()
                expect(lead.get_by_role("row",name="Tiger Balm 15 0")).to_be_visible()
                expect(lead.get_by_role("row",name="Biotona 35 0")).to_be_visible()
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
                expect(lead.get_by_role("heading",name="Juice cartons")).to_have_count(0)
                stock_table = lead.locator(".workspace-inventory > .workspace-table").bounding_box()
                details_pane = lead.locator("#inventory-cartons").bounding_box()
                assert stock_table["width"] <= 352 and details_pane["x"] > stock_table["x"] + stock_table["width"]
                expect(stock_row.get_by_role("button",name="Hide Biotona cartons")).to_have_attribute("aria-expanded","true")
                stock_row.get_by_role("button",name="Hide Biotona cartons").press("Enter")
                expect(lead.get_by_role("heading",name="Biotona cartons")).to_be_hidden()
                stock_row.get_by_role("button",name="View Biotona cartons").press("Enter")
                expect(lead.get_by_role("heading",name="Biotona cartons")).to_be_visible()
                rail = lead.locator(".dashboard-rail")
                pane = lead.locator("#content")
                sidebar = rail.bounding_box()
                pane.evaluate("(pane) => pane.scrollTop = pane.scrollHeight")
                assert pane.evaluate("(pane) => pane.scrollTop") > 0
                assert rail.bounding_box() == sidebar
                lead.get_by_role("link", name="Session controls").click()
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
                lead.get_by_text("Test lead settings",exact=True).click()
                lead.get_by_label("Test plan").fill("KP-OUT-40 Outbound presentation")
                lead.get_by_label("Requested C72 power (dBm)").fill("15")
                lead.get_by_role("button",name="Save test settings").click()
                expect(lead.locator("#workspace-message")).to_contain_text("Saved.")
                lead.get_by_label("Test ID").fill("KP-OUT-40")
                lead.get_by_role("button", name="Use Sample CSV").click()
                lead.get_by_role("button", name="Create session").click()
                expect(lead.get_by_role("link", name="KP-OUT-40")).to_be_visible()
                expect(lead.get_by_role("button",name="Reserve cartons")).to_have_count(0)
                lead.screenshot(path=str(root / "build/connected-sessions.png"),full_page=True)

                supervisor = dashboard("supervisor")
                supervisor.goto(base + "/#manage")
                supervisor.get_by_role("button",name="Record physical check").click()
                supervisor.get_by_label("Check notes").fill("Simulated pallet check for demonstration")
                supervisor.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(supervisor.get_by_role("cell",name="Ready to scan")).to_be_visible()
                expect(supervisor.get_by_role("dialog",name="Physical check recorded")).to_be_visible()
                supervisor.get_by_role("button",name="Done").click()

                mobile = browser.new_page(viewport={"width":360,"height":740})
                mobile.route("https://handheld.test/**",serve_assets)
                transport = {"online": True}
                def bridge(_source,path,authorization,body):
                    if not transport["online"]:
                        return {"status":0,"body":"{}"}
                    request = urllib.request.Request(base + "/api/" + path,
                        data=body.encode("utf-8") if body is not None else None,
                        headers={"Authorization":authorization,"Content-Type":"application/json"})
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
                    feedback(){}, publishSnapshot(){}, connectReader(){}, closeApp(){ window.closeCalls = (window.closeCalls ?? 0) + 1; }
                  };
                """)
                mobile.goto("https://handheld.test/handheld.html")
                expect(mobile.get_by_text("Test environment / Sample data",exact=True)).to_have_count(0)
                mobile.get_by_label("Username").fill("handheld")
                mobile.get_by_label("Password").fill(accounts["handheld"]["password"])
                mobile.get_by_role("button",name="Sign in").click()
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                expect(mobile.locator(".workspace-bubble")).to_have_attribute("data-visible","false")
                mobile.get_by_label("Role",exact=True).select_option("reviewer")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                expect(mobile.locator("#who")).to_have_text("Reviewer")
                expect(mobile.get_by_role("button",name="Sign in")).to_have_count(0)
                mobile.get_by_label("Role",exact=True).select_option("operator")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                expect(mobile.locator("#who")).to_have_text("Operator")
                heights = [mobile.locator(selector).bounding_box()["height"] for selector in
                    ["#workspace-role","[data-workspace=retry]","[data-workspace=logout]"]]
                assert max(heights) == min(heights), heights
                mobile.locator("#workspace-role").focus()
                lead.get_by_label("Test ID").fill("KP-HANDOFF")
                lead.get_by_role("button", name="Use Sample CSV").click()
                csv = lead.evaluate("async () => (await (await fetch('api/sample')).json()).csv")
                with lead.expect_file_chooser() as file_chooser:
                    lead.get_by_label("Choose a CSV").click()
                file_chooser.value.set_files({"name":"browser-manifest.csv","mimeType":"text/csv","buffer":csv.encode()})
                expect(zone.get_by_role("status")).to_have_text("browser-manifest.csv")
                expect(lead.get_by_role("button",name="Use Sample CSV")).to_have_attribute("aria-pressed","false")
                lead.get_by_role("button", name="Create session").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_be_visible(timeout=12000)
                lead.get_by_role("row",name="KP-HANDOFF",exact=False).get_by_role("button",name="Change CSV").click()
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
                hold(mobile)
                expect(mobile.get_by_label("Rescan reason")).to_have_count(0)
                mobile.get_by_label("Demo reads").select_option("Missing and unexpected")
                hold(mobile)
                expect(mobile.locator("#scan-results")).to_contain_text("Hold")
                expect(mobile.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
                mobile.reload()
                mobile.get_by_role("button",name="Open carton scanner").click()
                mobile.get_by_label("Demo reads").select_option("Clean match")
                mobile.get_by_label("Rescan reason").fill("Neighbouring carton removed")
                hold(mobile)
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
                expect(lead.get_by_role("button",name="Reopen session")).to_have_count(0)
                closed_row.get_by_role("button",name="Open closed session").click()
                expect(lead.get_by_role("button",name="Reopen session")).to_be_visible()
                lead.get_by_role("button",name="Reopen session").click()
                lead.get_by_role("dialog",name="Reopen session").get_by_role("button",name="Cancel").click()
                closed_row.get_by_role("button",name="Hide session actions").click()
                dispatch = lead.get_by_role("button",name="Confirm dispatch")
                expect(dispatch).to_be_disabled()
                expect(lead.get_by_role("checkbox",name="Select KP-OUT-40 for dispatch")).to_be_disabled()
                viewer = dashboard("viewer")
                viewer.goto(base + "/#manage")
                viewer.get_by_role("button",name="Open closed session").click()
                viewer.get_by_role("button",name="Approve dispatch").click()
                viewer.get_by_role("dialog",name="Approve dispatch").get_by_role("button",name="Confirm").click()
                expect(viewer.get_by_role("dialog",name="Dispatch approved")).to_be_visible()
                viewer.get_by_role("button",name="Done").click()
                lead.get_by_role("button",name="Refresh records").click()
                expect(lead.get_by_role("checkbox",name="Select KP-HANDOFF for dispatch")).to_be_disabled()
                lead.get_by_role("checkbox",name="Select all dispatchable sessions").check()
                expect(lead.get_by_role("checkbox",name="Select KP-OUT-40 for dispatch")).to_be_checked()
                dispatch.click()
                with lead.expect_request("**/api/dispatch"):
                    lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Dispatch recorded")).to_be_visible()
                lead.get_by_role("button",name="Done").click()
                expect(lead.get_by_role("cell",name="Dispatched")).to_be_visible()
                supervisor.get_by_role("link",name="Inventory").click()
                expect(supervisor.get_by_role("row",name="Juice 6 14")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Tiger Balm 5 10")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Biotona 19 16")).to_be_visible()
                viewer.reload()
                expect(viewer.get_by_role("cell",name="Dispatched")).to_be_visible()
                expect(viewer.get_by_role("button",name="Create session")).to_have_count(0)
                viewer_auth = base64.b64encode(("viewer:" + accounts["viewer"]["password"]).encode()).decode()
                assert viewer.request.post(base + "/api/session",data={"testId":"Forbidden"},
                    headers={"Authorization":"Basic " + viewer_auth}).status == 403
                assert viewer.request.post(base + "/api/reset",data={"confirm":"RESET","generation":0},
                    headers={"Authorization":"Basic " + viewer_auth}).status == 403
                expect(viewer.get_by_role("button",name="Reset demo data")).to_have_count(0)

                mobile.evaluate("window.keypharmEvent('back',{})")
                mobile.get_by_label("Role",exact=True).select_option("admin")
                expect(mobile.locator('#workspace-connection [role="status"]')).to_have_text("Synced")
                mobile.get_by_role("button",name="Reset demo data").click()
                reset = mobile.get_by_role("dialog",name="Reset demo data")
                reset.get_by_label("Type RESET").fill("WRONG")
                reset.get_by_role("button",name="Reset demo data").click()
                expect(reset).to_be_visible()
                reset.get_by_role("button",name="Cancel").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_be_visible()
                mobile.get_by_role("button",name="Reset demo data").click()
                reset.get_by_label("Type RESET").fill("RESET")
                reset.get_by_role("button",name="Reset demo data").click()
                expect(mobile.get_by_role("dialog",name="Demo data reset")).to_be_visible()
                mobile.get_by_role("button",name="Done").click()
                expect(mobile.get_by_role("button",name="KP-HANDOFF",exact=False)).to_have_count(0)
                expect(mobile.locator("#who")).to_have_text("Test lead")
                assert mobile.evaluate("window.closeCalls ?? 0") == 0
                mobile.evaluate("window.keypharmEvent('back',{})")
                assert mobile.evaluate("window.closeCalls") == 1
                supervisor.get_by_role("button",name="Refresh records").click()
                expect(supervisor.get_by_role("row",name="Juice 20 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Tiger Balm 15 0")).to_be_visible()
                expect(supervisor.get_by_role("row",name="Biotona 35 0")).to_be_visible()
                lead_auth = base64.b64encode(("lead:" + accounts["lead"]["password"]).encode()).decode()
                assert lead.request.post(base + "/api/sync",data={"generation":0},
                    headers={"Authorization":"Basic " + lead_auth}).status == 409
                lead.reload()
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()
                settings = lead.locator("#workspace-lead-settings")
                if settings.get_attribute("open") is None:
                    settings.locator("summary").click()
                expect(lead.get_by_label("Test plan")).to_have_value("")
                expect(lead.get_by_role("button",name="Reset demo data")).to_be_visible()

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
                if settings.get_attribute("open") is None:
                    settings.locator("summary").click()
                lead.get_by_role("button",name="Reset demo data").click()
                lead.get_by_role("dialog").get_by_label("Type RESET").fill("RESET")
                lead.get_by_role("dialog").get_by_role("button",name="Confirm").click()
                expect(lead.get_by_role("dialog",name="Demo data reset")).to_be_visible()
                transport["online"] = True
                mobile.get_by_role("button",name="Sync now").click()
                expect(mobile.get_by_role("button",name="KP-UNSYNCED-OLD",exact=False)).to_have_count(0,timeout=15000)
                expect(lead.get_by_text("No sessions yet.")).to_be_visible()
                browser.close()
                print("Connected browser flow passed: role handoff, offline scan, manifest replacement, dispatch, stock, and reset.")
        finally:
            server.terminate()
            server.wait(timeout=10)
