import SwiftUI
import WebKit
import CoreMotion
import simd
import Network

/// The paddle and nothing else: the phone's motion is the paddle. With the Dink Club TV app on the
/// same Wi-Fi the phone talks to it directly (and keeps working locked or in the background);
/// otherwise a hidden web view carries the link (WebRTC, foreground only). This screen only shows
/// whether the paddle is live and flashes on a swing.
struct PaddleView: View {
    let room: String
    var lan: String? = nil
    let onLeave: () -> Void
    @StateObject private var link = PaddleLink()

    var body: some View {
        ZStack {
            if link.mode == .web {
                LinkWebView(room: room, link: link).opacity(0.01).allowsHitTesting(false)
            }
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
                if link.mode == .lan && link.live {
                    Text("Works with the screen locked too")
                        .font(.system(size: 13)).foregroundStyle(.white.opacity(0.4)).padding(.top, 4)
                }
                if !link.trackOK {
                    Text("Camera tracking lost: keep the back camera uncovered, facing the room")
                        .font(.system(size: 13)).foregroundStyle(.orange.opacity(0.85))
                        .multilineTextAlignment(.center).padding(.horizontal, 30).padding(.top, 6)
                }
                if link.tracking {
                    Text("You move: walk and step to reach the ball")
                        .font(.system(size: 14)).foregroundStyle(.white.opacity(0.5)).padding(.top, 4)
                    Button("Face the TV and tap to recenter") { link.tracker.recenter(); link.motion.recenter() }
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
        .onAppear { link.begin(room: room, lan: lan) }
        .onDisappear { link.finish() }
    }
}

/// what the hidden page reports back, and the motion + haptics it drives
final class PaddleLink: NSObject, ObservableObject, WKScriptMessageHandler {
    enum Mode { case searching, lan, web }
    @Published var mode: Mode = .searching
    private var lanLink: LanLink?
    private let finder = TVFinder()
    private let keepAlive = KeepAlive()
    private let pock = Pock()
    /// the motion sensors' heading correction (rad), trued to the camera tracking whenever it sees
    private var yawTrue = 0.0
    /// the paddle's position carried on by the motion sensors through a gap in the camera tracking
    /// (the last camera fix's time is `at`; `t` the last step)
    private var fix: (pos: SIMD3<Double>, t: TimeInterval, at: TimeInterval)?
    private var lastFixPos: SIMD3<Double>?
    @Published var live = false
    @Published var pulse = false
    @Published var text = "Connecting…"
    @Published var ended = false
    @Published var tracking = false
    @Published var trackOK = true
    private var okTimer: Timer?
    let tracker = RoomTracker()
    weak var web: WKWebView?
    let motion = SwingDetector()
    private let hit = UIImpactFeedbackGenerator(style: .rigid)
    private let hard = UIImpactFeedbackGenerator(style: .heavy)
    private let note = UINotificationFeedbackGenerator()

    override init() {
        super.init()
        tracker.lastFast = { [weak self] in self?.motion.lastFast ?? 0 }
        tracker.onPush = { [weak self] t, v, n, side in self?.motion.offerPush(t: t, vel: v, n: n, side: side) }
        motion.onSwing = { [weak self] s0 in
            guard let self else { return }
            var s = s0
            // the camera tracking's view of the same swing steadies the hand's part of the path
            // (the integrated acceleration drifts a little; ARKit's position slope doesn't)
            if let pd = self.tracker.paddle(at: s.t), let v0 = s.vel, simd_length(pd.vel) > 0.4 {
                let v = v0 * 0.5 + (pd.vel + (v0 - s.hand)) * 0.5, sp = simd_length(v)
                s = s.with(lift: max(-1, min(1, v.y / max(0.5, sp) * 1.8)),
                           power: min(1, s.power * 0.8 + max(0, min(1, (sp - 1) / 8)) * 0.2))
                s.vel = v
            }
            if let lan = self.lanLink {
                lan.sendSwing(s, vel: s.vel, n: s.n)
            } else {
                var extra = ""
                if let v = s.vel, let n = s.n {
                    extra = String(format: ",vel:[%.3f,%.3f,%.3f],n:[%.3f,%.3f,%.3f]", v.x, v.y, v.z, n.x, n.y, n.z)
                }
                if let h = s.side { extra += ",hand:\(h)" }
                extra += ",id:\(s.id),pre:\(s.pre ? "true" : "false")"
                let js = String(format: "window.__nativeSwing && window.__nativeSwing({power:%.4f,lift:%.4f,face:%.4f,aim:%@,ago:%.4f,peak:%.0f%@})",
                                s.power, s.lift, s.face, s.aim.map { String(format: "%.4f", $0) } ?? "null", s.ago(), s.peak, extra)
                self.web?.evaluateJavaScript(js)
            }
            if s.pre {
                self.pulse = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.pulse = false }
            }
        }
        motion.onPose = { [weak self] sh0, f0, w0, vh0 in
            guard let self, self.live else { return }
            // the camera tracking holds the room still (no heading drift): when it has the phone,
            // its angle is the paddle's and the motion sensors' heading is trued to it; through a
            // fast swing (blurred frames) the motion sensors carry on, trued by the last offset
            var sh = sh0, f = f0
            var pos: SIMD3<Double>? = nil, vel: SIMD3<Double>? = nil
            let now = ProcessInfo.processInfo.systemUptime
            if let ar = self.tracker.pose(now: now) {
                let heading = { (a: SIMD3<Double>, b: SIMD3<Double>) -> Double in
                    let v = a.x * a.x + a.z * a.z > b.x * b.x + b.z * b.z ? a : b
                    return atan2(v.x, v.z)
                }
                var d = heading(ar.face, ar.shaft) - heading(f0, sh0)
                d = atan2(sin(d), cos(d))
                self.yawTrue += atan2(sin(d - self.yawTrue), cos(d - self.yawTrue)) * 0.15
                sh = ar.shaft; f = ar.face; pos = ar.pos; vel = ar.vel
                self.fix = (ar.pos, now, now)
            }
            // the motion sensors' vectors in the camera's room (trued by the heading offset)
            let c = cos(self.yawTrue), s = sin(self.yawTrue)
            let rot = { (v: SIMD3<Double>) in SIMD3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c) }
            let w = rot(w0)
            if pos == nil {
                sh = rot(sh0); f = rot(f0)
                // the camera lost the phone (a blurred whip, a hand over the lens): the motion
                // sensors carry the paddle on from its last fix for a moment, never far from it
                if var fx = self.fix, now - fx.at < 0.6 {
                    let vh = rot(vh0)
                    var p = fx.pos + vh * min(0.05, max(0, now - fx.t))
                    let d = p - (self.lastFixPos ?? fx.pos)
                    if simd_length(d) > 1.2 { p = (self.lastFixPos ?? fx.pos) + simd_normalize(d) * 1.2 }
                    fx.pos = p; fx.t = now
                    self.fix = fx
                    pos = p; vel = vh
                }
            } else { self.lastFixPos = pos }
            if let lan = self.lanLink { lan.sendPose(shaft: sh, face: f, pos: pos, vel: vel, w: w) }
            else {
                var p = pos.map { String(format: ",p:[%.3f,%.3f,%.3f]", $0.x, $0.y, $0.z) } ?? ""
                if let v = vel { p += String(format: ",v:[%.3f,%.3f,%.3f]", v.x, v.y, v.z) }
                p += String(format: ",w:[%.3f,%.3f,%.3f]", w.x, w.y, w.z)
                self.web?.evaluateJavaScript(String(format: "window.__nativeOri && window.__nativeOri({s:[%.3f,%.3f,%.3f],f:[%.3f,%.3f,%.3f]%@})", sh.x, sh.y, sh.z, f.x, f.y, f.z, p))
            }
        }
        tracker.onPos = { [weak self] x, z, vx, vz in
            guard let self else { return }
            if let lan = self.lanLink { lan.sendPos(x: x, z: z, vx: vx, vz: vz) }
            else { self.web?.evaluateJavaScript(String(format: "window.__nativePos && window.__nativePos({x:%.4f,z:%.4f,vx:%.3f,vz:%.3f})", x, z, vx, vz)) }
        }
    }

