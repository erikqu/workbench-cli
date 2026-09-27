import SwiftUI
import AVFoundation
import WorkbenchCore

struct PairingView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var manual = ""
    @State private var scanning = true
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                if let pairing = model.pairing {
                    Image(systemName: "desktopcomputer").font(.largeTitle).foregroundStyle(.green)
                    Text("Pair your development machine").font(.title2.bold())
                    Text("Relay: \(pairing.relay)").font(.footnote).foregroundStyle(.secondary)
                    if let code = model.pairingCode {
                        Text(code).font(.system(size: 44, weight: .medium, design: .monospaced)).frame(maxWidth: .infinity).padding(.vertical)
                        Text("Enter this code in the companion’s terminal to approve this iPhone.")
                        HStack { ProgressView(); Text("Waiting for confirmation…").font(.footnote) }
                    } else if model.login == nil {
                        if model.pairingAuthentication {
                            Text("This one-time code securely signs in this iPhone and binds it to Supernova.")
                            Button("Continue with secure pairing") { Task { await model.signInWithPairing() } }
                                .buttonStyle(.borderedProminent).disabled(model.claiming)
                        } else {
                            Text("Sign in with Apple first, then return here to finish pairing.")
                            Button("Continue to sign-in") { dismiss() }.buttonStyle(.borderedProminent)
                        }
                    } else {
                        Text("This gives your iPhone access to the Workbench sessions running on this machine.")
                        Button("Pair this machine") { Task { await model.claimPairing() } }.buttonStyle(.borderedProminent).disabled(model.claiming)
                    }
                    Spacer()
                } else {
                    Text("Scan the companion’s QR code").font(.title2.bold())
                    Text("Run setup on your development machine, then point the camera at its pairing code.").foregroundStyle(.secondary)
                    if scanning { QRScanner { model.receivePairing($0); scanning = false }.clipShape(RoundedRectangle(cornerRadius: 16)).frame(minHeight: 230) }
                    Text("Or paste a pairing link").font(.subheadline.bold())
                    TextField("workbench-remote://pair?…", text: $manual, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                    Button("Use pairing link") { model.receivePairing(manual) }.disabled(manual.isEmpty)
                    Spacer()
                }
            }.padding(24).navigationTitle("Add machine").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .onChange(of: model.status) { _, value in if value == "Machine paired" { dismiss() } }
                .alert("Pairing", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController { ScannerController(found: found) }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) { controller.stop() }
}
final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "workbench.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false
    private var stopped = false // Accessed only on the camera queue.
    private let found: (String) -> Void
    init(found: @escaping (String) -> Void) { self.found = found; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else { DispatchQueue.main.async { self.showMessage("Camera access is unavailable. Paste the pairing link below instead.") }; return }
            queue.async { self.configure() }
        }
    }
    private func configure() {
        guard !stopped else { return }
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }; session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
        DispatchQueue.main.async {
            let layer = AVCaptureVideoPreviewLayer(session: self.session); layer.videoGravity = .resizeAspectFill; layer.frame = self.view.bounds
            self.view.layer.addSublayer(layer); self.preview = layer
        }
        session.startRunning()
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        delivered = true; stop(); found(value)
    }
    func stop() { queue.async { self.stopped = true; self.session.stopRunning() } }
    private func showMessage(_ message: String) { let label = UILabel(frame: view.bounds); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; label.text = message; label.textColor = .white; label.numberOfLines = 0; label.textAlignment = .center; view.addSubview(label) }
}
