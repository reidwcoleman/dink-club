import ARKit

/**
 The phone in the room, from ARKit's world tracking (camera + motion sensors fused, the way AR
 apps work; no image is shown or kept). Two jobs:

 - **where you stand** (for "you move"): the phone's position on the floor plane relative to where
   tracking was centred — x to the right, z toward the TV — through a One-Euro filter (smooth when
   still, quick when you step), and held while a swing whips the hand around, so a stroke doesn't
   drag the player across the court. Reported with its velocity so the TV can lead the link delay.
 - **the paddle at contact**: a short history of the phone's position and screen direction, so a
   swing found by the motion sensors can be given the phone's real 3D velocity at its peak (the
   swing path: brushing up, chopping down, across) and the face's direction in the room.

 "Toward the TV" is the way the back camera pointed when centring (you look at the screen then,
 facing the TV).
 */
final class RoomTracker: NSObject, ARSessionDelegate {
    /// filtered body position (m) and velocity (m/s), room frame
    var onPos: ((Double, Double, Double, Double) -> Void)?
    /// the last time the swing detector saw a fast rotation (holds the body estimate)
    var lastFast: () -> TimeInterval = { 0 }

    private let session = ARSession()
    private var running = false
    private var origin: simd_float3?
    private var fwd = simd_float3(0, 0, -1)
    private var right = simd_float3(1, 0, 0)
    private var wantCenter = true
    private var lastSent: TimeInterval = 0
    private var prevT: TimeInterval = 0
    private let lock = NSLock()
    private struct Sample { let t: TimeInterval; let p: simd_float3; let n: simd_float3 }
    private var hist: [Sample] = []
    private var fx = OneEuro(), fz = OneEuro()
    private var px = OneEuro(minCutoff: 3, beta: 1.5), py = OneEuro(minCutoff: 3, beta: 1.5), pz = OneEuro(minCutoff: 3, beta: 1.5)
    private var latest: (t: TimeInterval, pos: SIMD3<Double>, shaft: SIMD3<Double>, face: SIMD3<Double>)?
    private var body: (x: Double, z: Double)?
    private var vel = (x: 0.0, z: 0.0)
    private(set) var ok = false

    static var supported: Bool { ARWorldTrackingConfiguration.isSupported }

    func start() {
        guard RoomTracker.supported, !running else { return }
        running = true
        session.delegate = self
        session.delegateQueue = DispatchQueue(label: "room-tracker", qos: .userInteractive)
        let cfg = ARWorldTrackingConfiguration()
        cfg.worldAlignment = .gravity
        cfg.isLightEstimationEnabled = false
        session.run(cfg, options: [.resetTracking])
        wantCenter = true
    }

    func stop() {
        guard running else { return }
        running = false
        session.pause()
    }

