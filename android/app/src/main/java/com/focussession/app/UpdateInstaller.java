package com.focussession.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 自动更新里「不用人点」的那一半：把已经下好的升级包交给 PackageInstaller，并记住系统怎么答的。
 *
 * 手按「下载并安装」走的仍然是 MainActivity.installUpdate（ACTION_VIEW 调起系统安装器）——那条路
 * 在各家系统上试过，包括 Android 11 授权时把我们 force-stop 掉的那一出，不去动它。这里是另一条路：
 * Android 12 起，一个应用**更新它自己**、声明了 UPDATE_PACKAGES_WITHOUT_USER_ACTION、又被允许
 * 「安装未知应用」时，系统可以不弹确认框直接装。能不能成由系统说了算，所以整条路按「试一次」设计：
 *
 * - 系统说要人确认（STATUS_PENDING_USER_ACTION）：这一次作罢，把会话丢掉，记下「这个装着的版本上静默不成」，
 *   之后页面改给一条「已下载，点一下安装」的横幅，走手按那条路。不能在后台硬把确认框弹出来——
 *   Android 10 起后台起不了 Activity，而且人此刻根本不在这个 App 里。
 * - 装失败：记下原因给设置页看，把包删掉，免得明天再拿同一个坏包试一遍。
 *
 * 装的是什么不用担心被换掉：覆盖安装时系统会核对签名，和装着的这个对不上的包装不上去。
 */
final class UpdateInstaller {

    private static final String PREFS = "update";
    /** 系统拒绝静默安装时，当时装着的 versionCode。换了版本之后值得再试一次。 */
    private static final String KEY_REFUSED_AT = "silentRefusedAt";
    private static final String KEY_FAILURE = "failure";
    static final String EXTRA_VERSION = "com.focussession.app.UPDATE_VERSION";

    private UpdateInstaller() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static long currentVersionCode(Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return Long.MAX_VALUE; // 问不到就当什么都不比它新，宁可不装
        }
    }

    /**
     * 缓存目录里是不是躺着一个**完整的、比装着的新的、我们自己的**升级包；是的话返回它的版本号，否则空串。
     *
     * 不另记「下完了没有」的标记，直接让系统去解析这个文件：下到一半的包解析不出来，
     * 别人的包包名对不上，旧包 versionCode 不够大——三种都在这一步被筛掉。
     */
    static String readyVersion(Context ctx) {
        try {
            File apk = NativeBridge.updateApk(ctx);
            if (!apk.isFile()) return "";
            PackageInfo info = ctx.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            if (info == null || !ctx.getPackageName().equals(info.packageName) || info.versionName == null) return "";
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            return code > currentVersionCode(ctx) ? info.versionName : "";
        } catch (Exception e) {
            return "";
        }
    }

    /** 这台设备、这个装着的版本上，静默安装值不值得试。 */
    static boolean canSilent(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return false;
        if (!ctx.getPackageManager().canRequestPackageInstalls()) return false;
        return prefs(ctx).getLong(KEY_REFUSED_AT, -1) != currentVersionCode(ctx);
    }

    /**
     * 把包写进一个安装会话并提交。要在后台线程调：几兆的文件要拷一遍。
     * 提交之后就是系统的事了——装成的那一刻我们这个进程会被杀掉，结果由 UpdateReceiver 在新进程里收。
     */
    static void commitSilently(Context ctx, File apk, String version) {
        if (Build.VERSION.SDK_INT < 31) return;
        Context app = ctx.getApplicationContext();
        PackageInstaller installer = app.getPackageManager().getPackageInstaller();
        int id = -1;
        try {
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(app.getPackageName());
            params.setSize(apk.length());
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("update", 0, apk.length())) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
                Intent result = new Intent(app, UpdateReceiver.class).putExtra(EXTRA_VERSION, version);
                // 系统要往这个 Intent 里填结果，所以得是 MUTABLE；Intent 是显式的，填不到别人手里去
                PendingIntent callback = PendingIntent.getBroadcast(app, id, result,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                session.commit(callback.getIntentSender());
            }
        } catch (Exception e) {
            if (id >= 0) {
                try { installer.abandonSession(id); } catch (Exception ignored) { /* 会话可能根本没建成 */ }
            }
            recordFailure(app, version, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), false);
        }
    }

    /** 系统说这次得有人点确认：静默这条路在这个版本上不通，以后别试了。包留着，给手按那条路用。 */
    static void recordRefused(Context ctx) {
        prefs(ctx).edit().putLong(KEY_REFUSED_AT, currentVersionCode(ctx)).apply();
    }

    static void recordFailure(Context ctx, String version, String message, boolean dropApk) {
        try {
            prefs(ctx).edit().putString(KEY_FAILURE,
                    new JSONObject().put("version", version == null ? "" : version).put("message", message == null ? "" : message).toString()).apply();
        } catch (Exception ignored) {
            /* 记不下来就算了，不能因为记一句话再出一次错 */
        }
        if (dropApk) {
            //noinspection ResultOfMethodCallIgnored
            NativeBridge.updateApk(ctx).delete();
        }
    }

    /** 装成了：包没用了，之前记的失败也过去了。 */
    static void recordSuccess(Context ctx) {
        prefs(ctx).edit().remove(KEY_FAILURE).apply();
        //noinspection ResultOfMethodCallIgnored
        NativeBridge.updateApk(ctx).delete();
    }

    /** 上一次自动安装是怎么失败的，JSON：{version,message}；没有就是空串。 */
    static String failure(Context ctx) {
        return prefs(ctx).getString(KEY_FAILURE, "");
    }
}
