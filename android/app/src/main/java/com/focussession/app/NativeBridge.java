package com.focussession.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.PixelCopy;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.ByteArrayOutputStream;
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

    /** 升级包下在 cacheDir/update/ 下，交给安装器时走 FileProvider（见 res/xml/file_paths.xml）。 */
    private static final String UPDATE_DIR = "update";
    private static final String UPDATE_APK = "update.apk";
    /** 每下这么多字节往页面报一次进度。报太密的话那点进度数字还不够 evaluateJavascript 的开销。 */
    private static final long PROGRESS_STEP = 256 * 1024;

    private final MainActivity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> live = new ConcurrentHashMap<>();
    private final Set<String> aborted = ConcurrentHashMap.newKeySet();
    private TextRecognizer recognizer;
    private boolean closed;

    /**
     * 系统栏 / 刘海压在 WebView 上的那几条边，"上,右,下,左"，单位 CSS px。
     * @JavascriptInterface 的方法跑在 WebView 自己的绑定线程上，在那里碰视图是不行的，
     * 所以由 MainActivity 在主线程量好塞进来，这里只存一份现成的。
     */
    private volatile String insets = "0,0,0,0";

    private TextToSpeech tts;
    private boolean ttsReady;
    private String pendingSpeech;
    private String pendingLang = "en-US";
    private float pendingRate = 1f;

    NativeBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    /* ==================== 截图翻译 ==================== */

    @JavascriptInterface
    public void captureStart(String id) {
        activity.runOnUiThread(() -> {
            Bitmap bitmap = null;
            try {
                int[] at = new int[2];
                web.getLocationInWindow(at);
                int w = web.getWidth(), h = web.getHeight();
                if (w <= 0 || h <= 0) throw new IllegalStateException("阅读器还没有可截图的画面");
                bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                final Bitmap frame = bitmap;
                // 硬件加速下 View.draw 不可靠；PixelCopy 拿窗口 surface 上真正显示的像素。
                PixelCopy.request(activity.getWindow(), new Rect(at[0], at[1], at[0] + w, at[1] + h), frame, result -> {
                    if (result != PixelCopy.SUCCESS) {
                        frame.recycle();
                        imageError("__fsCapture", id, "截图失败：PixelCopy " + result);
                        return;
                    }
                    try {
                        pool.execute(() -> {
                            try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                                if (!frame.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                                    throw new IllegalStateException("截图 PNG 编码失败");
                                }
                                String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                                // 一次几 MB 的 evaluateJavascript 对这个一次性动作可以接受；
                                // README 反对的是 APK 按小块推几百次，还得在网页重新拼接的做法。
                                js("window.__fsCapture&&window.__fsCapture.done(" + JSONObject.quote(id) + ","
                                        + JSONObject.quote("data:image/png;base64," + b64) + ")");
                            } catch (Exception e) {
                                imageError("__fsCapture", id, "截图失败：" + e.getMessage());
                            } finally {
                                frame.recycle();
                            }
                        });
                    } catch (Exception e) {
                        frame.recycle();
                        imageError("__fsCapture", id, "截图失败：" + e.getMessage());
                    }
                }, new Handler(Looper.getMainLooper()));
            } catch (Exception e) {
                if (bitmap != null) bitmap.recycle();
                imageError("__fsCapture", id, "截图失败：" + e.getMessage());
            }
        });
    }

    /** 绑定线程、识别线程与 shutdown 共用同一把锁，避免重复建模型或关掉后重新创建。 */
    @JavascriptInterface
    public synchronized void ocrWarm() {
        if (closed) throw new IllegalStateException("识别器已关闭");
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    @JavascriptInterface
    public void ocrStart(String id, String pngBase64) {
        try {
            pool.execute(() -> {
                Bitmap bitmap = null;
                try {
                    byte[] bytes = Base64.decode(pngBase64, Base64.DEFAULT);
                    bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (bitmap == null) throw new IllegalArgumentException("无法解码待识别图片");
                    final Bitmap frame = bitmap;
                    InputImage image = InputImage.fromBitmap(frame, 0);
                    synchronized (this) {
                        ocrWarm();
                        // 完成回调不用 Activity 作用域或线程池：退出时也必须执行，才能释放位图。
                        recognizer.process(image).addOnCompleteListener(Runnable::run, task -> {
                            try {
                                if (!task.isSuccessful()) {
                                    Exception error = task.getException();
                                    imageError("__fsOcr", id, error == null ? "识别已取消" : "识别失败：" + error.getMessage());
                                    return;
                                }
                                JSONArray lines = new JSONArray();
                                boolean first = true;
                                // 保留 ML Kit 的 block 阅读顺序；按坐标全局排序会把多列的行穿插在一起。
                                for (Text.TextBlock block : task.getResult().getTextBlocks()) {
                                    if (!first) lines.put(new JSONObject().put("text", ""));
                                    first = false;
                                    for (Text.Line line : block.getLines()) {
                                        JSONObject value = new JSONObject().put("text", line.getText());
                                        Float confidence = line.getConfidence();
                                        if (confidence != null) value.put("confidence", confidence.doubleValue());
                                        lines.put(value);
                                    }
                                }
                                js("window.__fsOcr&&window.__fsOcr.done(" + JSONObject.quote(id) + ","
                                        + JSONObject.quote(lines.toString()) + ")");
                            } catch (Exception e) {
                                imageError("__fsOcr", id, "识别失败：" + e.getMessage());
                            } finally {
                                frame.recycle();
                            }
                        });
                    }
                    bitmap = null; // 异步识别还要读它，由完成回调回收。
                } catch (Exception e) {
                    imageError("__fsOcr", id, "识别失败：" + e.getMessage());
                } finally {
                    if (bitmap != null) bitmap.recycle();
                }
            });
        } catch (Exception e) {
            imageError("__fsOcr", id, "识别失败：" + e.getMessage());
        }
    }

    private void imageError(String callback, String id, String message) {
        js("window." + callback + "&&window." + callback + ".error("
                + JSONObject.quote(id) + "," + JSONObject.quote(message) + ")");
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

    /* ==================== 自动更新 ==================== */

    /**
     * 这个安装是不是 debug 签名的。buildConfig 关着（build.gradle.kts），没有 BuildConfig.DEBUG，
     * 看 manifest 里那个由构建类型翻出来的 debuggable 标志。
     *
     * 网页据此把「下载并安装」换成一句说明：debug 包和正式签名的发布版签名不一致，
     * 覆盖安装会被系统直接拒掉，而它给的只有一句没头没尾的「应用未安装」。
     */
    @JavascriptInterface
    public boolean isDebugBuild() {
        return (activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /**
     * 下载升级包。APK 的字节**不**走 HTTP 代发那条路：一个几兆的包按 16KB 一块 base64
     * 推回页面是几百次 evaluateJavascript，还要在 JS 那边再拼一遍。这里直接写进缓存目录，
     * 只把进度数字推回去。
     */
    @JavascriptInterface
    public void updateDownload(String url, long expectedBytes) {
        pool.execute(() -> download(url, expectedBytes));
    }

    /** 升级包的落点。MainActivity 恢复「刚才正等着装」时也要认得这个路径。 */
    static File updateApk(Context ctx) {
        return new File(new File(ctx.getCacheDir(), UPDATE_DIR), UPDATE_APK);
    }

    private void download(String url, long expectedBytes) {
        File apk = updateApk(activity);
        HttpURLConnection c = null;
        try {
            URL target = new URL(url);
            /*
             * 升级包只从 github.com 的 https 地址下——这是唯一一个下下来就要交给系统安装器的文件，
             * 而这个地址来自一段网络响应。跟随的重定向不再查（GitHub 会跳到自己的对象存储上，
             * 那个域名换过几次，钉死它等于哪天悄悄断掉升级），所以这条挡的是
             * 「响应里的 URL 字段被换成了别处」，不是「TLS 被破了」——后者出现时这里挡什么都晚了。
             */
            if (!"https".equals(target.getProtocol()) || !"github.com".equals(target.getHost())) {
                throw new IllegalStateException("升级包的地址不对：" + target.getProtocol() + "://" + target.getHost());
            }

            File dir = apk.getParentFile();
            // 上一次下到一半的残包留着只会碍事，每次从干净的目录开始
            deleteRecursively(dir);
            if (dir == null || (!dir.mkdirs() && !dir.isDirectory())) {
                throw new IllegalStateException("建不了缓存目录");
            }

            c = (HttpURLConnection) target.openConnection();
            // browser_download_url 会 302 到 objects.githubusercontent.com，两头都是 https，
            // 交给 HttpURLConnection 自己跟就行——上面 run() 里那个手写的循环是为了 http↔https，
            // 这里用不上
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(20_000);
            c.setReadTimeout(120_000);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent", USER_AGENT);
            int status = c.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("服务器返回 " + status);

            // 对方没报长度时退回 Release 里写的那个大小，两个都没有就报 0（页面只显示已下多少）
            long total = c.getContentLengthLong();
            if (total <= 0) total = Math.max(expectedBytes, 0);

            long received = 0;
            long reported = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream os = new FileOutputStream(apk)) {
                byte[] buf = new byte[CHUNK];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    received += n;
                    if (received - reported >= PROGRESS_STEP) {
                        reported = received;
                        progress(received, total);
                    }
                }
                // 安装器是另一个进程，读之前得确保字节真的落盘了
                os.getFD().sync();
            }
            progress(received, total);

            // Release 上写着多大就该收到多大。对不上多半是下断了，这种包送进安装器只会白弹一次框
            if (expectedBytes > 0 && received != expectedBytes) {
                throw new IllegalStateException("收到 " + received + " 字节，应该是 " + expectedBytes);
            }
            js("window.__fsUpdate&&window.__fsUpdate.done()");
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            apk.delete(); // 半个包不能留在那儿等着被装
            String message = e.getMessage();
            js("window.__fsUpdate&&window.__fsUpdate.error("
                    + JSONObject.quote(message == null || message.isEmpty() ? e.getClass().getSimpleName() : message) + ")");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void progress(long received, long total) {
        js("window.__fsUpdate&&window.__fsUpdate.progress(" + received + "," + total + ")");
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File kid : kids) deleteRecursively(kid);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 把下好的包交给系统安装器。装不装、什么时候装，从这儿起就是系统和用户的事了。 */
    @JavascriptInterface
    public void updateInstall() {
        File apk = updateApk(activity);
        if (!apk.isFile()) {
            toast(activity.getString(R.string.update_missing));
            return;
        }
        activity.runOnUiThread(() -> activity.installUpdate(apk));
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

    /* ==================== 全屏阅读 ==================== */

    /**
     * 收起 / 放回系统栏。阅读器一打开就收起来（见 src/app/fullscreen.ts）：
     * 手机上一篇文章该占整块屏。收起后从屏幕边缘往里划能把系统栏临时叫回来。
     *
     * @JavascriptInterface 的方法跑在 WebView 自己的绑定线程上，碰窗口得回主线程。
     */
    @JavascriptInterface
    public void setFullscreen(boolean hidden) {
        activity.runOnUiThread(() -> activity.setFullscreen(hidden));
    }

    /* ==================== 安全区 ==================== */

    /** 主线程调用。值没变就不推：转屏、软键盘、分屏都会重新派发一遍 insets。 */
    void setInsets(int top, int right, int bottom, int left) {
        final float density = activity.getResources().getDisplayMetrics().density;
        final String v = px(top, density) + "," + px(right, density)
                + "," + px(bottom, density) + "," + px(left, density);
        if (v.equals(insets)) return;
        insets = v;
        web.evaluateJavascript(
                "window.__fsHost&&window.__fsHost.insets&&window.__fsHost.insets('" + v + "')", null);
    }

    /**
     * 物理像素 → CSS px。页面的 viewport 是 width=device-width, initial-scale=1，
     * 那么 1 CSS px 就是 1dp。
     */
    private static String px(int raw, float density) {
        // Locale.US：德语区的 %.2f 出来是 "12,00"，而逗号正是这串值的分隔符
        return String.format(Locale.US, "%.2f", raw / density);
    }

    /** 页面首屏同步问一次，不必等宿主推。 */
    @JavascriptInterface
    public String insets() {
        return insets;
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

    synchronized void shutdown() {
        closed = true;
        if (recognizer != null) {
            recognizer.close();
            recognizer = null;
        }
        pool.shutdownNow();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
    }
}
