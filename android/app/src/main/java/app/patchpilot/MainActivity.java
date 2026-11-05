package app.patchpilot;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * PatchPilot for Android is a thin client: the real work (finding the APK a
 * Morphe bundle wants, downloading and verifying it) happens in the PatchPilot
 * server on your computer, and this app gives you that UI on the phone so the
 * verified file can be saved straight into Downloads where Morphe Manager can
 * pick it up.
 *
 * Deliberately free of AndroidX and of any generated layout: one activity, the
 * framework WebView, and the system DownloadManager. Fewer moving parts means
 * fewer ways for the release build to break.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "patchpilot";
    private static final String KEY_SERVER = "server";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_STORAGE = 1002;

    private SharedPreferences preferences;
    private WebView webView;
    private TextView addressLabel;
    private TextView statusBar;

    /** Non-null while a JS file picker is waiting for its result. */
    private ValueCallback<Uri[]> filePathCallback;

    /** A download that is queued behind the storage permission prompt. */
    private String pendingDownloadUrl;
    private String pendingDownloadUserAgent;
    private String pendingDownloadContentDisposition;
    private String pendingDownloadMimeType;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        configureWebView(webView);

        setContentView(buildLayout());

        String saved = preferences.getString(KEY_SERVER, null);
        if (saved == null) {
            webView.loadData(emptyState(), "text/html", "utf-8");
            askForServer(true);
        } else {
            loadServer(saved);
        }
    }

    /* ------------------------------------------------------------- web view --- */

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        CookieManager.getInstance().setAcceptCookie(true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return openUrl(webView, request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView webView, String url) {
                return openUrl(webView, Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView webView, String url) {
                statusBar.setVisibility(View.GONE);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView webView, int errorCode, String description, String failingUrl) {
                showOffline();
            }

            @Override
            public void onReceivedError(WebView webView, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                // "Verify a file" and bundle upload are plain <input type="file">,
                // so the picker has to work for those screens to be usable.
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

        view.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(
                    String url,
                    String userAgent,
                    String contentDisposition,
                    String mimeType,
                    long contentLength) {
                enqueueDownload(url, userAgent, contentDisposition, mimeType);
            }
        });
    }

    /** Keeps the PatchPilot server inside the WebView and sends everything else out. */
    private boolean openUrl(WebView view, Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        if (!scheme.equals("http") && !scheme.equals("https")) {
            openExternally(uri);
            return true;
        }
        String server = preferences.getString(KEY_SERVER, null);
        if (server != null && sameHost(server, uri)) return false;
        openExternally(uri);
        return true;
    }

    private static boolean sameHost(String server, Uri uri) {
        try {
            Uri base = Uri.parse(server);
            return base.getHost() != null && base.getHost().equalsIgnoreCase(uri.getHost());
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            Toast.makeText(this, R.string.open_external, Toast.LENGTH_SHORT).show();
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    /* -------------------------------------------------------------- downloads --- */

    private void enqueueDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null || url.isEmpty()) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url;
            pendingDownloadUserAgent = userAgent;
            pendingDownloadContentDisposition = contentDisposition;
            pendingDownloadMimeType = mimeType;
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQUEST_STORAGE);
            return;
        }
        startDownload(url, userAgent, contentDisposition, mimeType);
    }

    private void startDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            request.setTitle(fileName);
            request.setMimeType(mimeType != null ? mimeType : "application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Downloads/PatchPilot keeps the library separate from the rest of the
            // phone's downloads, so "Select an APK" in Morphe Manager has one
            // obvious folder to look in.
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "PatchPilot/" + fileName);

            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("no DownloadManager");
            manager.enqueue(request);
            Toast.makeText(this, getString(R.string.download_started, fileName), Toast.LENGTH_LONG).show();
        } catch (RuntimeException error) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_STORAGE) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED && pendingDownloadUrl != null) {
            startDownload(pendingDownloadUrl, pendingDownloadUserAgent, pendingDownloadContentDisposition, pendingDownloadMimeType);
        } else {
            Toast.makeText(this, R.string.permission_needed, Toast.LENGTH_LONG).show();
        }
        pendingDownloadUrl = null;
        pendingDownloadUserAgent = null;
        pendingDownloadContentDisposition = null;
        pendingDownloadMimeType = null;
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

    /* ------------------------------------------------------------------- ui --- */

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#111827"));
        int padding = Math.round(12 * getResources().getDisplayMetrics().density);
        bar.setPadding(padding, padding, padding, padding);

        addressLabel = new TextView(this);
        addressLabel.setTextColor(Color.parseColor("#e5e7eb"));
        addressLabel.setTextSize(13);
        addressLabel.setSingleLine(true);
        addressLabel.setPadding(0, 0, padding, 0);
        addressLabel.setOnClickListener(v -> askForServer(false));
        addressLabel.setText(getString(R.string.server_title));
        bar.addView(addressLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button reload = new Button(this);
        reload.setText(R.string.reload);
        reload.setAllCaps(false);
        reload.setOnClickListener(v -> {
            String server = preferences.getString(KEY_SERVER, null);
            if (server == null) askForServer(true);
            else loadServer(server);
        });
        bar.addView(reload);

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        statusBar = new TextView(this);
        statusBar.setBackgroundColor(Color.parseColor("#7f1d1d"));
        statusBar.setTextColor(Color.WHITE);
        statusBar.setTextSize(13);
        statusBar.setPadding(padding, padding, padding, padding);
        statusBar.setVisibility(View.GONE);
        root.addView(statusBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    private void showOffline() {
        String server = preferences.getString(KEY_SERVER, "");
        statusBar.setText(getString(R.string.offline, server));
        statusBar.setVisibility(View.VISIBLE);
    }

    private String emptyState() {
        return "<!doctype html><html><body style=\"margin:0;font:16px -apple-system,system-ui,sans-serif;"
                + "background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh\">"
                + "<div style=\"max-width:26em;padding:24px;text-align:center\">"
                + "<h1 style=\"font-size:22px;margin:0 0 8px\">PatchPilot</h1>"
                + "<p style=\"color:#475569;line-height:1.5\">Tap the address bar above to connect to the "
                + "PatchPilot server running on your computer.</p></div></body></html>";
    }

    /**
     * The server address is the only setting this app has, so it is asked for
     * once and then lives in the top bar, ready to be tapped again when the
     * machine moves to a different address.
     */
    private void askForServer(boolean firstRun) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint(R.string.server_hint);
        String current = preferences.getString(KEY_SERVER, "");
        input.setText(current);
        input.setSelection(input.getText().length());
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(R.string.server_title)
                .setMessage(R.string.server_message)
                .setView(input)
                .setPositiveButton(R.string.server_save, (dialog, which) -> {
                    String normalized = normalize(input.getText().toString());
                    if (normalized == null) {
                        Toast.makeText(this, R.string.server_invalid, Toast.LENGTH_LONG).show();
                        askForServer(firstRun);
                        return;
                    }
                    preferences.edit().putString(KEY_SERVER, normalized).apply();
                    loadServer(normalized);
                });

        if (!firstRun) builder.setNegativeButton(R.string.server_cancel, null);
        builder.setCancelable(!firstRun).show();
    }

    /** Accepts "192.168.1.20:3000", "http://box.local:3000/" or a full URL. */
    private static String normalize(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        Uri uri = Uri.parse(value);
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        return value;
    }

    private void loadServer(String server) {
        addressLabel.setText(server);
        addressLabel.setTextColor(Color.parseColor("#e5e7eb"));
        statusBar.setVisibility(View.GONE);
        webView.loadUrl(server + "/");
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
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
