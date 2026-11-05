package app.patchpilot;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Everything the bundled UI is allowed to ask Android to do.
 *
 * The page talks to this class through a single `call(id, action, payloadJson)`
 * and is answered asynchronously through `window.__patchpilotBridge`, so a slow
 * mirror never blocks the WebView's JavaScript thread. The actions are exactly
 * the ones `src/app/native.ts` declares; nothing here is reachable from a
 * remote page because the WebView only ever loads PatchPilot's own assets.
 */
public class NativeShell {

    private final Activity activity;
    private final WebView webView;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final HttpBridge http;
    private final ApkInspector inspector;
    private final LibraryStore library;
    private final KeyValueStore store;
    private final MorpheScanner morphe;

    public NativeShell(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.http = new HttpBridge(activity);
        this.inspector = new ApkInspector(activity);
        this.library = new LibraryStore(activity);
        this.store = new KeyValueStore(activity);
        this.morphe = new MorpheScanner(activity);
    }

    @JavascriptInterface
    public void call(final String id, final String action, final String payloadJson) {
        pool.execute(() -> {
            try {
                JSONObject payload = payloadJson == null || payloadJson.isEmpty()
                        ? new JSONObject()
                        : new JSONObject(payloadJson);
                Object value = dispatch(id, action, payload);
                respond(id, value, null);
            } catch (Throwable error) {
                respond(id, null, describe(error));
            }
        });
    }

    /** Version and device, read once by the page at startup. */
    @JavascriptInterface
    public String deviceJson() {
        JSONObject device = new JSONObject();
        try {
            device.put("version", BuildConfig.VERSION_NAME);
            device.put("sdk", Build.VERSION.SDK_INT);
            device.put("model", Build.MANUFACTURER + " " + Build.MODEL);
            JSONArray abis = new JSONArray();
            for (String abi : Build.SUPPORTED_ABIS) abis.put(abi);
            device.put("abis", abis);
        } catch (JSONException ignored) {
            // The keys are fixed strings; this cannot happen.
        }
        return device.toString();
    }

    private Object dispatch(String id, String action, JSONObject payload) throws Exception {
        switch (action) {
            case "net.request":
                return http.request(payload);

            case "net.download": {
                // A download has to survive the app going to the background.
                DownloadService.start(activity, payload.optString("fileName", "APK"));
                try {
                    return http.download(payload, progress -> {
                        emit(id, progress);
                        DownloadService.progress(progress);
                    });
                } finally {
                    DownloadService.stop(activity);
                }
            }

            case "apk.inspect":
                return inspector.inspect(payload.getString("path"));

            case "apk.inspectBytes":
                return inspector.inspectBytes(payload.getString("name"), payload.getString("base64"));

            case "apk.install":
                install(payload.getString("handle"));
                return true;

            case "app.openMorphe":
                return openMorphe();

            case "morphe.scan":
                return morphe.scan();

            case "morphe.read":
                return morphe.read(payload.getString("path"));

            case "device.state":
                return deviceState();

            case "library.publish":
                return library.publish(payload.getString("path"), payload.getString("name"));

            case "library.list":
                return library.list();

            case "library.delete":
                return library.delete(payload.getString("handle"));

            case "files.delete":
                return deleteFile(payload.getString("path"));

            case "store.get":
                return store.get(payload.getString("key"));

            case "store.set":
                store.set(payload.getString("key"), payload.getString("value"));
                return true;

            case "ui.toast":
                toast(payload.optString("message", ""));
                return true;

            case "open.url":
                openUrl(payload.getString("url"));
                return true;

            default:
                throw new IllegalArgumentException("Unknown action: " + action);
        }
    }

