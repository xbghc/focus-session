package com.focussession.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 注入到网页 `window.Native` 上的桥。方法一一对应 src/app/native.ts 里的 NativeBridge。
 *
 * 最重要的是 HTTP 代发：MiniMax 的端点没有 CORS 头，WebView 里的页面直接 fetch 会被拦。
 * 这里在线程池里用 HttpURLConnection 发请求，把响应**分块**推回网页
 * （`__fsHttp.head / chunk / end / error`），流式翻译的逐字段显示就靠这个。
 * 字节用 base64 传：一块的边界可能落在多字节字符中间，按文本传会出乱码。
 */
public class NativeBridge {

    /** 抓网页时报的 UA。宿主一律按手机 Chrome 报，网页自己带了就用网页的。 */
    private static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Mobile Safari/537.36";
    private static final int MAX_REDIRECTS = 6;
    private static final int CHUNK = 16 * 1024;

    private final MainActivity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> live = new ConcurrentHashMap<>();
    private final Set<String> aborted = ConcurrentHashMap.newKeySet();

    private TextToSpeech tts;
    private boolean ttsReady;
    private String pendingSpeech;
    private String pendingLang = "en-US";
    private float pendingRate = 1f;

    NativeBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    /* ==================== HTTP ==================== */

    @JavascriptInterface
    public void httpStart(String id, String url, String method, String headersJson, String body) {
        pool.execute(() -> run(id, url, method, headersJson, body));
    }

    @JavascriptInterface
    public void httpAbort(String id) {
        aborted.add(id);
        HttpURLConnection c = live.get(id);
        if (c != null) pool.execute(c::disconnect);
    }

    private void run(String id, String url, String method, String headersJson, String body) {
        HttpURLConnection c = null;
        try {
            URL target = new URL(url);
            JSONObject headers = headersJson == null ? new JSONObject() : new JSONObject(headersJson);
            int status;
            String statusText;
            for (int hop = 0; ; hop++) {
                String protocol = target.getProtocol();
                if (!"https".equals(protocol) && !"http".equals(protocol)) {
                    error(id, "只支持 http(s) 地址");
                    return;
                }
                c = (HttpURLConnection) target.openConnection();
                // 自己跟重定向：HttpURLConnection 不跟 http↔https 之间的跳转
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20_000);
                c.setReadTimeout(120_000);
                c.setRequestMethod(method);
                c.setRequestProperty("User-Agent", USER_AGENT);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    c.setRequestProperty(k, headers.getString(k));
                }
                live.put(id, c);
                if (body != null && !body.isEmpty()) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                status = c.getResponseCode();
                statusText = c.getResponseMessage();
                boolean redirect = status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
                String location = c.getHeaderField("Location");
                if (!redirect || location == null || hop >= MAX_REDIRECTS) break;
                target = new URL(target, location);
                c.disconnect();
                // 303 以及 301/302 对 POST 的惯例：改成 GET
                if (status == 303 || ((status == 301 || status == 302) && !"GET".equals(method))) {
                    method = "GET";
                    body = null;
                }
            }
            if (aborted.contains(id)) return;

