package com.reidcoleman.dinkclub;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Dink Club on the TV: the game full screen in a WebView (WebGL + WebRTC for the phones),
 * sound without a click, the screen kept on, and the remote's Back button pausing the game
 * (press it twice from the menu to leave).
 */
public class MainActivity extends Activity {
    private static final String URL = "https://reidwcoleman.github.io/dink-club/?tv=1";
    private WebView web;
    private long lastBack = 0;

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d1018"));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setUserAgentString(ws.getUserAgentString() + " DinkClubTV/1");
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);
        web.requestFocus();
        // a fresh page every launch: after a deploy a cached page would point at files that are gone
        web.loadUrl(URL + "&v=" + System.currentTimeMillis());
        immersive();
    }

    private void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override public void onWindowFocusChanged(boolean has) { super.onWindowFocusChanged(has); if (has) immersive(); }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() != KeyEvent.ACTION_UP) return true;
            long now = System.currentTimeMillis();
            if (now - lastBack < 700) { finish(); return true; }
            lastBack = now;
            // the page decides: pause the match, or back out of a screen
            web.evaluateJavascript("window.__tvBack && window.__tvBack()", null);
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }
}
