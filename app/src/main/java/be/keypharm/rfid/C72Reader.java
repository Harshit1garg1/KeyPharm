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
    // Chainway UHF sample maps 0x04 to ETSI. Inspect settings without changing region or power.
    private static final int ETSI = 0x04;
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
            profile = json("name", "C72 ETSI", "model", Build.MODEL, "build", Build.DISPLAY,
                    "firmware", sdk.getVersion(), "region", region == ETSI ? "ETSI" : "Unverified (" + region + ")",
                    "powerDbm", power > 0 ? power : JSONObject.NULL, "antenna", "Not reported");
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

    boolean start() {
        if (sdk == null) return false;
        final long attempt;
        synchronized (pending) {
            pending.clear();
            overflow = false;
            collecting = true;
            attempt = ++generation;
        }
        try {
            boolean unfiltered = sdk.setFilter(IUHF.Bank_EPC, 0, 0, "")
                    & sdk.setFilter(IUHF.Bank_TID, 0, 0, "")
                    & sdk.setFilter(IUHF.Bank_USER, 0, 0, "");
            if (!unfiltered || !sdk.setEPCMode()) {
                haltReads();
                return false;
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
            if (sdk.startInventoryTag()) return true;
        } catch (Exception | LinkageError ignored) {
            disconnect();
        }
        haltReads();
        return false;
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
