package app.patchpilot;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;

/**
 * PatchPilot on Android, with no server anywhere.
 *
 * The React UI in `src/web` is bundled into the APK and served from a synthetic
 * origin (`https://patchpilot.local/`) that this activity answers from assets.
 * The UI calls `/api/...` exactly as it does against the Node server; inside the
 * app those calls are intercepted by `src/app/install.ts` and answered in the
 * page. Everything Android alone can do — sockets, files, PackageManager — is
 * exposed to that page as one JavaScript interface, {@link NativeShell}.
 */
public class MainActivity extends Activity {

    /** The origin the bundled UI is served from. Not a real host. */
    static final String ORIGIN_HOST = "patchpilot.local";
    private static final String ORIGIN = "https://" + ORIGIN_HOST;

    private static final int REQUEST_FILE_CHOOSER = 1001;

    private WebView webView;
    private NativeShell shell;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        configure(webView);

        shell = new NativeShell(this, webView);
        webView.addJavascriptInterface(shell, "PatchPilotNative");

        setContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView.loadUrl(ORIGIN + "/index.html");

        // Before Android 10 the library writes to the public Downloads folder,
        // which needs the legacy storage permission.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, 1002);
        }
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null || !ORIGIN_HOST.equals(uri.getHost())) return null;
                return serveAsset(uri.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                if (ORIGIN_HOST.equals(uri.getHost())) return false;
                openExternally(uri);
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView ignored, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // "Verify a file" and bundle upload are plain <input type="file">.
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException error) {
                    filePathCallback = null;
                    return false;
                }
            }
        });
    }

    /**
     * Serves `assets/web/*`. Called on a background thread, so it opens its own
     * streams and never touches the UI.
     */
    private WebResourceResponse serveAsset(String path) {
        String cleaned = path == null ? "" : path.replaceFirst("^/+", "");
        if (cleaned.isEmpty()) cleaned = "index.html";

        InputStream stream = openAsset(cleaned);
        if (stream == null) {
            // Single-page app: unknown paths are routes, not files.
            stream = openAsset("index.html");
            cleaned = "index.html";
        }
        if (stream == null) return null;

        WebResourceResponse response = new WebResourceResponse(mimeType(cleaned), "utf-8", stream);
        if (!cleaned.equals("index.html")) {
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("cache-control", "public, max-age=31536000, immutable");
            response.setResponseHeaders(headers);
        }
        return response;
    }

    private InputStream openAsset(String name) {
        try {
            return getAssets().open("web/" + name);
        } catch (IOException error) {
            return null;
        }
    }

    private static String mimeType(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (shell != null) shell.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("PatchPilotNative");
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