            JSONObject out = new JSONObject();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null) continue; // 状态行
                out.put(e.getKey().toLowerCase(Locale.ROOT), String.join(", ", e.getValue()));
            }
            // 网页那边要按最终地址补全相对链接
            out.put("x-fs-final-url", c.getURL().toString());
            js("window.__fsHttp&&window.__fsHttp.head(" + JSONObject.quote(id) + "," + status + ","
                    + JSONObject.quote(statusText == null ? "" : statusText) + "," + JSONObject.quote(out.toString()) + ")");

            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                byte[] buf = new byte[CHUNK];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (aborted.contains(id)) break;
                    js("window.__fsHttp&&window.__fsHttp.chunk(" + JSONObject.quote(id) + ","
                            + JSONObject.quote(Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)) + ")");
                }
                in.close();
            }
            if (!aborted.contains(id)) js("window.__fsHttp&&window.__fsHttp.end(" + JSONObject.quote(id) + ")");
        } catch (Exception e) {
            if (!aborted.contains(id)) error(id, e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            live.remove(id);
            aborted.remove(id);
            if (c != null) c.disconnect();
        }
    }

    private void error(String id, String message) {
        js("window.__fsHttp&&window.__fsHttp.error(" + JSONObject.quote(id) + "," + JSONObject.quote(message) + ")");
    }

    /** evaluateJavascript 只能在主线程调。 */
    private void js(String script) {
        activity.runOnUiThread(() -> web.evaluateJavascript(script, null));
    }

    /* ==================== 文件 ==================== */

    /** 写进系统「下载」目录。Android 10 起走 MediaStore，不需要任何权限。 */
    @JavascriptInterface
    public String saveFile(String name, String mime, String text) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FocusSession");
                Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IllegalStateException("MediaStore 拒绝了写入");
                try (OutputStream os = activity.getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new IllegalStateException("打不开输出流");
                    os.write(text.getBytes(StandardCharsets.UTF_8));
                }
                String msg = activity.getString(R.string.saved_to, name);
                toast(msg);
                return msg;
            }
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = activity.getFilesDir();
            File f = new File(dir, name);
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(text.getBytes(StandardCharsets.UTF_8));
            }
            String msg = activity.getString(R.string.saved_to_app_dir, f.getAbsolutePath());
            toast(msg);
            return msg;
        } catch (Exception e) {
            String msg = activity.getString(R.string.save_failed, e.getMessage());
            toast(msg);
            return msg;
        }
    }

    /** 走系统分享面板：发到电脑、存进网盘、发给自己的聊天窗口都从这里走。 */
    @JavascriptInterface
    public void shareFile(String name, String mime, String text) {
        try {
            File dir = new File(activity.getCacheDir(), "share");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(text.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", f);
            Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(mime)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.runOnUiThread(() ->
                    activity.startActivity(Intent.createChooser(send, activity.getString(R.string.share_title))));
        } catch (Exception e) {
            toast(activity.getString(R.string.save_failed, e.getMessage()));
        }
    }

    /* ==================== 朗读 ==================== */

    /** WebView 没有 Web Speech API，网页那边把 speechSynthesis 垫到这里。 */
    @JavascriptInterface
    public void speak(String text, String lang, float rate) {
        activity.runOnUiThread(() -> {
            pendingSpeech = text;
            pendingLang = lang == null ? "en-US" : lang;
            pendingRate = rate <= 0 ? 1f : rate;
            if (tts == null) {
                tts = new TextToSpeech(activity, status -> {
                    ttsReady = status == TextToSpeech.SUCCESS;
                    if (ttsReady) activity.runOnUiThread(this::flushSpeech);
                });
                return;
            }
            if (ttsReady) flushSpeech();
        });
    }

    private void flushSpeech() {
        if (tts == null || !ttsReady || pendingSpeech == null) return;
        tts.setLanguage(Locale.forLanguageTag(pendingLang));
        tts.setSpeechRate(pendingRate);
        tts.speak(pendingSpeech, TextToSpeech.QUEUE_FLUSH, null, "focus-session");
        pendingSpeech = null;
    }

    @JavascriptInterface
    public void stopSpeaking() {
        activity.runOnUiThread(() -> {
            pendingSpeech = null;
            if (tts != null) tts.stop();
        });
    }

    /* ==================== 导航与杂项 ==================== */

    /** 网页处理完返回键（结算 session、等写入落盘）之后叫宿主真正回退。 */
    @JavascriptInterface
    public void navigateBack() {
        activity.runOnUiThread(activity::goBack);
    }

    @JavascriptInterface
    public String version() {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    private void toast(String msg) {
        activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
    }

    void shutdown() {
        pool.shutdownNow();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
    }
}
