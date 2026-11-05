package app.patchpilot;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Looks for Morphe Manager's patch sources on the device.
 *
 * Android normally forbids one app from reading another's private files, which
 * is exactly where Morphe keeps its source list and its downloaded bundles. So
 * this does not pretend: it probes what is genuinely reachable (the install
 * itself, the shared folders Morphe may have written to, and its private
 * directory on a rooted device) and reports precisely what it could and could
 * not read. Anything it finds is handed to the page as paths; bytes only come
 * back through {@link #read}, which refuses files a scan did not name.
 */
public class MorpheScanner {

    private static final String[] PACKAGES = {
            "app.morphe.manager",
            "app.morphe.manager.debug",
            "app.revanced.manager.flutter",
            "app.revanced.manager",
    };

    /** Names worth carrying back: bundles, patch lists, and Flutter's preference file. */
    private static final int MAX_FILES = 400;
    private static final int MAX_DEPTH = 4;
    private static final long MAX_FILE_BYTES = 24L * 1024 * 1024;

    private final Activity activity;
    /** Paths this class has handed out; `read` accepts nothing else. */
    private final Set<String> discovered = new LinkedHashSet<>();

    public MorpheScanner(Activity activity) {
        this.activity = activity;
    }

    public JSONObject scan() throws JSONException {
        JSONObject result = new JSONObject();
        JSONArray installed = new JSONArray();
        JSONArray files = new JSONArray();
        JSONArray unreadable = new JSONArray();
        discovered.clear();

        PackageManager manager = activity.getPackageManager();
        for (String name : PACKAGES) {
            PackageInfo info;
            try {
                info = manager.getPackageInfo(name, 0);
            } catch (PackageManager.NameNotFoundException absent) {
                continue;
            }

            JSONObject entry = new JSONObject();
            entry.put("package", name);
            entry.put("version", info.versionName == null ? JSONObject.NULL : info.versionName);
            entry.put("pendingRestart", false);
            installed.put(entry);

            for (String root : rootsFor(name)) {
                collect(new File(root), 0, files, unreadable);
            }
        }

        // Morphe also writes into plain shared folders depending on its settings.
        for (String shared : new String[] { "/sdcard/Download/Morphe", "/storage/emulated/0/Download/Morphe" }) {
            collect(new File(shared), 0, files, unreadable);
        }

        result.put("installed", installed);
        result.put("files", files);
        result.put("unreadable", unreadable);
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("rooted", isProbablyRooted());
        result.put("notes", notes(installed.length(), files.length(), unreadable.length()));
        return result;
    }

    /** Reads back a file a scan reported, so the page can parse it. */
    public JSONObject read(String path) throws Exception {
        if (path == null || !discovered.contains(path)) {
            throw new SecurityException("That file was not found by a scan");
        }
        File file = new File(path);
        if (!file.isFile()) throw new IllegalStateException("That file is gone");
        if (file.length() > MAX_FILE_BYTES) throw new IllegalStateException("That file is too large to read");

        JSONObject result = new JSONObject();
        result.put("path", path);
        result.put("name", file.getName());
        result.put("sizeBytes", file.length());
        result.put("base64", Base64.encodeToString(bytesOf(file), Base64.NO_WRAP));
        return result;
    }

    private String[] rootsFor(String name) {
        return new String[] {
                // App-private: only readable with root, but if it is readable that
                // is where the source list and the cached bundles live.
                "/data/data/" + name,
                "/data/user/0/" + name,
                "/data/user_de/0/" + name,
                // Shared storage: readable up to Android 10, and Android/media is
                // still readable on newer versions for apps that use it.
                "/sdcard/Android/data/" + name + "/files",
                "/sdcard/Android/media/" + name,
                "/storage/emulated/0/Android/data/" + name + "/files",
                "/storage/emulated/0/Android/media/" + name,
        };
    }

    private void collect(File root, int depth, JSONArray files, JSONArray unreadable) throws JSONException {
        if (files.length() >= MAX_FILES) return;
        if (!root.exists()) return;

        File[] children = root.listFiles();
        if (children == null) {
            // Exists but is closed to us: record why, once, instead of silently
            // pretending there was nothing there.
            JSONObject entry = new JSONObject();
            entry.put("path", root.getAbsolutePath());
            entry.put("reason", "Android does not allow other apps to read this folder");
            unreadable.put(entry);
            return;
        }

        for (File child : children) {
            if (files.length() >= MAX_FILES) return;
            String name = child.getName();
            if (child.isDirectory()) {
                if (depth + 1 > MAX_DEPTH) continue;
                if (name.equals("lib") || name.equals("cache") || name.startsWith(".")) continue;
                collect(child, depth + 1, files, unreadable);
                continue;
            }

            String lower = name.toLowerCase();
            boolean wanted = lower.endsWith(".mpp")
                    || lower.endsWith(".json")
                    || (lower.endsWith(".xml") && depth <= 2 && name.equals("FlutterSharedPreferences.xml"));
            if (!wanted) continue;
            if (child.length() == 0 || child.length() > MAX_FILE_BYTES) continue;

            discovered.add(child.getAbsolutePath());
            JSONObject entry = new JSONObject();
            entry.put("path", child.getAbsolutePath());
            entry.put("name", name);
            entry.put("sizeBytes", child.length());
            entry.put("modifiedAt", child.lastModified());
            entry.put("kind", kindOf(lower));
            files.put(entry);
        }
    }

    private static String kindOf(String lower) {
        if (lower.endsWith(".mpp")) return "bundle";
        if (lower.contains("shared_preferences")) return "preferences";
        if (lower.endsWith(".xml")) return "preferences";
        return "json";
    }

    private boolean isProbablyRooted() {
        for (String path : new String[] { "/system/xbin/su", "/system/bin/su", "/sbin/su", "/data/adb/magisk" }) {
            if (new File(path).exists()) return true;
        }
        return false;
    }

    private static JSONArray notes(int installed, int files, int unreadable) throws JSONException {
        JSONArray notes = new JSONArray();
        if (installed == 0) {
            notes.put("Morphe Manager is not installed on this device.");
        } else if (files == 0) {
            notes.put("Morphe is installed, but Android keeps its source list private to it.");
            notes.put("Paste the sources from Morphe's patch-source screen once — PatchPilot remembers them.");
        } else {
            notes.put("Found " + files + " file(s) Morphe left where other apps can reach them.");
        }
        if (unreadable > 0 && files > 0) {
            notes.put("Some folders were closed to PatchPilot; the readable ones were enough.");
        }
        return notes;
    }

    private static byte[] bytesOf(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }
}
