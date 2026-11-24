package be.keypharm.rfid;

import android.content.Context;
import android.os.Build;
import com.rscja.deviceapi.RFIDWithUHFUART;
import com.rscja.deviceapi.interfaces.IUHF;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.List;

final class C72Reader {
    // Chainway UHF sample maps 0x04 to ETSI. The region stays read-only.
    private static final int ETSI = 0x04;
    private static final int MIN_POWER_DBM = 5;
    private static final int MAX_POWER_DBM = 30;
    // Functional design 9.1: stored with every run so runs are comparable. Bump it when the approved
    // profile rules change (region lock, power limits, SDK). Power itself is recorded per run.
    private static final String PROFILE_VERSION = "C72-ETSI-1";
    private final Context context;
    private RFIDWithUHFUART sdk;
    private JSONObject profile;
    private final List<JSONObject> pending = new ArrayList<>();
    private long generation;
    private boolean collecting;
    private boolean overflow;

    C72Reader(Context context) { this.context = context; }

    JSONObject connect() {
        disconnect();
        JSONObject state = json("ready", false, "message", "UHF reader unavailable");
        try {
            sdk = RFIDWithUHFUART.getInstance();
            if (sdk == null || !sdk.init(context)) {
                disconnect();
                return state;
            }
            int region = sdk.getFrequencyMode();
            int power = sdk.getPower();
            profile = settings(region, power);
            if (region != ETSI || power <= 0) {
                state = json("ready", false, "profile", profile,
                        "message", "Check ETSI region and power in the approved reader setup");
                disconnect();
                return state;
            }
            return json("ready", true, "profile", profile, "message", "UHF reader ready");
        } catch (Exception | LinkageError error) {
            state = json("ready", false, "message", "UHF initialization failed: " + error.getClass().getSimpleName());
            disconnect();
            return state;
        }
    }

    JSONObject setPower(int requested) {
        if (sdk == null) return json("ok", false, "ready", false, "message", "Check the reader connection first");
        if (requested < MIN_POWER_DBM || requested > MAX_POWER_DBM) {
            return json("ok", false, "message", "Choose a power from 5 to 30 dBm");
        }
        try {
            int region = sdk.getFrequencyMode();
            int previous = sdk.getPower();
            if (region != ETSI || previous <= 0 || sdk.isInventorying()) {
                return json("ok", false, "message", "Reader must be idle with an ETSI profile and readable power");
            }
            boolean applied = previous == requested || sdk.setPower(requested);
            int actual = sdk.getPower();
            profile = settings(region, actual);
            boolean confirmed = applied && actual == requested;
            return json("ok", confirmed, "ready", actual > 0, "profile", profile, "previousPower", previous,
                    "message", confirmed ? "Reader power set to " + actual + " dBm" :
                            "Reader did not confirm " + requested + " dBm. Check the output power.");
        } catch (Exception | LinkageError error) {
            return json("ok", false, "message", "Could not set reader power. Check the reader connection.");
        }
    }

    /** Why the last start() returned null, for the run's interruption message. */
    String failure = "";

    /** Re-reads region and power, then starts inventory. Returns the settings used for this run (FR-08), or null. */
    JSONObject start() {
        failure = "UHF inventory did not start";
        if (sdk == null) return null;
        final long attempt;
        synchronized (pending) {
            pending.clear();
            overflow = false;
            collecting = true;
            attempt = ++generation;
        }
        try {
            int region = sdk.getFrequencyMode();
            int power = sdk.getPower();
            JSONObject used = settings(region, power);
            if (region != ETSI || power <= 0) {
                failure = "Reader is not on ETSI with a readable power setting";
                haltReads();
                return null;
            }
            boolean unfiltered = sdk.setFilter(IUHF.Bank_EPC, 0, 0, "")
                    & sdk.setFilter(IUHF.Bank_TID, 0, 0, "")
                    & sdk.setFilter(IUHF.Bank_USER, 0, 0, "");
            if (!unfiltered || !sdk.setEPCMode()) {
                haltReads();
                return null;
            }
            sdk.setInventoryCallback(tag -> {
                synchronized (pending) {
                    if (!collecting || generation != attempt) return;
                    if (pending.size() >= 20000) {
                        overflow = true;
                        return;
                    }
                    pending.add(json("epc", tag.getEPC(), "rssi", tag.getRssi(), "ms", System.currentTimeMillis()));
                }
            });
            if (sdk.startInventoryTag()) {
                profile = used;
                return used;
            }
        } catch (Exception | LinkageError ignored) {
            disconnect();
        }
        haltReads();
        return null;
    }

    private JSONObject settings(int region, int power) {
        String device = android.provider.Settings.Secure.getString(context.getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID);
        return json("name", "C72 ETSI", "version", PROFILE_VERSION, "model", Build.MODEL, "build", Build.DISPLAY, "deviceId", device,
                "firmware", sdk.getVersion(), "region", region == ETSI ? "ETSI" : "Unverified (" + region + ")",
                "powerDbm", power > 0 ? power : JSONObject.NULL, "antenna", "Not reported");
    }

    boolean stop() {
        boolean stopped = false;
        try {
            stopped = sdk != null && sdk.stopInventory();
        } catch (Exception | LinkageError ignored) {
            // Report an interrupted run when the reader does not confirm stop.
        } finally {
            haltReads();
        }
        return stopped && !overflow;
    }

    boolean healthy() {
        try { return sdk != null && sdk.isInventorying(); }
        catch (Exception | LinkageError error) { return false; }
    }

    JSONArray drain() {
        synchronized (pending) {
            JSONArray reads = new JSONArray(pending);
            pending.clear();
            return reads;
        }
    }

    private void haltReads() { synchronized (pending) { collecting = false; } }

    void disconnect() {
        haltReads();
        RFIDWithUHFUART current = sdk;
        sdk = null;
        if (current != null) {
            try { current.free(); }
            catch (Exception | LinkageError ignored) { }
        }
    }

    static JSONObject json(Object... fields) {
        JSONObject object = new JSONObject();
        try {
            for (int i = 0; i < fields.length; i += 2) object.put((String) fields[i], fields[i + 1]);
        } catch (org.json.JSONException error) { throw new IllegalArgumentException(error); }
        return object;
    }
}
