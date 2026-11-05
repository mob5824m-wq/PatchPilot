package app.patchpilot;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * A tiny persistent key-value store, one file per key in the app's private
 * directory.
 *
 * Patch lists are a megabyte or two, which is more than SharedPreferences wants
 * to hold, and the library index grows with use — plain files are the right size
 * of hammer.
 */
public class KeyValueStore {

    private final File folder;

    KeyValueStore(Context context) {
        this.folder = new File(context.getFilesDir(), "store");
        if (!folder.exists()) //noinspection ResultOfMethodCallIgnored
            folder.mkdirs();
    }

    String get(String key) {
        File file = fileFor(key);
        if (!file.exists()) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int read;
            while ((read = input.read(chunk)) != -1) buffer.write(chunk, 0, read);
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException error) {
            return null;
        }
    }

    void set(String key, String value) throws IOException {
        File file = fileFor(key);
        File temporary = new File(folder, file.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        if (!temporary.renameTo(file)) throw new IOException("Could not save " + key);
    }

    private File fileFor(String key) {
        String safe = key == null ? "null" : key.replaceAll("[^A-Za-z0-9._-]+", "_");
        return new File(folder, safe + ".json");
    }
}
