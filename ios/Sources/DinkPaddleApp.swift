import SwiftUI

/// Dink Club — the phone is the paddle. Join a TV by scanning its code (or typing it), then the
/// paddle screen (the web pad, which talks to the TV) runs with this app's own 100 Hz motion
/// sensing and the iPhone's haptic engine.
@main
struct DinkPaddleApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            Group {
                if let room = session.room {
                    PaddleView(room: room) { session.room = nil }
                } else {
                    JoinView(session: session)
                }
            }
            .preferredColorScheme(.dark)
            .onOpenURL { session.open($0) }
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

/// who is playing and which TV they're joining (remembered between launches)
final class Session: ObservableObject {
    @Published var room: String?
    @Published var name: String = UserDefaults.standard.string(forKey: "name") ?? "" {
        didSet { UserDefaults.standard.set(name, forKey: "name") }
    }
    @Published var paddle: Int = UserDefaults.standard.integer(forKey: "paddle") {
        didSet { UserDefaults.standard.set(paddle, forKey: "paddle") }
    }

    /// a room code from anything: "ABCD", a pad.html?room=ABCD link, or dinkclub://join?room=ABCD
    static func code(from text: String) -> String? {
        if let comps = URLComponents(string: text), let r = comps.queryItems?.first(where: { $0.name == "room" })?.value {
            let c = r.uppercased().filter { $0.isLetter }
            if c.count == 4 { return c }
        }
        let letters = text.uppercased().filter { $0.isLetter }
        return letters.count == 4 ? letters : nil
    }

    func open(_ url: URL) {
        if let c = Session.code(from: url.absoluteString) { room = c }
    }
}