    /**
     * Opens Morphe Manager if it is installed. There is no shared contract for its
     * package id (it is a ReVanced Manager fork, and debug builds differ), so a
     * short list is tried and a miss is reported rather than guessed at.
     */
    private JSONObject openMorphe() throws JSONException {
        String[] candidates = {
                "app.morphe.manager",
                "app.morphe.manager.debug",
                "app.revanced.manager.flutter",
                "app.revanced.manager",
        };
        android.content.pm.PackageManager manager = activity.getPackageManager();
        JSONObject result = new JSONObject();
        for (String candidate : candidates) {
            Intent launch = manager.getLaunchIntentForPackage(candidate);
            if (launch == null) continue;
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(launch);
                result.put("package", candidate);
                return result;
            } catch (RuntimeException ignored) {
                // Try the next candidate.
            }
        }
        result.put("package", JSONObject.NULL);
        return result;
    }

    /** Facts the Doctor screen needs: room to download, and whether it may install. */
    private JSONObject deviceState() throws JSONException {
        JSONObject state = new JSONObject();

        android.os.StatFs stats = new android.os.StatFs(activity.getFilesDir().getAbsolutePath());
        state.put("freeBytes", stats.getAvailableBytes());
        state.put("totalBytes", stats.getTotalBytes());

        boolean installAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || activity.getPackageManager().canRequestPackageInstalls();
        state.put("installAllowed", installAllowed);

        android.app.NotificationManager notifications =
                (android.app.NotificationManager) activity.getSystemService(Activity.NOTIFICATION_SERVICE);
        state.put("notifications", notifications != null && notifications.areNotificationsEnabled());
        return state;
    }

    /* ------------------------------------------------------------- utilities --- */

    private boolean deleteFile(String path) {
        if (path == null || path.isEmpty()) return false;
        return new File(path).delete();
    }

    private void toast(final String message) {
        if (message == null || message.isEmpty()) return;
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    /**
     * Hands a verified APK to the system installer. The file is already in the
     * public Downloads folder, so the installer can read it and the user can
     * confirm the install without leaving the app.
     */
    private void install(String handle) throws Exception {
        if (handle == null || handle.isEmpty()) throw new IllegalArgumentException("No file to install");
        android.net.Uri uri = handle.startsWith("content://")
                ? android.net.Uri.parse(handle)
                : android.net.Uri.fromFile(new java.io.File(handle));
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
        } catch (android.content.ActivityNotFoundException error) {
            throw new IllegalStateException(
                    "No installer available. Open Downloads/PatchPilot and tap the file instead.");
        }
    }

    private void openUrl(String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (RuntimeException error) {
            toast("No app can open that link");
        }
    }

    private void respond(String id, Object value, String error) {
        JSONObject envelope = new JSONObject();
        try {
            envelope.put("ok", error == null);
            if (error == null) envelope.put("value", value == null ? JSONObject.NULL : value);
            else envelope.put("error", error);
        } catch (JSONException ignored) {
            return;
        }
        evaluate("window.__patchpilotBridge && window.__patchpilotBridge.resolve("
                + JSONObject.quote(id) + "," + JSONObject.quote(envelope.toString()) + ");");
    }

    private void emit(String id, JSONObject event) {
        evaluate("window.__patchpilotBridge && window.__patchpilotBridge.event("
                + JSONObject.quote(id) + "," + JSONObject.quote(event.toString()) + ");");
    }

    private void evaluate(final String script) {
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (RuntimeException ignored) {
                // The page may have been destroyed; nothing to report to.
            }
        });
    }

    private static String describe(Throwable error) {
        String message = error.getMessage();
        if (message != null && !message.isEmpty()) return message;
        return error.getClass().getSimpleName();
    }

    public void shutdown() {
        pool.shutdownNow();
    }

    /** Progress frames for a running download. */
    interface ProgressSink {
        void onProgress(JSONObject event);
    }

    /** Convenience for the HTTP bridge, which needs to parse JSON arrays. */
    static JSONArray arrayOf(long... values) {
        JSONArray array = new JSONArray();
        for (long value : values) array.put(value);
        return array;
    }
}
