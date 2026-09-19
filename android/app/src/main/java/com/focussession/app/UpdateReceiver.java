package com.focussession.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * 静默安装的结果（UpdateInstaller.commitSilently 提交时留的回执地址）。
 *
 * 装成的那一刻旧进程已经被杀了，这条广播是新版本的进程收到的——所以它只能是清单里登记的接收器，
 * 不能是 Activity 里临时注册的那种。不导出：只有系统拿着我们给的 PendingIntent 才发得进来。
 */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String version = intent.getStringExtra(UpdateInstaller.EXTRA_VERSION);
        if (status == PackageInstaller.STATUS_SUCCESS) {
            UpdateInstaller.recordSuccess(context);
            return;
        }
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // 系统要人点确认。人此刻不在这个 App 里，后台也起不了那个确认框：这次作罢，会话丢掉，
            // 下回打开时页面给一条「已下载，点一下安装」的横幅
            int id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
            if (id >= 0) {
                try {
                    context.getPackageManager().getPackageInstaller().abandonSession(id);
                } catch (Exception ignored) {
                    /* 会话已经没了 */
                }
            }
            UpdateInstaller.recordRefused(context);
            return;
        }
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        // 包本身有毛病（坏了、签名对不上、和装着的冲突）才删；存储满、被中断这类留着下回再试
        boolean bad = status == PackageInstaller.STATUS_FAILURE_INVALID
                || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
                || status == PackageInstaller.STATUS_FAILURE_CONFLICT;
        UpdateInstaller.recordFailure(context, version, "状态 " + status + (message == null ? "" : "：" + message), bad);
    }
}
