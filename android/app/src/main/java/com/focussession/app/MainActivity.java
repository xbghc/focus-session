package com.focussession.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 整个 App 就是一个 WebView，装着 assets/www 里由 `npm run build:app` 生成的三个页面。
 *
 * 页面通过 WebViewAssetLoader 以 https://appassets.androidplatform.net/www/… 端出来，
 * 于是有一个真实的 https origin：IndexedDB 能用、crypto.randomUUID 能用、字体能加载。
 * 原生这边只管三件事：把跨域 HTTP 代发出去（NativeBridge）、把系统的返回键 / 分享 /
 * 文件选择接到网页上、以及把站外链接一律送进阅读器。
 */
public class MainActivity extends ComponentActivity {

    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String ROOT = ORIGIN + "/www/";
    static final String INDEX = ROOT + "index.html";
    private static final Pattern URL_IN_TEXT = Pattern.compile("https?://[^\\s<>\"']+");

    private ReaderWebView web;
    private NativeBridge bridge;
    private ValueCallback<Uri[]> pendingFile;
    private ActivityResultLauncher<Intent> filePicker;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new ReaderWebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 页面自己带 viewport meta，不开这个 WebView 会当它不存在
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // 文章里的图片常是 http 的，页面本身是 https
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setMediaPlaybackRequiresUserGesture(true);
        // window.open（回顾页的「打开原文」）要走 onCreateWindow 才拿得到地址
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // Android 10–12 的深色：页面声明了 color-scheme，AUTO 会用页面自己的暗色样式而不是算法反色；13+ 不需要
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(s, WebSettingsCompat.FORCE_DARK_AUTO);
        }

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "Native");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (isApp(u)) return false;
                openExternal(u);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /** 设置页的「导入并合并 JSON」用的是普通的 <input type=file>，这里接到系统的文件选择器上。 */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");
                try {
                    filePicker.launch(pick);
                } catch (Exception e) {
                    pendingFile = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            /** window.open(url)：拿到地址就送进阅读器，临时的那个 WebView 不显示。 */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                final WebView temp = new WebView(view.getContext());
                temp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        Uri u = request.getUrl();
                        if (isApp(u)) web.loadUrl(u.toString());
                        else openExternal(u);
                        v.post(v::destroy);
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(temp);
                resultMsg.sendToTarget();
                return true;
            }
        });

        filePicker = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = pendingFile;
            pendingFile = null;
            if (cb == null) return;
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == RESULT_OK && data != null && data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
            cb.onReceiveValue(uris);
        });

        // 返回键先问网页：阅读器要先结算 session、等写入落盘，再让我们回退
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript(
                        "(function(){try{return window.__fsHost&&window.__fsHost.beforeBack()?'1':'0'}catch(e){return '0'}})()",
                        value -> {
                            if ("\"1\"".equals(value)) return; // 网页接管了，稍后调 Native.navigateBack()
                            goBack();
                        });
            }
        });

        if (state != null) {
            web.restoreState(state);
            if (web.getUrl() == null) web.loadUrl(INDEX);
        } else {
            handleIntent(getIntent(), true);
        }
    }

    /** 站外链接一律进阅读器：文章卡片的标题、正文里的链接、回顾页的「打开原文」。 */
    void openExternal(Uri u) {
        String scheme = u.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) {
            web.loadUrl(readerUrl(u.toString()));
            return;
        }
        // mailto: 之类交给系统
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
            /* 没有能处理的应用 */
        }
    }

    static boolean isApp(Uri u) {
        return "appassets.androidplatform.net".equals(u.getHost());
    }

    static String readerUrl(String url) {
        return ROOT + "read.html?u=" + Uri.encode(url);
    }

    /** 从「分享」进来：文本里挑出第一个网址。 */
    private void handleIntent(Intent intent, boolean fresh) {
        String url = null;
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) {
                Matcher m = URL_IN_TEXT.matcher(text);
                if (m.find()) url = m.group();
            }
        }
        if (url != null) web.loadUrl(readerUrl(url));
        else if (fresh) web.loadUrl(INDEX);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    void goBack() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        String url = web.getUrl();
        if (url == null || url.startsWith(INDEX)) finish();
        else web.loadUrl(INDEX);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 切到后台 = 页面不可见：阅读器据此结束当前的 session
        web.evaluateJavascript("window.__fsHost&&window.__fsHost.visibility(false)", null);
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.evaluateJavascript("window.__fsHost&&window.__fsHost.visibility(true)", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        bridge.shutdown();
        web.destroy();
        super.onDestroy();
    }
}
