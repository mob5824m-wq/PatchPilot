package app.patchpilot;

import android.content.Intent;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns a launch into "show this app, on this tab".
 *
 * Two things open PatchPilot without the icon: a shared Play Store link (or a
 * `market://` link from a browser) and the launcher shortcuts. Both arrive as
 * intents, and both are worth reading carefully — a share sheet full of prose
 * should not send the app to a package name that happens to contain a dot.
 */
public final class LaunchTarget {

    private static final Pattern PACKAGE = Pattern.compile("(?:\\bid=|/details\\?id=)([A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+)");
    private static final Pattern BARE_PACKAGE = Pattern.compile("\\b([a-z][a-z0-9_]*(?:\\.[a-z0-9_]+){2,})\\b");
    private static final String SCHEME = "patchpilot";

    private LaunchTarget() {}

    /** The page waits for this; null means "just start where you always start". */
    public static JSONObject from(Intent intent) {
        if (intent == null) return null;

        String action = intent.getAction();
        Uri data = intent.getData();

        if (Intent.ACTION_VIEW.equals(action) && data != null && SCHEME.equals(data.getScheme())) {
            return tabTarget(data);
        }

        if (Intent.ACTION_VIEW.equals(action) && data != null) {
            String packageName = packageFrom(data.toString());
            if (packageName != null) return packageTarget(packageName);
        }

        if (Intent.ACTION_SEND.equals(action)) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text == null) text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String packageName = packageFrom(text == null ? "" : text);
            if (packageName != null) return packageTarget(packageName);
        }

        return null;
    }

    private static JSONObject tabTarget(Uri data) {
        JSONObject target = new JSONObject();
        try {
            String host = data.getHost();
            String path = data.getPath() == null ? "" : data.getPath().replaceFirst("^/+", "");
            String tab = host != null && !host.isEmpty() ? host : path;
            if (tab != null && !tab.isEmpty()) target.put("tab", tab);
            String packageName = data.getQueryParameter("package");
            if (packageName != null) target.put("packageName", packageName);
        } catch (JSONException ignored) {
            // Fixed keys.
        }
        return target;
    }

    private static JSONObject packageTarget(String packageName) {
        JSONObject target = new JSONObject();
        try {
            target.put("packageName", packageName);
            target.put("tab", "apps");
        } catch (JSONException ignored) {
            // Fixed keys.
        }
        return target;
    }

    /**
     * `market://details?id=com.x.y`, a Play Store URL, or a sentence with a
     * package name in it. Anything else returns null rather than a guess.
     */
    public static String packageFrom(String text) {
        if (text == null || text.isEmpty()) return null;

        Matcher explicit = PACKAGE.matcher(text);
        if (explicit.find()) return explicit.group(1);

        // A shared sentence: only trust a dotted token that really looks like an
        // application id (three or more segments), never a URL or a filename.
        Matcher bare = BARE_PACKAGE.matcher(text);
        while (bare.find()) {
            String candidate = bare.group(1);
            if (candidate.contains("/") || candidate.endsWith(".apk") || candidate.endsWith(".json")) continue;
            if (candidate.split("\\.").length < 3) continue;
            return candidate;
        }
        return null;
    }
}
