package app.patchpilot;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * Where verified APKs end up: `Downloads/PatchPilot` on the phone's shared
 * storage, so Morphe Manager's "Select an APK" picker can see them.
 *
 * Android 10 and later go through MediaStore (no storage permission needed for
 * files the app itself creates); older versions write to the public Downloads
 * folder directly.
 */
public class LibraryStore {

    private static final String FOLDER = "PatchPilot";

    private final Context context;

    LibraryStore(Context context) {
        this.context = context;
    }

    /* --------------------------------------------------------------- publish --- */

    JSONObject publish(String sourcePath, String requestedName) throws IOException, JSONException {
        File source = new File(sourcePath);
        if (!source.exists()) throw new IOException("The download disappeared before it could be saved");

        String name = uniqueName(sanitize(requestedName));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            JSONObject entry = publishToMediaStore(source, name);
            //noinspection ResultOfMethodCallIgnored
            source.delete();
            return entry;
        }

        File folder = publicFolder();
        if (!folder.exists() && !folder.mkdirs()) throw new IOException("Cannot create " + folder.getAbsolutePath());
        File target = new File(folder, name);
        copy(source, target);
        //noinspection ResultOfMethodCallIgnored
        source.delete();
        return describe(target.getAbsolutePath(), target);
    }

    private JSONObject publishToMediaStore(File source, String name) throws IOException, JSONException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType(name));
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IOException("Android refused to create the file in Downloads");

        try {
            try (InputStream input = new FileInputStream(source);
                 OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) throw new IOException("Android refused to open the new file");
                copy(input, output);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        } catch (IOException error) {
            resolver.delete(uri, null, null);
            throw error;
        }

        JSONObject entry = new JSONObject();
        entry.put("name", name);
        entry.put("handle", uri.toString());
        entry.put("sizeBytes", source.length());
        entry.put("modifiedAt", now());
        return entry;
    }

    /* ------------------------------------------------------------------ list --- */

    JSONArray list() throws JSONException {
        JSONArray entries = new JSONArray();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            String selection = MediaStore.Downloads.RELATIVE_PATH + " LIKE ? AND " + MediaStore.Downloads.IS_PENDING + " = 0";
            String[] args = { Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "%" };
            try (Cursor cursor = resolver.query(
                    collection,
                    new String[] {
                            MediaStore.Downloads._ID,
                            MediaStore.Downloads.DISPLAY_NAME,
                            MediaStore.Downloads.SIZE,
                            MediaStore.Downloads.DATE_MODIFIED,
                    },
                    selection,
                    args,
                    MediaStore.Downloads.DATE_MODIFIED + " DESC")) {
                if (cursor == null) return entries;
                while (cursor.moveToNext()) {
                    long id = cursor.getLong(0);
                    JSONObject entry = new JSONObject();
                    entry.put("name", cursor.getString(1));
                    entry.put("handle", android.content.ContentUris.withAppendedId(collection, id).toString());
                    entry.put("sizeBytes", cursor.getLong(2));
                    entry.put("modifiedAt", iso(cursor.getLong(3) * 1000L));
                    entries.put(entry);
                }
            }
        } else {
            File folder = publicFolder();
            File[] files = folder.listFiles();
            if (files == null) return entries;
            for (File file : files) {
                if (!file.isFile()) continue;
                entries.put(describe(file.getAbsolutePath(), file));
            }
        }
        return entries;
    }

    /* ---------------------------------------------------------------- delete --- */

    boolean delete(String handle) {
        if (handle == null || handle.isEmpty()) return false;
        try {
            if (handle.startsWith("content://")) {
                return context.getContentResolver().delete(Uri.parse(handle), null, null) > 0;
            }
            return new File(handle).delete();
        } catch (RuntimeException error) {
            return false;
        }
    }

    /* -------------------------------------------------------------- plumbing --- */

    private JSONObject describe(String handle, File file) throws JSONException {
        JSONObject entry = new JSONObject();
        entry.put("name", file.getName());
        entry.put("handle", handle);
        entry.put("sizeBytes", file.length());
        entry.put("modifiedAt", iso(file.lastModified()));
        return entry;
    }

    File publicFolder() {
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER);
    }

    /** MediaStore renames silently on conflict; PatchPilot would rather know. */
    private String uniqueName(String name) {
        Set<String> taken = new HashSet<>();
        JSONArray existing;
        try {
            existing = list();
        } catch (JSONException error) {
            return name;
        }
        for (int index = 0; index < existing.length(); index++) {
            taken.add(existing.optJSONObject(index) == null ? "" : existing.optJSONObject(index).optString("name"));
        }
        if (!taken.contains(name)) return name;

        String base = name;
        String extension = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            extension = name.substring(dot);
        }
        for (int counter = 2; counter < 1000; counter++) {
            String candidate = base + "-" + counter + extension;
            if (!taken.contains(candidate)) return candidate;
        }
        return name;
    }

    private static void copy(File source, File target) throws IOException {
        File folder = target.getParentFile();
        if (folder != null && !folder.exists() && !folder.mkdirs()) throw new IOException("Cannot create " + folder);
        try (InputStream input = new FileInputStream(source); OutputStream output = new FileOutputStream(target)) {
            copy(input, output);
        }
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        output.flush();
    }

    private static String mimeType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
        if (lower.endsWith(".apkm") || lower.endsWith(".xapk") || lower.endsWith(".apks")) {
            return "application/octet-stream";
        }
        return "application/octet-stream";
    }

    private static String sanitize(String value) {
        if (value == null) return "download.apk";
        String cleaned = value.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
        if (cleaned.length() > 96) cleaned = cleaned.substring(cleaned.length() - 96);
        return cleaned.isEmpty() ? "download.apk" : cleaned;
    }

    private static String now() {
        return iso(System.currentTimeMillis());
    }

    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    /** Only used by tests/documentation; keeps the compiler honest about imports. */
    static List<String> handles(JSONArray entries) {
        List<String> values = new ArrayList<>();
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry != null) values.add(entry.optString("handle"));
        }
        return values;
    }
}
