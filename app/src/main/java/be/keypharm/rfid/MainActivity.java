package be.keypharm.rfid;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.webkit.*;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://handheld.keypharm.invalid";
    private static final Set<Integer> SCAN_KEYS = Set.of(139, 280, 291, 293, 294, 311, 312, 313, 315, 591, 593, 594, 596);
    private static final int PICK_MANIFEST = 10;
    private static final int SAVE_TEMPLATE = 11;
    private static final Set<String> ASSETS = Set.of("/handheld.html", "/handheld.mjs", "/model.mjs", "/style.css");
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService hardware = Executors.newSingleThreadExecutor();
    private WebView web;
    private C72Reader reader;
    private int activeKey = -1;
    private String hardwareRun;
    private DashboardServer dashboard;
    private volatile String snapshot = "{\"sessions\":[]}";
    private boolean destroyed;
    private volatile boolean foreground;
    private String template;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        reader = new C72Reader(getApplicationContext());
        web = new WebView(this);
        web.setBackgroundColor(0xffeef2f5);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setBlockNetworkLoads(true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.w("KeypharmWeb", message.message() + " at " + message.lineNumber());
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "KeypharmAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String path = uri.getPath();
                if (!"https".equals(uri.getScheme()) || !"handheld.keypharm.invalid".equals(uri.getHost())
                        || path == null || !ASSETS.contains(path)) return blocked();
                try {
                    String mime = path.endsWith(".mjs") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
                    WebResourceResponse result = new WebResourceResponse(mime, "UTF-8", getAssets().open(path.substring(1)));
                    result.setResponseHeaders(java.util.Map.of("Content-Security-Policy",
                            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"));
                    return result;
                } catch (IOException error) { return blocked(); }
            }
            private WebResourceResponse blocked() {
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null, null);
            }
        });
        setContentView(web);
        web.loadUrl(ORIGIN + "/handheld.html");
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (!SCAN_KEYS.contains(code)) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && activeKey == -1) {
            activeKey = code;
            event("press", C72Reader.json("key", code));
        } else if (event.getAction() == KeyEvent.ACTION_UP && activeKey == code) {
            activeKey = -1;
            event(event.isCanceled() ? "cancel" : "release", C72Reader.json("key", code));
        }
        return true;
    }

    private void event(String type, JSONObject payload) {
        main.post(() -> {
            if (!destroyed) web.evaluateJavascript("window.keypharmEvent?.(" + JSONObject.quote(type) + "," + payload + ")", null);
        });
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            hardware.execute(() -> {
                String id = hardwareRun;
                if (id == null) return;
                if (!reader.healthy()) {
                    finish(id, true, "Reader connection or inventory lost");
                } else {
                    event("reads", C72Reader.json("id", id, "reads", reader.drain()));
                    main.postDelayed(this, 200);
                }
            });
        }
    };

    private void finish(String id, boolean interrupted, String reason) {
        if (!id.equals(hardwareRun)) return;
        hardwareRun = null;
        main.removeCallbacks(tick);
        boolean stopped = reader.stop();
        event("ended", C72Reader.json("id", id, "reads", reader.drain(),
                "interrupted", interrupted || !stopped, "message", stopped ? reason : "Reader did not confirm a complete capture"));
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (!focused && activeKey != -1) {
            activeKey = -1;
            event("cancel", new JSONObject());
            hardware.execute(() -> {
                if (hardwareRun != null) finish(hardwareRun, true, "Scan lost focus");
            });
        }
    }

    @Override protected void onPause() {
        foreground = false;
        activeKey = -1;
        event("cancel", new JSONObject());
        hardware.execute(() -> {
            if (hardwareRun != null) finish(hardwareRun, true, "Handheld app left the foreground");
        });
        super.onPause();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (dashboard != null) dashboard.close();
        main.removeCallbacksAndMessages(null);
        hardware.execute(reader::disconnect);
        hardware.shutdown();
        web.destroy();
        super.onDestroy();
    }

    private final class Bridge {
        @JavascriptInterface public void connectReader() {
            hardware.execute(() -> {
                if (hardwareRun == null) event("reader", reader.connect());
            });
        }

        @JavascriptInterface public void startReader(String id) {
            hardware.execute(() -> {
                if (!foreground || hardwareRun != null || !reader.start()) {
                    event("ended", C72Reader.json("id", id, "interrupted", true, "message", "UHF inventory did not start"));
                    return;
                }
                hardwareRun = id;
                main.removeCallbacks(tick);
                main.postDelayed(tick, 200);
            });
        }

        @JavascriptInterface public void stopReader(String id, boolean interrupted) {
            hardware.execute(() -> finish(id, interrupted, interrupted ? "Scan interrupted" : ""));
        }

        @JavascriptInterface public void publishSnapshot(String json) { snapshot = json; }

        @JavascriptInterface public void shareDashboard(boolean enable) {
            main.post(() -> {
                if (destroyed) return;
                try {
                    if (enable && dashboard == null) dashboard = new DashboardServer(getAssets(), () -> snapshot);
                    if (!enable && dashboard != null) {
                        dashboard.close();
                        dashboard = null;
                    }
                    event("dashboard", C72Reader.json("url", dashboard == null ? "" : dashboard.url()));
                } catch (IOException error) {
                    event("dashboard", C72Reader.json("message", "Dashboard could not start: " + error.getMessage()));
                }
            });
        }

        @JavascriptInterface public void copyLink(String value) {
            main.post(() -> {
                android.content.ClipboardManager clipboard = getSystemService(android.content.ClipboardManager.class);
                clipboard.setPrimaryClip(ClipData.newPlainText("Keypharm dashboard", value));
            });
        }

        @JavascriptInterface public void pickManifest() {
            main.post(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, PICK_MANIFEST);
            });
        }

        @JavascriptInterface public void saveTemplate(String csv) {
            main.post(() -> {
                template = csv;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.setType("text/csv").addCategory(Intent.CATEGORY_OPENABLE)
                        .putExtra(Intent.EXTRA_TITLE, "keypharm-sample.csv");
                startActivityForResult(intent, SAVE_TEMPLATE);
            });
        }

        @JavascriptInterface public void exportEvidence(String csv, String summary) {
            main.post(() -> {
                try {
                    long time = System.currentTimeMillis();
                    ArrayList<Uri> streams = new ArrayList<>();
                    streams.add(writeFile("keypharm-" + time + ".csv", csv));
                    streams.add(writeFile("keypharm-" + time + ".txt", summary));
                    Intent send = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/*");
                    send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);
                    ClipData clip = ClipData.newUri(getContentResolver(), "Evidence", streams.get(0));
                    clip.addItem(new ClipData.Item(streams.get(1)));
                    send.setClipData(clip);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(send, "Save or share POC evidence"));
                } catch (IOException | RuntimeException error) {
                    event("error", C72Reader.json("message", "Could not export evidence"));
                }
            });
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        try {
            if (request == PICK_MANIFEST) {
                String name = "Imported CSV";
                try (android.database.Cursor cursor = getContentResolver().query(uri,
                        new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) name = cursor.getString(0);
                }
                try (InputStream stream = getContentResolver().openInputStream(uri);
                     ByteArrayOutputStream csv = new ByteArrayOutputStream()) {
                    if (stream == null) throw new IOException("Could not open CSV");
                    byte[] buffer = new byte[4096];
                    for (int n; (n = stream.read(buffer)) != -1;) {
                        if (csv.size() + n > 512000) throw new IOException("Use a CSV smaller than 512 KB");
                        csv.write(buffer, 0, n);
                    }
                    event("manifest-file", C72Reader.json("name", name, "text", new String(csv.toByteArray(), StandardCharsets.UTF_8)));
                }
            } else if (request == SAVE_TEMPLATE && template != null) {
                try (OutputStream stream = getContentResolver().openOutputStream(uri)) {
                    if (stream == null) throw new IOException("Could not save template");
                    stream.write(template.getBytes(StandardCharsets.UTF_8));
                } finally { template = null; }
            }
        } catch (IOException | RuntimeException error) {
            event("error", C72Reader.json("message", error.getMessage() == null ? "File operation failed" : error.getMessage()));
        }
    }

    private Uri writeFile(String name, String content) throws IOException {
        try (FileOutputStream stream = new FileOutputStream(new File(getCacheDir(), name))) {
            stream.write(content.getBytes(StandardCharsets.UTF_8));
        }
        return Uri.parse("content://" + getPackageName() + ".evidence/" + name);
    }
}
