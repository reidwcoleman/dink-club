import ARKit

/**
 Where the phone is in the room, for "you move": ARKit's world tracking (camera + motion
 sensors, the same thing AR apps use) gives the phone's position to a centimetre or so. Positions
 are reported on the floor plane relative to where tracking was centred: x to the right and z
 toward the TV. "Toward the TV" is the way the back camera pointed when centring — the player is
 looking at the screen then, facing the TV. No camera image is shown or kept.
 */
final class RoomTracker: NSObject, ARSessionDelegate {
    var onPos: ((Double, Double) -> Void)?
    private let session = ARSession()
    private var running = false
    private var origin: simd_float3?
    private var fwd = simd_float3(0, 0, -1)
    private var right = simd_float3(1, 0, 0)
    private var wantCenter = true
    private var lastSent: TimeInterval = 0

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
        guard case .normal = frame.camera.trackingState else { return }
        let m = frame.camera.transform
        let p = simd_float3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        if wantCenter || origin == nil {
            wantCenter = false
            origin = p
            // the back camera looks along −z of the camera frame
            var f = simd_float3(-m.columns.2.x, 0, -m.columns.2.z)
            if simd_length(f) < 0.25 { f = simd_float3(m.columns.1.x, 0, m.columns.1.z) } // held flat: the top edge
            fwd = simd_normalize(f)
            right = simd_float3(-fwd.z, 0, fwd.x)
        }
        let t = frame.timestamp
        guard t - lastSent > 1.0 / 30.0, let o = origin else { return }
        lastSent = t
        let d = p - o
        let x = Double(simd_dot(d, right)), z = Double(simd_dot(d, fwd))
        DispatchQueue.main.async { self.onPos?(x, z) }
    }
}
