package com.reidcoleman.dinkclub;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * Phones on the home Wi-Fi, without the browser: the Dink Club iPhone app talks to the TV over
 * UDP (JSON datagrams), which keeps working while the phone is locked or in another app. The TV
 * advertises itself over Bonjour/NSD (_dinkclub._udp, with the room code), relays every datagram
 * into the page (window.__lan(from, msg)) and sends the page's replies back (DinkLan.send).
 */
public class LanPads {
    public static final int PORT = 47811;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private DatagramSocket sock;
    private NsdManager nsd;
    private NsdManager.RegistrationListener reg;
    private WifiManager.MulticastLock lock;
    private volatile boolean running;

    public LanPads(WebView web) { this.web = web; }

    public void start(Context ctx) {
        if (running) return;
        running = true;
        try {
            WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { lock = wm.createMulticastLock("dinkclub"); lock.acquire(); }
        } catch (Exception ignored) {}
        new Thread(this::loop, "lan-pads").start();
        nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
    }

    public void stop() {
        running = false;
        if (sock != null) sock.close();
        try { if (nsd != null && reg != null) nsd.unregisterService(reg); } catch (Exception ignored) {}
        reg = null;
        if (lock != null && lock.isHeld()) lock.release();
    }

    private void loop() {
        try {
            sock = new DatagramSocket(null);
            sock.setReuseAddress(true);
            sock.bind(new InetSocketAddress(PORT));
            byte[] buf = new byte[4096];
            while (running) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                sock.receive(p);
                String text = new String(p.getData(), 0, p.getLength(), "UTF-8");
                // only well-formed JSON objects reach the page, re-serialised (nothing is evaluated as given)
                final String msg;
                try { msg = new JSONObject(text).toString(); } catch (Exception e) { continue; }
                final String from = p.getAddress().getHostAddress() + ":" + p.getPort();
                ui.post(() -> web.evaluateJavascript("window.__lan && window.__lan(" + JSONObject.quote(from) + "," + msg + ")", null));
            }
        } catch (Exception e) {
            running = false;
        }
    }

    /** the page: send a message to a phone */
    @JavascriptInterface
    public void send(String to, String json) {
        final DatagramSocket s = sock;
        if (s == null || to == null) return;
        int c = to.lastIndexOf(':');
        if (c < 0) return;
        try {
            final InetAddress a = InetAddress.getByName(to.substring(0, c));
            final int port = Integer.parseInt(to.substring(c + 1));
            final byte[] b = json.getBytes("UTF-8");
            new Thread(() -> { try { s.send(new DatagramPacket(b, b.length, a, port)); } catch (Exception ignored) {} }).start();
        } catch (Exception ignored) {}
    }

    /** the page: this TV's address on the home network ("ip:port"), for the join code */
    @JavascriptInterface
    public String address() {
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!n.isUp() || n.isLoopback()) continue;
                for (InetAddress a : Collections.list(n.getInetAddresses()))
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress() + ":" + PORT;
            }
        } catch (Exception ignored) {}
        return "";
    }

    /** the page: advertise this TV (and its room code) to phones on the network */
    @JavascriptInterface
    public void advertise(final String code) {
        ui.post(() -> {
            try {
                if (nsd == null) return;
                if (reg != null) { nsd.unregisterService(reg); reg = null; }
                NsdServiceInfo info = new NsdServiceInfo();
                info.setServiceName("Dink Club " + code);
                info.setServiceType("_dinkclub._udp");
                info.setPort(PORT);
                info.setAttribute("code", code);
                reg = new NsdManager.RegistrationListener() {
                    public void onServiceRegistered(NsdServiceInfo i) {}
                    public void onRegistrationFailed(NsdServiceInfo i, int e) {}
                    public void onServiceUnregistered(NsdServiceInfo i) {}
                    public void onUnregistrationFailed(NsdServiceInfo i, int e) {}
                };
                nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, reg);
            } catch (Exception ignored) {}
        });
    }
}