    /** the next frame becomes the centre, facing the TV */
    func recenter() { wantCenter = true }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let normal: Bool
        if case .normal = frame.camera.trackingState { normal = true } else { normal = false }
        ok = normal
        guard normal else { return }
        let m = frame.camera.transform
        let p = simd_float3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let t = frame.timestamp
        if wantCenter || origin == nil {
            wantCenter = false
            origin = p
            // the back camera looks along −z of the camera frame
            var f = simd_float3(-m.columns.2.x, 0, -m.columns.2.z)
            if simd_length(f) < 0.25 { f = simd_float3(m.columns.1.x, 0, m.columns.1.z) } // held flat: the top edge
            fwd = simd_normalize(f)
            right = simd_float3(-fwd.z, 0, fwd.x)
            body = nil
            fx = OneEuro(); fz = OneEuro()
            px = OneEuro(minCutoff: 3, beta: 1.5); py = OneEuro(minCutoff: 3, beta: 1.5); pz = OneEuro(minCutoff: 3, beta: 1.5)
        }
        guard let o = origin else { return }
        // the paddle history: position and the screen's outward normal (+z of the camera frame)
        let n = simd_normalize(simd_float3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
        // the paddle now (the phone is the paddle): where it is and how it's turned, in the room
        // frame, the position through a light One-Euro (it should follow a swing, not lag it)
        do {
            let dd = p - o
            let toRoom = { (v: simd_float3) -> SIMD3<Double> in SIMD3(Double(simd_dot(v, self.right)), Double(v.y), Double(simd_dot(v, self.fwd))) }
            let rp = toRoom(dd)
            let pos = SIMD3(px.filter(rp.x, t), py.filter(rp.y, t), pz.filter(rp.z, t))
            let sh = toRoom(simd_float3(m.columns.1.x, m.columns.1.y, m.columns.1.z))
            let fc = toRoom(simd_float3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
            lock.lock()
            latest = (t, pos, sh, fc)
            lock.unlock()
        }
        lock.lock()
        hist.append(Sample(t: t, p: p, n: n))
        if hist.count > 90 { hist.removeFirst(hist.count - 90) }
        lock.unlock()
        // where you stand: held through a swing (and a beat after), filtered otherwise
        defer { prevT = t }
        let d = p - o
        let rx = Double(simd_dot(d, right)), rz = Double(simd_dot(d, fwd))
        if t - lastFast() > 0.3 || body == nil {
            let x = fx.filter(rx, t), z = fz.filter(rz, t)
            if let b = body {
                let dt = max(1.0 / 120, min(0.1, t - prevT))
                let k = min(1, dt / 0.08)
                vel.x += ((x - b.x) / dt - vel.x) * k
                vel.z += ((z - b.z) / dt - vel.z) * k
            }
            body = (x, z)
        } else {
            vel = (vel.x * 0.8, vel.z * 0.8)
        }
        guard let b = body, t - lastSent > 1.0 / 60.0 else { return }
        lastSent = t
        let v = vel
        DispatchQueue.main.async { self.onPos?(b.x, b.z, v.x, v.z) }
    }

    /// the phone right now from the camera tracking (position, long edge, screen normal; room
    /// frame), or nil if tracking has no fresh frame (a fast swing blurs it, the phone is locked)
    func pose(now: TimeInterval) -> (pos: SIMD3<Double>, shaft: SIMD3<Double>, face: SIMD3<Double>)? {
        lock.lock()
        let l = latest
        lock.unlock()
        guard ok, let l, now - l.t < 0.08 else { return nil }
        return (l.pos, l.shaft, l.face)
    }

    /// the paddle around time `t` (CMLogItem / ARFrame clock): velocity and face normal in the room
    /// frame (x right, y up, z toward the TV); nil if tracking had no frames then
    func paddle(at t: TimeInterval) -> (vel: SIMD3<Double>, n: SIMD3<Double>)? {
        lock.lock()
        let h = hist
        lock.unlock()
        // frames from 70 ms before the peak up to it: the velocity is their least-squares slope
        let w = h.filter { $0.t >= t - 0.07 && $0.t <= t + 0.012 }
        guard w.count >= 3, let last = w.last else { return nil }
        let tm = w.reduce(0.0) { $0 + $1.t } / Double(w.count)
        var num = simd_double3(0, 0, 0), den = 0.0
        let pm = w.reduce(simd_double3(0, 0, 0)) { $0 + simd_double3($1.p) } / Double(w.count)
        for s in w {
            let dt = s.t - tm
            num += (simd_double3(s.p) - pm) * dt
            den += dt * dt
        }
        guard den > 1e-6 else { return nil }
        let vw = num / den
        let room = { (v: simd_double3) -> SIMD3<Double> in
            SIMD3(simd_dot(v, simd_double3(self.right)), v.y, simd_dot(v, simd_double3(self.fwd)))
        }
        return (room(vw), room(simd_double3(last.n)))
    }
}

/// One-Euro filter (Casiez et al.): a low-pass whose cutoff rises with speed — steady when still, no lag when moving
struct OneEuro {
    var minCutoff = 1.4, beta = 0.6, dCutoff = 1.0
    init(minCutoff: Double = 1.4, beta: Double = 0.6) { self.minCutoff = minCutoff; self.beta = beta }
    private var x: Double?
    private var dx = 0.0
    private var t: TimeInterval = 0
    private func alpha(_ cutoff: Double, _ dt: Double) -> Double {
        let tau = 1 / (2 * .pi * cutoff)
        return 1 / (1 + tau / dt)
    }
    mutating func filter(_ v: Double, _ now: TimeInterval) -> Double {
        guard let px = x else { x = v; t = now; return v }
        let dt = max(1e-3, now - t)
        t = now
        let ad = alpha(dCutoff, dt)
        dx += ad * ((v - px) / dt - dx)
        let a = alpha(minCutoff + beta * abs(dx), dt)
        let nx = px + a * (v - px)
        x = nx
        return nx
    }
}
