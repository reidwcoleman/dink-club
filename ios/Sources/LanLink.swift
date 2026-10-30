import Foundation
import Network

/**
 The paddle's own line to the TV app on the home Wi-Fi: JSON datagrams over UDP (Network.framework),
 the same messages the web pad sends over WebRTC. It needs no web page, so it keeps working with
 the phone locked or in another app (the app stays alive on a silent audio session).

 - finding the TV: Bonjour (`_dinkclub._udp`, the TV advertises its room code), or the address
   the TV put in its QR code
 - joining: `hello` until the TV answers `welcome`
 - clock: the TV pings every second; the pong carries this phone's clock (seconds since boot, the
   clock CoreMotion stamps samples with), so a swing's peak time converts exactly to the TV's
 - swings go twice, 12 ms apart, with an id the TV dedupes (UDP may drop one)
 */
final class LanLink {
    enum State { case connecting, live, full }
    var onState: ((State) -> Void)?
    var onMessage: (([String: Any]) -> Void)?

    private let conn: NWConnection
    private let q = DispatchQueue(label: "lan-link", qos: .userInteractive)
    private let id: String
    private let name: String
    private var live = false
    private var lastHeard: TimeInterval = 0
    private var sid = Int.random(in: 0..<1_000_000)
    private var timer: DispatchSourceTimer?

    init(endpoint: NWEndpoint, id: String, name: String) {
        self.id = id
        self.name = name
        let params = NWParameters.udp
        params.serviceClass = .interactiveVoice
        conn = NWConnection(to: endpoint, using: params)
    }

    func start() {
        conn.stateUpdateHandler = { [weak self] st in
            if case .ready = st { self?.hello() }
        }
        conn.start(queue: q)
        receive()
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        send(["t": "bye"])
        timer?.cancel()
        conn.cancel()
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        // the TV pings every second: three missed and we start over
        if live && now - lastHeard > 3.5 { live = false; DispatchQueue.main.async { self.onState?(.connecting) } }
        if !live { hello() }
    }

    private func hello() {
        send(["t": "hello", "id": id, "name": name, "paddle": 0])
    }

    private func receive() {
        conn.receiveMessage { [weak self] data, _, _, err in
            guard let self else { return }
            if let data, let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { self.handle(m) }
            if err == nil { self.receive() }
        }
    }

    private func handle(_ m: [String: Any]) {
        lastHeard = ProcessInfo.processInfo.systemUptime
        switch m["t"] as? String {
        case "welcome":
            if !live { live = true; DispatchQueue.main.async { self.onState?(.live) } }
        case "full":
            DispatchQueue.main.async { self.onState?(.full) }
        case "ping":
            if !live { live = true; DispatchQueue.main.async { self.onState?(.live) } }
            send(["t": "pong", "k": m["k"] ?? 0, "tp": ProcessInfo.processInfo.systemUptime])
            return
        default: break
        }
        DispatchQueue.main.async { self.onMessage?(m) }
    }

    func send(_ m: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: m) else { return }
        conn.send(content: d, completion: .contentProcessed { _ in })
    }

    /// a swing, twice
    func sendSwing(_ s: Swing, vel: SIMD3<Double>?, n: SIMD3<Double>?) {
        sid += 1
        var m: [String: Any] = ["t": "swing", "sid": sid, "power": s.power, "lift": s.lift, "face": s.face, "peak": s.peak, "tp": s.t]
        if let a = s.aim { m["aim"] = a }
        if let v = vel { m["vel"] = [v.x, v.y, v.z] }
        if let n { m["n"] = [n.x, n.y, n.z] }
        send(m)
        q.asyncAfter(deadline: .now() + 0.012) { self.send(m) }
    }

    func sendPos(x: Double, z: Double, vx: Double, vz: Double) {
        send(["t": "pos", "x": x, "z": z, "vx": vx, "vz": vz])
    }
}

/// finds Dink Club TVs on the Wi-Fi (Bonjour), by room code
final class TVFinder {
    private var browser: NWBrowser?

    func find(code: String, timeout: TimeInterval, done: @escaping (NWEndpoint?) -> Void) {
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_dinkclub._udp", domain: nil), using: .udp)
        browser = b
        var finished = false
        let finish = { (e: NWEndpoint?) in
            if finished { return }
            finished = true
            b.cancel()
            DispatchQueue.main.async { done(e) }
        }
        b.browseResultsChangedHandler = { results, _ in
            for r in results {
                var match = false
                if case let .bonjour(txt) = r.metadata, txt["code"]?.uppercased() == code.uppercased() { match = true }
                if case let .service(name, _, _, _) = r.endpoint, name.uppercased().hasSuffix(code.uppercased()) { match = true }
                if match { finish(r.endpoint); return }
            }
        }
        b.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }
}
