import SwiftUI
import WebKit
import CoreMotion

/// The paddle and nothing else: the phone's motion is the paddle. A hidden web view carries the
/// link to the TV (WebRTC); this screen only shows whether the paddle is live and flashes on a swing.
struct PaddleView: View {
    let room: String
    let onLeave: () -> Void
    @StateObject private var link = PaddleLink()

    var body: some View {
        ZStack {
            LinkWebView(room: room, link: link).opacity(0.01).allowsHitTesting(false)
            Color(red: 0.06, green: 0.05, blue: 0.08).ignoresSafeArea()
            Circle()
                .fill(link.live ? Color(red: 0.75, green: 0.95, blue: 0.2) : Color.white.opacity(0.12))
                .frame(width: 180, height: 180)
                .scaleEffect(link.pulse ? 1.12 : 1)
                .opacity(link.pulse ? 1 : (link.live ? 0.8 : 1))
                .animation(.spring(response: 0.25, dampingFraction: 0.5), value: link.pulse)
            VStack {
                Spacer()
                Text(link.text)
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.75))
                if link.tracking {
                    Text("You move: walk and step to reach the ball")
                        .font(.system(size: 14)).foregroundStyle(.white.opacity(0.5)).padding(.top, 4)
                    Button("Face the TV and tap to recenter") { link.tracker.recenter() }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color(red: 0.75, green: 0.95, blue: 0.2))
                        .padding(.top, 10)
                }
                Button("Leave", action: onLeave)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.top, 14).padding(.bottom, 30)
            }
        }
        .onChange(of: link.ended) { e in if e { onLeave() } }
        .onDisappear { link.motion.stop(); link.tracker.stop() }
    }
}

/// what the hidden page reports back, and the motion + haptics it drives
final class PaddleLink: NSObject, ObservableObject, WKScriptMessageHandler {
    @Published var live = false
    @Published var pulse = false
    @Published var text = "Connecting…"
    @Published var ended = false
    @Published var tracking = false
    let tracker = RoomTracker()
    weak var web: WKWebView?
    let motion = SwingDetector()
    private let hit = UIImpactFeedbackGenerator(style: .rigid)
    private let hard = UIImpactFeedbackGenerator(style: .heavy)
    private let note = UINotificationFeedbackGenerator()

    override init() {
        super.init()
        motion.onSwing = { [weak self] s in
            guard let self else { return }
            let js = String(format: "window.__nativeSwing && window.__nativeSwing({power:%.4f,lift:%.4f,face:%.4f,aim:%@,ago:%.4f,peak:%.0f})",
                            s.power, s.lift, s.face, s.aim.map { String(format: "%.4f", $0) } ?? "null", s.ago(), s.peak)
            self.web?.evaluateJavaScript(js)
            self.pulse = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.pulse = false }
        }
        tracker.onPos = { [weak self] x, z in
            self?.web?.evaluateJavaScript(String(format: "window.__nativePos && window.__nativePos({x:%.4f,z:%.4f})", x, z))
        }
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let t = m["t"] as? String else { return }
        switch t {
        case "start":
            motion.start()
            hit.prepare(); hard.prepare()
        case "recenter":
            motion.recenter()
        case "track":
            let on = (m["on"] as? Bool) ?? false
            if on && RoomTracker.supported { tracker.start(); tracking = true }
            else { tracker.stop(); tracking = false }
        case "status":
            switch m["state"] as? String {
            case "live": live = true; text = "Paddle ready · swing away"; note.notificationOccurred(.success)
            case "lost": live = false; text = "Reconnecting…"
            case "notfound": live = false; text = "No TV with that code"; DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { self.ended = true }
            case "full": live = false; text = "Two paddles are already playing"
            default: break
            }
        case "haptic":
            switch m["k"] as? String {
            case "hard": hard.impactOccurred(intensity: 1)
            case "point": note.notificationOccurred(.success)
            default: hit.impactOccurred(intensity: 0.85)
            }
            hit.prepare(); hard.prepare()
        default: break
        }
    }
}

/// the game's pad page, off screen: it holds the WebRTC link to the TV
struct LinkWebView: UIViewRepresentable {
    let room: String
    let link: PaddleLink

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(link, name: "dink")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        link.web = web
        var c = URLComponents(string: "https://reidwcoleman.github.io/dink-club/pad.html")!
        c.queryItems = [.init(name: "room", value: room), .init(name: "native", value: "1"), .init(name: "name", value: "Player")]
        web.load(URLRequest(url: c.url!, cachePolicy: .reloadRevalidatingCacheData))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    static func dismantleUIView(_ web: WKWebView, coordinator: ()) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "dink")
    }
}

