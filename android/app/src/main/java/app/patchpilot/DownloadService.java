package app.patchpilot;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

/**
 * Keeps a download alive when the app is not on screen.
 *
 * A 90 MB APK over a slow mobile connection easily outlives the time a user
 * spends looking at the app; without a foreground service Android is free to
 * freeze the process and the job dies half way. The service owns a single
 * notification that doubles as the user's progress indicator.
 *
 * Started and stopped by {@link NativeShell} around every download, so it lives
 * exactly as long as there is network work to protect.
 */
public class DownloadService extends Service {

    static final String EXTRA_TITLE = "title";
    private static final String CHANNEL_ID = "patchpilot-downloads";
    private static final int NOTIFICATION_ID = 4211;

    private static DownloadService running;

    private String title = "Downloading APK";

    static void start(Context context, String name) {
        Intent intent = new Intent(context, DownloadService.class);
        intent.putExtra(EXTRA_TITLE, name == null || name.isEmpty() ? "Downloading APK" : name);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void progress(JSONObject event) {
        DownloadService service = running;
        if (service == null || event == null) return;
        service.update(event.optLong("bytesReceived", 0), event.optLong("bytesTotal", -1));
    }

    static void stop(Context context) {
        try {
            context.stopService(new Intent(context, DownloadService.class));
        } catch (RuntimeException ignored) {
            // Already gone.
        }
        running = null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String extra = intent.getStringExtra(EXTRA_TITLE);
            if (extra != null && !extra.isEmpty()) title = extra;
        }
        startForeground(NOTIFICATION_ID, build(null, -1));
        // Not sticky: if the process dies, the job is gone and a stale
        // notification would only be confusing.
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            //noinspection deprecation
            stopForeground(true);
        }
        super.onDestroy();
    }

    private void update(long received, long total) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, build(received, total));
        } catch (RuntimeException ignored) {
            // A missing notification must never break the download itself.
        }
    }

    private Notification build(Long received, long total) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        long bytes = received == null ? 0 : received;
        String detail = bytes > 0
                ? String.format(java.util.Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
                : "Starting…";

        builder.setContentTitle(title)
                .setContentText(detail)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        if (received != null && total > 0) {
            builder.setProgress(100, (int) Math.min(100, Math.round(bytes * 100.0 / total)), false);
        }
        return builder.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "APK downloads",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Progress of APK downloads that keep running in the background");
        manager.createNotificationChannel(channel);
    }
}
