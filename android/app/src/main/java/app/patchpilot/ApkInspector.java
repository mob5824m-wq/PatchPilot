package app.patchpilot;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * What is actually inside a downloaded file, according to Android itself.
 *
 * The desktop build decodes the binary manifest and the APK Signing Block by
 * hand. On a phone the platform already does both — and does it better than any
 * parser here could — so this class asks PackageManager and returns the same
 * fields. The comparison against the patch bundle then runs in shared
 * TypeScript (`src/shared/verifyMeta.ts`), which is why a build that fails
 * verification on a desktop fails here for the same reason.
 */
public class ApkInspector {

    private final Context context;
    private final File cacheDir;

    ApkInspector(Context context) {
        this.context = context;
        this.cacheDir = context.getCacheDir();
    }

    JSONObject inspect(String path) throws IOException, JSONException {
        File file = new File(path);
        if (!file.exists()) throw new IOException("That file is gone: " + path);

        String lower = file.getName().toLowerCase(Locale.ROOT);
        boolean split = !lower.endsWith(".apk");
        long size = file.length();

        File target = file;
        File extracted = null;
        try {
            if (split) {
                extracted = extractBaseApk(file);
                target = extracted;
            }
            JSONObject result = describe(target);
            result.put("sizeBytes", size);
            result.put("isSplit", split);
            return result;
        } finally {
            if (extracted != null) //noinspection ResultOfMethodCallIgnored
                extracted.delete();
        }
    }

    JSONObject inspectBytes(String name, String base64) throws IOException, JSONException {
        byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
        String safe = name == null || name.isEmpty() ? "upload.apk" : name.replaceAll("[^A-Za-z0-9._-]+", "-");
        File temporary = new File(cacheDir, "inspect-" + System.nanoTime() + "-" + safe);
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
        }

        try {
            JSONObject result = inspect(temporary.getAbsolutePath());
            result.put("tempPath", temporary.getAbsolutePath());
            return result;
        } catch (IOException | JSONException error) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            throw error;
        }
    }

    private JSONObject describe(File apk) throws IOException, JSONException {
        PackageManager manager = context.getPackageManager();
        PackageInfo info = readPackage(manager, apk.getAbsolutePath());
        if (info == null) {
            throw new IOException(
                    "Android could not read that archive. It is not an APK, or the download is incomplete.");
        }

        JSONObject result = new JSONObject();
        result.put("packageName", info.packageName == null ? JSONObject.NULL : info.packageName);
        result.put("versionName", info.versionName == null ? JSONObject.NULL : info.versionName);

        long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : (info.versionCode & 0xffffffffL);
        // JSON has no integer/long distinction that survives the bridge, and the
        // bundle's version codes are ints, so a plain long is right here.
        result.put("versionCode", versionCode);

        result.put("signerSha256", digests(info));
        result.put("signingSchemes", new JSONArray());
        result.put("minSdk", JSONObject.NULL);
        result.put("targetSdk",
                info.applicationInfo == null ? JSONObject.NULL : info.applicationInfo.targetSdkVersion);
        return result;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo readPackage(PackageManager manager, String path) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return manager.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(
                    PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_META_DATA));
        }
        return manager.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_META_DATA);
    }

    /** SHA-256 of each signing certificate, lower-case hex — the same digest the bundles pin. */
    @SuppressWarnings("deprecation")
    private static JSONArray digests(PackageInfo info) throws JSONException {
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signing = info.signingInfo;
            if (signing != null) signatures = signing.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }

        JSONArray digests = new JSONArray();
        if (signatures == null) return digests;

        for (Signature signature : signatures) {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] hash = digest.digest(signature.toByteArray());
                StringBuilder hex = new StringBuilder(hash.length * 2);
                for (byte value : hash) hex.append(String.format(Locale.ROOT, "%02x", value));
                digests.put(hex.toString());
            } catch (NoSuchAlgorithmException ignored) {
                // SHA-256 always exists on Android.
            }
        }
        return digests;
    }

    /**
     * Split bundles (.apkm/.xapk/.apks) are ordinary zips. PackageManager reads
     * APKs, not containers, so the base APK is copied out first — exactly what
     * the desktop reader does.
     */
    private File extractBaseApk(File bundle) throws IOException {
        File base = null;
        try (ZipInputStream zip = new ZipInputStream(new java.io.BufferedInputStream(new java.io.FileInputStream(bundle)))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName().toLowerCase(Locale.ROOT);
                boolean isApk = name.endsWith(".apk");
                boolean isBase = name.equals("base.apk") || name.endsWith("/base.apk");
                if (!isApk) continue;
                if (base == null || isBase) {
                    if (base != null) //noinspection ResultOfMethodCallIgnored
                        base.delete();
                    base = copyEntry(zip, name);
                    if (isBase) break;
                }
            }
        }
        if (base == null) throw new IOException("That bundle has no APK inside it");
        return base;
    }

    private File copyEntry(InputStream stream, String name) throws IOException {
        String suffix = name.endsWith(".apk") ? ".apk" : ".bin";
        File target = new File(cacheDir, "bundle-" + System.nanoTime() + suffix);
        long copied = 0;
        try (FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                copied += read;
                if (copied > 2L * 1024 * 1024 * 1024) throw new IOException("That bundle is unreasonably large");
            }
        } catch (IOException error) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            throw error;
        }
        return target;
    }

    /** Kept for callers that want the certificate list as strings. */
    static List<String> asStrings(JSONArray array) {
        List<String> values = new ArrayList<>();
        for (int index = 0; index < array.length(); index++) values.add(array.optString(index));
        return values;
    }
}
