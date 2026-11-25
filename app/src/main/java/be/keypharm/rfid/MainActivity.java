package be.keypharm.rfid;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.webkit.*;
import org.json.JSONObject;
import com.rscja.barcode.BarcodeDecoder;
import com.rscja.barcode.BarcodeFactory;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
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
    private static final int CAMERA_BARCODE = 12;
    private static final Set<String> ASSETS = Set.of(
            "/handheld.html", "/handheld.mjs", "/model.mjs", "/workspace-client.mjs", "/qrcode-generator.mjs", "/style.css",
            "/keypharm-logo.png", "/keypharm-logo-hd.png");
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService hardware = Executors.newSingleThreadExecutor();
    private final ExecutorService workspaceNetwork = Executors.newSingleThreadExecutor();
    private WebView web;
    private C72Reader reader;
    private int activeKey = -1;
    private String hardwareRun;
    private BarcodeDecoder barcodeDecoder;
    private String barcodeRequest;
    private boolean cameraBarcode;
    private int powerBeforeStockScan = -1;
    private DashboardServer dashboard;
    private volatile String snapshot = "{\"sessions\":[]}";
    private boolean destroyed;
    private volatile boolean foreground;
    private String template;
    private ToneGenerator tones;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        reader = new C72Reader(getApplicationContext());
        try { tones = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80); }
        catch (RuntimeException unavailable) { tones = null; }
        web = new WebView(this);
        web.setBackgroundColor(0xfff1f5f2);
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
                    boolean image = path.endsWith(".png");
                    String mime = image ? "image/png" : path.endsWith(".mjs") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
                    WebResourceResponse result = new WebResourceResponse(mime, image ? null : "UTF-8", getAssets().open(path.substring(1)));
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

    @Override public void onBackPressed() {
        event("back", new JSONObject());
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
        org.json.JSONArray reads = reader.drain();
        restoreStockPower();
        event("ended", C72Reader.json("id", id, "reads", reads,
                "interrupted", interrupted || !stopped, "message", stopped ? reason : "Reader did not confirm a complete capture"));
    }

    private void restoreStockPower() {
        if (powerBeforeStockScan < 0) return;
        int previous = powerBeforeStockScan;
        powerBeforeStockScan = -1;
        JSONObject result = reader.setPower(previous);
        if (!result.optBoolean("ok")) {
            event("reader", C72Reader.json("ready", false, "message", "Check reader power before scanning again"));
        }
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
        if (barcodeRequest != null && !cameraBarcode) endBarcode(barcodeRequest, "", "Barcode scan cancelled.");
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
        if (tones != null) tones.release();
        main.removeCallbacksAndMessages(null);
        hardware.execute(reader::disconnect);
        hardware.shutdown();
        workspaceNetwork.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    private void scanBarcode(String id) {
        if (!foreground || barcodeRequest != null) return;
        barcodeRequest = id;
        hardware.execute(() -> {
            try {
                barcodeDecoder = BarcodeFactory.getInstance().getBarcodeDecoder();
                if (hardwareRun != null || barcodeDecoder == null || !barcodeDecoder.open(this)) {
                    main.post(() -> useBarcodeCamera(id));
                    return;
                }
                barcodeDecoder.setDecodeCallback(result -> main.post(() -> {
                    if (!id.equals(barcodeRequest) || cameraBarcode) return;
                    String value = result == null ? null : result.getBarcodeData();
                    if (result != null && result.getResultCode() == BarcodeDecoder.DECODE_SUCCESS && value != null && !value.isBlank()) {
                        endBarcode(id, value, "");
                    } else useBarcodeCamera(id);
                }));
                if (!barcodeDecoder.startScan()) main.post(() -> useBarcodeCamera(id));
            } catch (RuntimeException | LinkageError error) {
                main.post(() -> useBarcodeCamera(id));
            }
        });
        main.postDelayed(() -> useBarcodeCamera(id), 5000);
    }

    private void closeBarcodeDecoder() {
        BarcodeDecoder decoder = barcodeDecoder;
        barcodeDecoder = null;
        if (decoder == null) return;
        try { decoder.stopScan(); }
        catch (RuntimeException | LinkageError ignored) { }
        try { decoder.close(); }
        catch (RuntimeException | LinkageError ignored) { }
    }

    private void useBarcodeCamera(String id) {
        if (!foreground || !id.equals(barcodeRequest) || cameraBarcode) return;
        cameraBarcode = true;
        hardware.execute(() -> {
            closeBarcodeDecoder();
            main.post(() -> {
                if (!id.equals(barcodeRequest)) return;
                if (!foreground) {
                    endBarcode(id, "", "Barcode scan cancelled.");
                    return;
                }
                try {
                    startActivityForResult(new Intent(this, CameraBarcodeActivity.class), CAMERA_BARCODE);
                } catch (RuntimeException error) {
                    endBarcode(id, "", "Camera barcode scanning is unavailable.");
                }
            });
        });
    }

    private void endBarcode(String id, String value, String message) {
        if (!id.equals(barcodeRequest)) return;
        barcodeRequest = null;
        cameraBarcode = false;
        hardware.execute(this::closeBarcodeDecoder);
        event("receipt-barcode", C72Reader.json("id", id, "value", value, "message", message));
    }

    private final class Bridge {
        @JavascriptInterface public void scanReceiptBarcode(String id) { main.post(() -> scanBarcode(id)); }
        @JavascriptInterface public void cancelReceiptBarcode(String id) {
            main.post(() -> endBarcode(id, "", "Barcode scan cancelled."));
        }
        @JavascriptInterface public void useReceiptBarcodeCamera(String id) {
            main.post(() -> useBarcodeCamera(id));
        }
        @JavascriptInterface public void closeApp() { main.post(MainActivity.this::finish); }

        @JavascriptInterface public void connectReader() {
            hardware.execute(() -> {
                if (hardwareRun == null) event("reader", reader.connect());
            });
        }

        @JavascriptInterface public void setReaderPower(String id, int power) {
            hardware.execute(() -> {
                JSONObject result = foreground && hardwareRun == null ? reader.setPower(power) :
                        C72Reader.json("ok", false, "message", "Finish the active scan before changing power");
                result = C72Reader.json("id", id, "ok", result.optBoolean("ok"),
                        "message", result.optString("message"), "previousPower", result.opt("previousPower"),
                        "ready", result.opt("ready"), "profile", result.opt("profile"));
                event("reader-power", result);
            });
        }

        @JavascriptInterface public void startReader(String id) { startScan(id, null); }

        @JavascriptInterface public void startStockReader(String id, int power) { startScan(id, power); }

        private void startScan(String id, Integer stockPower) {
            hardware.execute(() -> {
                boolean allowed = foreground && hardwareRun == null;
                if (allowed && stockPower != null) {
                    JSONObject result = reader.setPower(stockPower);
                    powerBeforeStockScan = result.optInt("previousPower", -1);
                    if (!result.optBoolean("ok")) {
                        restoreStockPower();
                        event("ended", C72Reader.json("id", id, "interrupted", true,
                                "message", result.optString("message")));
                        return;
                    }
                }
                JSONObject settings = allowed ? reader.start() : null;
                if (settings == null) {
                    if (allowed) restoreStockPower();
                    event("ended", C72Reader.json("id", id, "interrupted", true,
                            "message", allowed ? reader.failure : "UHF inventory did not start"));
                    return;
                }
                hardwareRun = id;
                event("started", C72Reader.json("id", id, "profile", settings));
                main.removeCallbacks(tick);
                main.postDelayed(tick, 200);
            });
        }

        @JavascriptInterface public void stopReader(String id, boolean interrupted) {
            hardware.execute(() -> finish(id, interrupted, interrupted ? "Scan interrupted" : ""));
        }

        @JavascriptInterface public void publishSnapshot(String json) { snapshot = json; }

        /** Short beep and buzz for a new unique EPC; longer error tone for reader loss or a failed scan. */
        @JavascriptInterface public void feedback(String kind) {
            boolean error = "error".equals(kind);
            main.post(() -> {
                if (destroyed) return;
                if (tones != null) tones.startTone(error ? ToneGenerator.TONE_PROP_NACK : ToneGenerator.TONE_PROP_BEEP, error ? 400 : 60);
                android.os.Vibrator vibrator = getSystemService(android.os.Vibrator.class);
                if (vibrator != null && vibrator.hasVibrator()) {
                    vibrator.vibrate(android.os.VibrationEffect.createOneShot(error ? 300 : 40, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                }
            });
        }

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

        @JavascriptInterface public void workspaceRequest(String id, String path, String authorization, String body) {
            if (!Set.of("login", "workspace", "sample", "physical-sample", "sync", "settings", "reset", "stock-action").contains(path)) return;
            workspaceNetwork.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL("http://127.0.0.1:8790/api/" + path).openConnection();
                    connection.setConnectTimeout(2500);
                    connection.setReadTimeout(4000);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestProperty("Authorization", authorization);
                    if ("workspace".equals(path)) {
                        String deviceId = reader.deviceId();
                        if (deviceId != null) connection.setRequestProperty("X-KeyPharm-Device-Id", deviceId);
                    }
                    if (body != null) {
                        connection.setDoOutput(true);
                        connection.setRequestMethod("POST");
                        connection.setRequestProperty("Content-Type", "application/json");
                        try (OutputStream output = connection.getOutputStream()) {
                            output.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    int status = connection.getResponseCode();
                    InputStream response = status < 400 ? connection.getInputStream() : connection.getErrorStream();
                    String content = "{}";
                    if (response != null) {
                        try (InputStream input = response; ByteArrayOutputStream result = new ByteArrayOutputStream()) {
                            byte[] buffer = new byte[4096];
                            for (int count; (count = input.read(buffer)) >= 0;) {
                                if (result.size() + count > 4_000_000) throw new IOException("Workspace response too large");
                                result.write(buffer, 0, count);
                            }
                            content = result.toString(StandardCharsets.UTF_8.name());
                        }
                    }
                    event("workspace-response", C72Reader.json("id", id, "status", status, "body", content));
                } catch (IOException error) {
                    event("workspace-response", C72Reader.json("id", id, "status", 0, "body", "{}"));
                } finally {
                    if (connection != null) connection.disconnect();
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

        @JavascriptInterface public String liveSampleManifest() {
            try (InputStream stream = getAssets().open("private-live-sample.csv");
                 ByteArrayOutputStream csv = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                for (int n; (n = stream.read(buffer)) != -1;) {
                    if (csv.size() + n > 512000) return "";
                    csv.write(buffer, 0, n);
                }
                return new String(csv.toByteArray(), StandardCharsets.UTF_8);
            } catch (IOException unavailable) {
                return "";
            }
        }

        @JavascriptInterface public void saveTemplate(String csv, String filename) {
            main.post(() -> {
                template = csv;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.setType("text/csv").addCategory(Intent.CATEGORY_OPENABLE)
                        .putExtra(Intent.EXTRA_TITLE, filename);
                startActivityForResult(intent, SAVE_TEMPLATE);
            });
        }

        @JavascriptInterface public void exportEvidence(String evidence, String records, String summary) {
            main.post(() -> {
                try {
                    long time = System.currentTimeMillis();
                    ArrayList<Uri> streams = new ArrayList<>();
                    streams.add(writeFile("keypharm-" + time + ".csv", evidence));
                    streams.add(writeFile("keypharm-" + time + "-records.csv", records));
                    streams.add(writeFile("keypharm-" + time + ".txt", summary));
                    Intent send = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/*");
                    send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);
                    ClipData clip = ClipData.newUri(getContentResolver(), "Evidence", streams.get(0));
                    for (Uri stream : streams.subList(1, streams.size())) clip.addItem(new ClipData.Item(stream));
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
        if (request == CAMERA_BARCODE) {
            String id = barcodeRequest;
            if (id != null) {
                String value = data == null ? null : data.getStringExtra("barcode");
                String message = data == null ? null : data.getStringExtra("message");
                endBarcode(id, result == RESULT_OK ? value : "", message == null && result != RESULT_OK ?
                        "Camera scan cancelled." : message == null ? "" : message);
            }
            return;
        }
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