    /// the TV's address from its QR code, or look for it on the Wi-Fi; no TV app found → the web link
    func begin(room: String, lan: String?) {
        guard mode == .searching, lanLink == nil else { return }
        text = "Looking for the TV…"
        if let lan, let c = lan.lastIndex(of: ":"), let port = NWEndpoint.Port(String(lan[lan.index(after: c)...])) {
            startLan(.hostPort(host: NWEndpoint.Host(String(lan[..<c])), port: port))
            return
        }
        finder.find(code: room, timeout: 2.5) { [weak self] e in
            guard let self else { return }
            if let e { self.startLan(e) } else { self.mode = .web; self.text = "Connecting…" }
        }
    }

    private func startLan(_ e: NWEndpoint) {
        mode = .lan
        text = "Connecting to the TV…"
        var id = UserDefaults.standard.string(forKey: "padId") ?? ""
        if id.isEmpty { id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "padId") }
        let l = LanLink(endpoint: e, id: id, name: "Player")
        lanLink = l
        l.onState = { [weak self] st in
            guard let self else { return }
            switch st {
            case .live: if !self.live { self.note.notificationOccurred(.success) }; self.live = true; self.text = "Paddle ready · swing away"
            case .connecting: self.live = false; self.text = "Reconnecting…"
            case .full: self.live = false; self.text = "Two paddles are already playing"
            }
        }
        l.onMessage = { [weak self] m in self?.fromTV(m) }
        l.start()
        startSensing()
        // keep running locked / in the background
        keepAlive.start()
    }

    /// the TV's messages over the Wi-Fi link
    private func fromTV(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "hit":
            let pw = (m["power"] as? Double) ?? 0.5
            if pw > 0.75 { hard.impactOccurred(intensity: 1) } else { hit.impactOccurred(intensity: 0.85) }
            // the paddle's "pock" from the paddle itself, as the Wii Remote's speaker does
            pock.play(power: pw)
            hit.prepare(); hard.prepare()
        case "point":
            if (m["won"] as? Bool) == true { note.notificationOccurred(.success) }
        case "mode":
            tracking = (m["move"] as? String) == "body" && RoomTracker.supported
        default: break
        }
    }

    private func startSensing() {
        okTimer?.invalidate()
        var bad = 0
        okTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            // (the camera stops when the phone is locked; that's fine, the swings carry on)
            bad = self.tracker.ok || UIApplication.shared.applicationState != .active ? 0 : bad + 1
            let ok = !RoomTracker.supported || bad < 3
            if ok != self.trackOK { self.trackOK = ok }
        }
        motion.start()
        // the camera tracking reads every swing's path and face (and your steps in "you move")
        tracker.start()
        hit.prepare(); hard.prepare()
    }

    func finish() {
        okTimer?.invalidate()
        motion.stop()
        tracker.stop()
        lanLink?.stop()
        lanLink = nil
        keepAlive.stop()
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let t = m["t"] as? String else { return }
        switch t {
        case "start":
            startSensing()
        case "recenter":
            motion.recenter(); tracker.recenter()
        case "track":
            let on = (m["on"] as? Bool) ?? false
            tracking = on && RoomTracker.supported
            if tracking { tracker.start() }
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
    var power: Double
    var lift: Double
    var face: Double
    var aim: Double?
    let peak: Double
    /// CMLogItem timestamp of the peak (seconds since boot)
    let t: TimeInterval
    /// the paddle head's velocity at the peak (m/s) and the hitting face's normal, room frame (x right, y up, z toward the TV)
    var vel: SIMD3<Double>? = nil
    var n: SIMD3<Double>? = nil
    /// the hand's own part of `vel` (without the head's turn about it)
    var hand = SIMD3<Double>(0, 0, 0)
    /// which way the phone turned about the vertical through the swing: +1 forehand, −1 backhand (right-handed)
    var side: Int? = nil
    /// this swing's number, and whether this is the first word of it (sent the instant it starts,
    /// as the Wii Remote does: the TV times the hit on it; the full reading follows at the peak)
    var id = 0
    var pre = false
    func ago() -> Double { max(0, ProcessInfo.processInfo.systemUptime - t) }
    func with(lift: Double? = nil, power: Double? = nil, aim: Double? = nil) -> Swing {
        var s = self
        if let lift { s.lift = lift }
        if let power { s.power = power }
        if let aim { s.aim = aim }
        return s
    }
}

/**
 The phone as a paddle, from CoreMotion's fused motion at 100 Hz, in the room's frame (x right,
 y up, z toward the TV — "toward the TV" is where the back camera pointed when the paddle started:
 you were looking at the screen, facing the TV):

 - a swing starts when the turning rate passes 230°/s, or (a dink, a block) when the paddle head
   pushes toward the net at over 1.1 m/s while turning a little; it ends just after the peak of
   turn rate + head speed, the peak time refined with a parabola through the neighbouring samples
 - the paddle's velocity at the peak: the hand's (the user acceleration integrated through the
   swing, leaking away between swings) plus the paddle head's turn about the hand (ω × r, the head
   ~16 cm beyond the phone's centre along its long edge). Its direction is the swing path — up
   or down across the face is topspin or slice, across it sideways is sidespin (curves)
 - the face: the screen's normal in the room (the back of the phone on a backhand), so its tilt
   (open / closed) and where it points (aim) are absolute, not a drifting integral
 - power from the paddle head's speed against this player's own full swing (learned), with the
   peak turning rate
 */
final class SwingDetector {
    var onSwing: ((Swing) -> Void)?
    /// the phone ~60 a second, room frame: long edge (handle → head), screen normal, turn rate
    /// (rad/s) and the hand's velocity from the motion sensors (m/s, a leaky integral: good over a swing)
    var onPose: ((SIMD3<Double>, SIMD3<Double>, SIMD3<Double>, SIMD3<Double>) -> Void)?
    private var lastPose: TimeInterval = 0
    /// turn about the vertical through the current swing (rad, + = counterclockwise from above)
    private var yawTurn = 0.0
    private let mm = CMMotionManager()
    private let queue = OperationQueue()
    private var swinging = false
    private var cool: TimeInterval = 0
    private struct S { let t: TimeInterval; let g: Double; let e: Double; let v: SIMD3<Double>; let h: SIMD3<Double>; let n: SIMD3<Double> }
    /// this player's full-swing paddle-head speed (m/s), learned from their hard swings
    private var fullSpeed = 6.5
    private var swingId = 0
    private var samples: [S] = []
    private var vHand = SIMD3<Double>(0, 0, 0)
    private var last: TimeInterval = 0
    private let start0 = 230.0
    /// the last moment the phone was turning fast (a swing, its backswing or follow-through)
    private(set) var lastFast: TimeInterval = 0
    /// which way CMAttitude's matrix maps (reference → device, or its transpose), found from gravity
    private var refToDevice: Bool?
    /// "toward the TV" in CoreMotion's reference frame (horizontal)
    private var fwdRef: SIMD3<Double>?
    private var wantCenter = true

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

    /**
     A soft push the camera tracking saw (a dink, a block): a swing of its own unless the motion
     sensors already have this stroke. Power from the hand's speed (a dink's push is 1–1.5 m/s),
     the path and the face as a full swing's.
     */
    func offerPush(t: TimeInterval, vel v: SIMD3<Double>, n: SIMD3<Double>, side: Int?) {
        queue.addOperation {
            // (a full swing running, or one that ended under 0.3 s before this push peaked: it's that one)
            guard !self.swinging, t >= self.cool else { return }
            self.cool = ProcessInfo.processInfo.systemUptime + 0.3
            self.swingId += 1
            let sp = simd_length(v)
            let nf = n.z < 0 ? -n : n
            let s = Swing(power: max(0.04, min(0.45, (sp - 0.3) / 7)),
                          lift: sp > 0.3 ? max(-1, min(1, v.y / sp * 1.8)) : 0,
                          face: n.y,
                          aim: abs(nf.z) > 0.2 ? max(-1.6, min(1.6, atan2(nf.x, nf.z) / (40 * .pi / 180))) : nil,
                          peak: 0, t: t, vel: v, n: nf, hand: v, side: side, id: self.swingId)
            DispatchQueue.main.async { self.onSwing?(s) }
        }
    }

    /// the phone now faces the TV (screen toward you): that's "toward the TV" from here on
    func recenter() { queue.addOperation { self.wantCenter = true } }

    private func step(_ m: CMDeviceMotion) {
        let t = m.timestamp
        let dt = last > 0 ? min(0.05, t - last) : 0.01
        last = t
        let R = m.attitude.rotationMatrix
        let M = simd_double3x3(rows: [SIMD3(R.m11, R.m12, R.m13), SIMD3(R.m21, R.m22, R.m23), SIMD3(R.m31, R.m32, R.m33)])
        let grav = simd_normalize(SIMD3(m.gravity.x, m.gravity.y, m.gravity.z))
        if refToDevice == nil {
            // the reference frame's down, carried both ways: the one that lands on measured gravity
            let a = M * SIMD3(0, 0, -1), b = M.transpose * SIMD3(0, 0, -1)
            refToDevice = simd_dot(a, grav) >= simd_dot(b, grav)
        }
        let toDev = { (v: SIMD3<Double>) -> SIMD3<Double> in self.refToDevice! ? M * v : M.transpose * v }
        let toRef = { (v: SIMD3<Double>) -> SIMD3<Double> in self.refToDevice! ? M.transpose * v : M * v }
        if wantCenter || fwdRef == nil {
            wantCenter = false
            // the back camera's heading (−z of the device); held flat, the top edge's
            var f = toRef(SIMD3(0, 0, -1)); f.z = 0
            if simd_length(f) < 0.25 { f = toRef(SIMD3(0, 1, 0)); f.z = 0 }
            fwdRef = simd_normalize(f)
        }
        // the room's axes as seen from the device
        let up = -grav
        let fwd = toDev(fwdRef!)
        let right = simd_cross(fwd, up)
        let room = { (v: SIMD3<Double>) -> SIMD3<Double> in SIMD3(simd_dot(v, right), simd_dot(v, up), simd_dot(v, fwd)) }
        let w = SIMD3(m.rotationRate.x, m.rotationRate.y, m.rotationRate.z)
        if t - lastPose > 1.0 / 60 - 0.002 {
            lastPose = t
            let sh = room(SIMD3(0, 1, 0)), fc = room(SIMD3(0, 0, 1)), wr = room(w), vh = vHand
            DispatchQueue.main.async { self.onPose?(sh, fc, wr, vh) }
        }
        let g = simd_length(w) * 180 / .pi
        if g > 140 { lastFast = t }
        // the hand: user acceleration integrated, leaking away between swings (it only has to hold a swing)
        let a = room(SIMD3(m.userAcceleration.x, m.userAcceleration.y, m.userAcceleration.z) * 9.81)
        vHand = vHand * exp(-dt / (swinging ? 0.6 : 0.2)) + a * dt
        // the paddle head turning about the hand
        let tip = room(simd_cross(w, SIMD3(0, 0.16, 0)))
        let vHead = vHand + tip, spNow = simd_length(vHead)
        if !swinging {
            samples.removeAll(keepingCapacity: true)
            // a full swing turns the phone fast; a dink or a block barely turns it but pushes the
            // paddle toward the net
            let soft = g > 60 && spNow > 1.1 && vHead.z > 0.7
            // (a take-back turns the phone fast too, but the head goes away from the net: not a swing)
            let forward = vHead.z > -0.2
            if ((g > start0 && forward) || soft) && t > cool { swinging = true; yawTurn = 0 } else { return }
            // the swing has started: say so now (the TV times the hit on this), details at the peak
            swingId += 1
            let n0 = room(SIMD3(0, 0, 1))
            let first = Swing(power: soft ? 0.15 : max(0.25, min(1, 0.3 + (g - start0) / 900)), lift: 0, face: n0.y, aim: nil,
                              peak: g, t: t, id: swingId, pre: true)
            DispatchQueue.main.async { self.onSwing?(first) }
        }
        yawTurn += simd_dot(w, up) * dt
        // how much swing there is: turn rate and head speed together, so soft pushes peak too
        let e = g / 500 + spNow / 4
        samples.append(S(t: t, g: g, e: e, v: vHead, h: vHand, n: room(SIMD3(0, 0, 1))))
        let n = samples.count
        var k = 0
        for i in 1..<n where samples[i].e > samples[k].e { k = i }
        guard n - 1 > k, e < samples[k].e * 0.8 || t - samples[k].t > 0.05 || n > 45 else { return }
        swinging = false
        cool = t + 0.3
        var tPeak = samples[k].t
        if k > 0 && k < n - 1 {
            let y0 = samples[k - 1].e, y1 = samples[k].e, y2 = samples[k + 1].e
            let den = y0 - 2 * y1 + y2
            if den < 0 {
                let off = max(-0.5, min(0.5, 0.5 * (y0 - y2) / den))
                tPeak += off * (samples[k + 1].t - samples[k - 1].t) / 2
            }
        }
        let gPeak = samples.reduce(0) { max($0, $1.g) }
        let pk = samples[k]
        let v = pk.v, sp = simd_length(v)
        // the hitting face points at the TV (the back of the phone on a backhand)
        let nf = pk.n.z < 0 ? -pk.n : pk.n
        let gyroPower = max(0, min(1, (gPeak - start0) / 1350))
        // head speed against this player's own full swing (learned: big swingers and small
        // swingers both reach a drive)
        let speedPower = max(0, min(1, (sp - 0.6) / (fullSpeed - 0.6)))
        if sp > fullSpeed * 0.75 && sp < 25 { fullSpeed = max(4, min(14, fullSpeed * 0.85 + sp * 0.15)) }
        let s = Swing(power: min(1, gyroPower * 0.4 + speedPower * 0.6),
                      lift: sp > 0.5 ? max(-1, min(1, v.y / sp * 1.8)) : 0,
                      face: pk.n.y,
                      aim: abs(nf.z) > 0.2 ? max(-1.6, min(1.6, atan2(nf.x, nf.z) / (40 * .pi / 180))) : nil,
                      peak: gPeak, t: tPeak, vel: v, n: nf, hand: pk.h,
                      side: yawTurn > 0.35 ? 1 : yawTurn < -0.35 ? -1 : nil, id: swingId)
        vHand = .zero
        DispatchQueue.main.async { self.onSwing?(s) }
    }
}
