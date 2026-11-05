package app.patchpilot;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The phone's sockets.
 *
 * PatchPilot's scrapers were written against `fetch`, so this class has to
 * behave like a small, literal HTTP client: real redirect control (some mirrors
 * must be asked for a `Location` instead of followed), a shared cookie jar
 * (APKMirror hands out a session cookie before it will serve a download link),
 * no transparent gzip, and a per-request timeout long enough for a slow mirror
 * but short enough that a dead host does not hang a job.
 */
public class HttpBridge {

    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 45_000;
    private static final int BUFFER = 64 * 1024;

    private final File cacheDir;

    HttpBridge(Context context) {
        this.cacheDir = context.getCacheDir();
        if (CookieHandler.getDefault() == null) {
            CookieHandler.setDefault(new CookieManager());
        }
    }

    /* --------------------------------------------------------------- request --- */

    JSONObject request(JSONObject payload) throws IOException, JSONException {
        String url = payload.getString("url");
        String method = payload.optString("method", "GET").toUpperCase(Locale.ROOT);
        boolean follow = payload.optBoolean("followRedirects", true);
        byte[] body = decode(payload.optString("bodyBase64", ""));

        HttpURLConnection connection = open(url, method, follow, payload.optJSONObject("headers"), body);
        try {
            int status = connection.getResponseCode();
            Map<String, List<String>> fields = connection.getHeaderFields();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] bytes = readAll(stream);

            JSONObject headers = new JSONObject();
            if (fields != null) {
                for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
                    if (entry.getKey() == null) continue;
                    JSONArray values = new JSONArray();
                    for (String value : entry.getValue()) values.put(value);
                    headers.put(entry.getKey().toLowerCase(Locale.ROOT), values);
                }
            }

            JSONObject result = new JSONObject();
            result.put("status", status);
            result.put("headers", headers);
            result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            return result;
        } finally {
            connection.disconnect();
        }
    }

    /* -------------------------------------------------------------- download --- */

    JSONObject download(JSONObject payload, NativeShell.ProgressSink progress) throws IOException, JSONException {
        String url = payload.getString("url");
        String label = payload.optString("fileName", "");
        HttpURLConnection connection = open(url, "GET", true, payload.optJSONObject("headers"), null);
        try {
            int status = connection.getResponseCode();
            if (status >= 400) throw new IOException("Download failed with HTTP " + status);

            long total = connection.getContentLengthLong();
            String name = fileName(url, connection.getHeaderField("Content-Disposition"), label);

            File target = new File(cacheDir, "patchpilot-" + System.nanoTime() + "-" + name);
            FileOutputStream output = new FileOutputStream(target);
            long received = 0;
            long lastReport = 0;
            try (InputStream stream = connection.getInputStream()) {
                byte[] buffer = new byte[BUFFER];
                int read;
                while ((read = stream.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    received += read;
                    if (progress != null && System.currentTimeMillis() - lastReport > 250) {
                        lastReport = System.currentTimeMillis();
                        progress.onProgress(progressEvent(received, total));
                    }
                }
            } finally {
                output.close();
            }

            if (progress != null) progress.onProgress(progressEvent(received, total));

            JSONObject result = new JSONObject();
            result.put("path", target.getAbsolutePath());
            result.put("name", name);
            result.put("sizeBytes", received);
            return result;
        } finally {
            connection.disconnect();
        }
    }

    private static JSONObject progressEvent(long received, long total) {
        JSONObject event = new JSONObject();
        try {
            event.put("bytesReceived", received);
            event.put("bytesTotal", total > 0 ? total : JSONObject.NULL);
        } catch (JSONException ignored) {
            // Fixed keys.
        }
        return event;
    }

    /* --------------------------------------------------------------- plumbing --- */

    private HttpURLConnection open(
            String url,
            String method,
            boolean follow,
            JSONObject headers,
            byte[] body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setInstanceFollowRedirects(follow);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        // HttpURLConnection does not inflate, and mirrors are happy to send gzip.
        connection.setRequestProperty("Accept-Encoding", "identity");

        if (headers != null) {
            java.util.Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.optString(key, "");
                if (key == null || value.isEmpty()) continue;
                try {
                    connection.setRequestProperty(key, value);
                } catch (RuntimeException ignored) {
                    // Some headers are managed by the platform; skipping is fine.
                }
            }
        }

        if (body != null) {
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream stream = connection.getOutputStream()) {
                stream.write(body);
            }
        }

        return connection;
    }

    private static byte[] readAll(InputStream stream) throws IOException {
        if (stream == null) return new byte[0];
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[BUFFER];
        int read;
        try {
            while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
        } finally {
            stream.close();
        }
        return buffer.toByteArray();
    }

    private static byte[] decode(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        return Base64.decode(base64, Base64.NO_WRAP);
    }

    /**
     * The download's real name, preferring what the server said over what the
     * job log calls the link — the library names files after this.
     */
    static String fileName(String url, String contentDisposition, String label) {
        String fromDisposition = match(contentDisposition, "filename\\*=UTF-8''([^;]+)");
        if (fromDisposition == null) fromDisposition = match(contentDisposition, "filename=\"?([^\";]+)\"?");
        if (fromDisposition != null) return sanitize(fromDisposition);

        try {
            String path = new URL(url).getPath();
            String base = path.substring(path.lastIndexOf('/') + 1);
            if (base.matches("(?i).+\\.(apk|apkm|xapk|apks|zip)$")) return sanitize(base);
        } catch (IOException ignored) {
            // Fall through to the label.
        }

        String cleaned = sanitize(label);
        if (!cleaned.matches("(?i).+\\.(apk|apkm|xapk|apks|zip)$")) cleaned = cleaned + ".apk";
        return cleaned;
    }

    private static String match(String haystack, String pattern) {
        if (haystack == null) return null;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(haystack);
        if (!matcher.find()) return null;
        String value = matcher.group(1);
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (IOException | RuntimeException error) {
            return value;
        }
    }

    private static String sanitize(String value) {
        if (value == null) return "";
        String cleaned = value.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
        if (cleaned.length() > 80) cleaned = cleaned.substring(0, 80);
        return cleaned.isEmpty() ? "download.apk" : cleaned;
    }
}