/// One swing, measured at its peak.
struct Swing {
    let power: Double
    let lift: Double
    let face: Double
    let aim: Double?
    let peak: Double
    /// CMLogItem timestamp of the peak (seconds since boot)
    let t: TimeInterval
    func ago() -> Double { max(0, ProcessInfo.processInfo.systemUptime - t) }
}

/**
 Swing detection on CoreMotion's fused device motion at 100 Hz (the web page gets ~60 Hz):
 - a swing starts when the rotation rate passes 230°/s and ends just after its peak; the peak
   time is refined with a parabola through the neighbouring samples
 - power from the peak rotation rate, lift from the paddle's vertical speed (the integral of the
   user acceleration along "up", leaking between swings)
 - face: how far the screen tilts to the sky (−gravity·z)
 - aim: how far the phone has turned about the vertical since it was last held still (the gyro's
   component along "up", integrated; positive is a turn to the left, so aim is its negative)
 */
final class SwingDetector {
    var onSwing: ((Swing) -> Void)?
    private let mm = CMMotionManager()
    private let queue = OperationQueue()
    private var swinging = false
    private var cool: TimeInterval = 0
    private var samples: [(t: TimeInterval, g: Double, up: Double, face: Double, yaw: Double)] = []
    private var vUp = 0.0
    private var yaw = 0.0
    private var calmSince: TimeInterval = 0
    private var last: TimeInterval = 0
    private let start0 = 230.0

    func start() {
        guard mm.isDeviceMotionAvailable, !mm.isDeviceMotionActive else { return }
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInteractive
        mm.deviceMotionUpdateInterval = 1.0 / 100.0
        mm.startDeviceMotionUpdates(using: .xArbitraryCorrectedZVertical, to: queue) { [weak self] m, _ in
            guard let self, let m else { return }
            self.step(m)
        }
    }

    func stop() { mm.stopDeviceMotionUpdates() }

    func recenter() { queue.addOperation { self.yaw = 0 } }

    private func step(_ m: CMDeviceMotion) {
        let t = m.timestamp
        let dt = last > 0 ? min(0.05, t - last) : 0.01
        last = t
        let r = m.rotationRate
        let g = (r.x * r.x + r.y * r.y + r.z * r.z).squareRoot() * 180 / .pi
        let up = (x: -m.gravity.x, y: -m.gravity.y, z: -m.gravity.z)
        let aUp = (m.userAcceleration.x * up.x + m.userAcceleration.y * up.y + m.userAcceleration.z * up.z) * 9.81
        vUp = vUp * exp(-dt / (swinging ? 0.6 : 0.15)) + aUp * dt
        // turning about the vertical (right-handed: + = to the left seen from above)
        yaw += (r.x * up.x + r.y * up.y + r.z * up.z) * dt
        if g < 45 {
            if calmSince == 0 { calmSince = t }
            // held still: that's facing the TV — let the reference settle there
            if t - calmSince > 0.5 { yaw *= exp(-dt / 0.8) }
        } else { calmSince = 0 }
        let face = up.z
        if !swinging {
            samples.removeAll(keepingCapacity: true)
            if g > start0 && t > cool { swinging = true } else { return }
        }
        samples.append((t, g, vUp, face, yaw))
        let n = samples.count
        var k = 0
        for i in 1..<n where samples[i].g > samples[k].g { k = i }
        guard n - 1 > k, g < samples[k].g * 0.8 || t - samples[k].t > 0.06 || n > 45 else { return }
        swinging = false
        cool = t + 0.3
        var tPeak = samples[k].t, gPeak = samples[k].g
        if k > 0 && k < n - 1 {
            let y0 = samples[k - 1].g, y1 = samples[k].g, y2 = samples[k + 1].g
            let den = y0 - 2 * y1 + y2
            if den < 0 {
                let off = max(-0.5, min(0.5, 0.5 * (y0 - y2) / den))
                tPeak += off * (samples[k + 1].t - samples[k - 1].t) / 2
                gPeak = y1 - 0.25 * (y0 - y2) * off
            }
        }
        let pk = samples[k]
        let s = Swing(power: max(0, min(1, (gPeak - start0) / 1350)),
                      lift: max(-1, min(1, pk.up / 2.4)),
                      face: pk.face,
                      aim: max(-1.6, min(1.6, -pk.yaw / (40 * .pi / 180))),
                      peak: gPeak, t: tPeak)
        vUp = 0
        DispatchQueue.main.async { self.onSwing?(s) }
    }
}
