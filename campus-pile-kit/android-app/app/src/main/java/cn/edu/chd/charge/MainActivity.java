package cn.edu.chd.charge;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.SystemClock;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * 整个 App 就是这一层 WebView —— 不打包任何网页资源。
 *
 * <p>为什么这样做：站点的版本节奏很快（一天能发好几版），而 APK 发一次要用户手动装。
 * 只装一个"窗口"、内容永远从线上取，网站一更新，App 下次打开就是新版，
 * 不必为一个文案改动去发安装包。
 *
 * <p>代价与边界：
 * <ul>
 *   <li>断网时只能看到壳（Service Worker 缓存的界面 + 上次的数据），看不到实时空位 —— 本来也不该看到。</li>
 *   <li>换域名必须重新出 APK（入口地址编译进 BuildConfig 了）。</li>
 * </ul>
 */
public class MainActivity extends AppCompatActivity {

    private static final int REQ_FILE = 3001;
    private static final long BACK_EXIT_MS = 2000L;

    /** 页面里有打开的 <dialog> 就先关它 —— 否则按返回键会直接退出 App，弹窗还开着。 */
    private static final String JS_CLOSE_DIALOG =
        "(function(){var d=document.querySelector('dialog[open]');"
            + "if(d){try{d.close()}catch(e){};return 1}return 0})()";

    private static final String OFFLINE_HTML =
        "<!doctype html><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
            + "<title>网络没连上</title><style>"
            + "html,body{margin:0;height:100%;background:#F7F6F2;color:#2C2C2A;"
            + "font:15px/1.7 -apple-system,'PingFang SC','Noto Sans SC',system-ui,sans-serif;"
            + "display:flex;align-items:center;justify-content:center;text-align:center}"
            + ".w{padding:0 30px;max-width:340px}"
            + ".ic{width:64px;height:64px;border-radius:17px;background:#1D9E75;margin:0 auto 18px;"
            + "display:flex;align-items:center;justify-content:center}"
            + "h1{font-size:17px;margin:0 0 8px;font-weight:600}"
            + "p{font-size:13.5px;color:#6B6A65;margin:0 0 20px}"
            + "a{display:inline-block;padding:10px 24px;border-radius:999px;background:#1D9E75;"
            + "color:#fff;text-decoration:none;font-size:14px}"
            + "@media (prefers-color-scheme:dark){html,body{background:#171917;color:#EAEAE4}"
            + "p{color:#A8A79F}}"
            + "</style><div class=\"w\">"
            + "<div class=\"ic\"><svg width=\"34\" height=\"34\" viewBox=\"0 0 64 64\">"
            + "<path d=\"M36 10 20 34h10l-2 20 18-26h-11z\" fill=\"#fff\"/></svg></div>"
            + "<h1>网络没连上</h1>"
            + "<p>这台设备现在没有可用网络。连上 Wi-Fi 或流量后再打开一次。</p>"
            + "<a href=\"__URL__\">重新加载</a></div>";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    /** target="_blank" 的接应 WebView，必须持引用，否则可能被回收 */
    private WebView popupHolder;
    private long lastBackAt = 0;

