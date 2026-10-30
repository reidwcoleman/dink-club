import SwiftUI
import AVFoundation

/// The front door: the TV's code, scanned or typed. That's all it asks.
struct JoinView: View {
    @ObservedObject var session: Session
    @State private var code = ""
    @State private var scanning = false
    @State private var error = ""

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.23, green: 0.12, blue: 0.27), Color(red: 0.07, green: 0.06, blue: 0.1)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            ScrollView {
                VStack(spacing: 18) {
                    Image("Logo").resizable().scaledToFit().frame(maxWidth: 260)
                        .shadow(color: .black.opacity(0.5), radius: 16, y: 8)
                        .padding(.top, 24)
                    Text("Your phone is the paddle")
                        .font(.system(size: 26, weight: .heavy, design: .rounded))
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan the code on the TV", systemImage: "qrcode.viewfinder")
                            .font(.system(size: 19, weight: .bold, design: .rounded))
                            .frame(maxWidth: .infinity).padding(.vertical, 18)
                            .background(LinearGradient(colors: [Color(red: 1, green: 0.7, blue: 0.29), Color(red: 1, green: 0.54, blue: 0.12), Color(red: 1, green: 0.31, blue: 0.55)], startPoint: .leading, endPoint: .trailing))
                            .foregroundStyle(Color(red: 0.1, green: 0.07, blue: 0.03))
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    field("TV code", text: $code, caps: true)
                        .onChange(of: code) { v in code = String(v.uppercased().filter { $0.isLetter }.prefix(4)) }
                    Button("Join") { join(code) }
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(Color.white.opacity(code.count == 4 ? 0.16 : 0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .disabled(code.count != 4)
                    if !error.isEmpty { Text(error).foregroundStyle(.red.opacity(0.85)).font(.footnote) }
                    Text("Open reidwcoleman.github.io/dink-club on the TV to get a code.")
                        .font(.footnote).foregroundStyle(.white.opacity(0.55)).multilineTextAlignment(.center)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 30)
            }
        }
        .sheet(isPresented: $scanning) {
            ScannerSheet { text in
                scanning = false
                if let c = Session.code(from: text) { session.lan = Session.lan(from: text); join(c) } else { error = "That code isn't a Dink Club TV code." }
            }
        }
    }

    private func join(_ c: String) {
        session.room = c
    }

    private func field(_ title: String, text: Binding<String>, caps: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.6)).tracking(1.2)
            TextField(title, text: text)
                .textInputAutocapitalization(caps ? .characters : .words)
                .autocorrectionDisabled()
                .font(.system(size: caps ? 24 : 18, weight: caps ? .heavy : .semibold, design: .rounded))
                .padding(12)
                .background(Color.white.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}

// MARK: - QR scanner

struct ScannerSheet: View {
    let onCode: (String) -> Void
    var body: some View {
        ZStack(alignment: .bottom) {
            ScannerView(onCode: onCode).ignoresSafeArea()
            Text("Point at the QR code on the TV")
                .font(.headline).padding(14).background(.ultraThinMaterial, in: Capsule()).padding(.bottom, 40)
        }
    }
}

struct ScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        return c
    }
    func updateUIViewController(_ vc: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var done = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else { return }
        session.addInput(input)
        let out = AVCaptureMetadataOutput()
        guard session.canAddOutput(out) else { return }
        session.addOutput(out)
        out.setMetadataObjectsDelegate(self, queue: .main)
        out.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.first?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objs: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !done, let s = (objs.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        done = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(s)
    }
}