    @Override
    protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);

        // 内容铺到系统栏下方（Android 15 起这是强制的），再自己用 padding 让开
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        applyBarIcons();

        web = new WebView(this);
        // 深色模式下 WebView 默认白底，冷启动会闪一下白
        web.setBackgroundColor(Color.parseColor(isNight() ? "#171917" : "#F7F6F2"));
        setContentView(web);

        applyInsets();
        configureWebView(web);
        bindBackKey();

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(BuildConfig.APP_URL);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(final WebView v) {
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // cpk.* 偏好、云同步 SDK 都依赖
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);   // 跟随站点自己的 Cache-Control 与 SW
        s.setUseWideViewPort(false);                // 页面自带 viewport meta，别二次缩放
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                         // 系统字号放大到 150% 会把卡片布局撑坏
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(true);           // 开了才能在 onCreateWindow 里接管 _blank
        s.setMediaPlaybackRequiresUserGesture(true);
        // UA 尾巴：以后想在网页里识别"来自 App"就靠它，不影响任何现有逻辑
        s.setUserAgentString(s.getUserAgentString() + " ChdChargeApp/" + BuildConfig.VERSION_NAME);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleNav(req.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                String scheme = req.getUrl().getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    showOffline();
                }
            }
        });

        v.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                // 页面里的 target="_blank"（致谢里的 GitHub 链接）→ 交给系统浏览器
                final WebView probe = new WebView(view.getContext());
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView p, WebResourceRequest req) {
                        openExternally(req.getUrl());
                        p.post(new Runnable() {
                            @Override
                            public void run() {
                                p.loadUrl("about:blank");
                                p.destroy();
                                if (popupHolder == probe) popupHolder = null;
                            }
                        });
                        return true;
                    }
                });
                popupHolder = probe;

                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = cb;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(
                        Intent.createChooser(pick, getString(R.string.choose_file)), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, R.string.no_file_picker,
                        Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback cb) {
                cb.invoke(origin, false, false);   // 只用空位数据，不需要定位
            }
        });
    }

    /** 站内链接留在 WebView，站外/系统协议交给对应 App */
    private boolean handleNav(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            if (BuildConfig.APP_HOST.equalsIgnoreCase(uri.getHost())) {
                return false;
            }
            openExternally(uri);
            return true;
        }
        openExternally(uri);
        return true;
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.link_error, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 给系统栏留出内边距。
     * <p>网站用了 viewport-fit=cover，但 Android WebView 不支持 env(safe-area-inset-*)，
     * 只能由原生补 —— 否则状态栏会压在标题上、底部导航条会盖住最后一张卡片。
     * 键盘弹出时把底部换成 ime 高度，输入框才不会被挡。
     */
    private void applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(web, new OnApplyWindowInsetsListener() {
            @Override
            public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsetsCompat.CONSUMED;
            }
        });
    }

    private void bindBackKey() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web == null) {
                    finish();
                    return;
                }
                web.evaluateJavascript(JS_CLOSE_DIALOG, new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("1".equals(value)) return;        // 刚关掉一个弹窗
                        if (web != null && web.canGoBack()) {
                            web.goBack();
                            return;
                        }
                        doubleBackToExit();
                    }
                });
            }
        });
    }

    private void doubleBackToExit() {
        long now = SystemClock.uptimeMillis();
        if (now - lastBackAt < BACK_EXIT_MS) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, R.string.exit_hint, Toast.LENGTH_SHORT).show();
    }

    /**
     * 主文档加载失败时的兜底页。
     * <p>正常情况下断网会由 Service Worker 吐出缓存好的壳，走不到这里；
     * 只有首次安装、还没被 SW 接管又恰好断网时才看得到。底部用 loadDataWithBaseURL
     * 以站点为 base，页面里的「重新加载」是相对路径，联网后能直接跳回首页。
     */
    private void showOffline() {
        if (web == null) return;
        web.loadDataWithBaseURL(BuildConfig.APP_URL,
            OFFLINE_HTML.replace("__URL__", BuildConfig.APP_URL),
            "text/html", "utf-8", null);
    }

    private void applyBarIcons() {
        WindowInsetsControllerCompat c =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        boolean night = isNight();
        c.setAppearanceLightStatusBars(!night);
        c.setAppearanceLightNavigationBars(!night);
    }

    private boolean isNight() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // manifest 里声明了 uiMode，换深色模式不会重建 Activity，图标要手动换
        applyBarIcons();
        if (web != null) {
            web.setBackgroundColor(Color.parseColor(isNight() ? "#171917" : "#F7F6F2"));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[] { data.getData() };
        }
        // 取消时也必须回传 null，否则页面的 input[type=file] 会一直"卡住"再也点不动
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 触发页面的 visibilitychange(hidden)：网站的「回前台超 10 分钟才刷新」靠它判断
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        if (popupHolder != null) {
            popupHolder.destroy();
            popupHolder = null;
        }
        super.onDestroy();
    }
}
