import SwiftUI
import UIKit
import SwiftTerm
import Combine
import WorkbenchCore

struct TerminalScreen: View {
    @ObservedObject var model: AppModel
    let pane: Pane
    @State private var composing = false
    @State private var settings = false
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(model.connected ? Color.green : Color.orange).frame(width: 6, height: 6)
                Text(model.status).font(.caption).lineLimit(2)
                Spacer()
                if model.connected && model.sessionState?.writable == false {
                    Button("Take control") { Task { await model.takeControl() } }.font(.caption.bold())
                }
            }.padding(12).background(Color.white.opacity(0.04))
            if model.sessionState?.localAttached == true {
                Text("Also open locally · swipe sideways to see the full terminal")
                    .font(.caption2).foregroundStyle(.secondary).padding(6)
            }
            NativeTerminal(model: model).background(Color(red: 0.06, green: 0.08, blue: 0.07))
            if !model.connected {
                Button("Reconnect") { if let machine = model.activeMachine { model.connect(machine) } }
                    .buttonStyle(.bordered).padding(8).disabled(model.connecting)
            }
        }
        .navigationTitle(pane.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { composing = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose instructions")
                Button { settings = true } label: { Image(systemName: "textformat.size") }.accessibilityLabel("Terminal font size")
            }
        }
        .task { await model.open(pane) }
        .onDisappear { model.leaveTerminal() }
        .sheet(isPresented: $composing) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Draft instructions, then send them to this session.").font(.subheadline).foregroundStyle(.secondary)
                    TextEditor(text: $model.draft).font(.system(.body, design: .monospaced)).autocorrectionDisabled()
                    Text("Unsent drafts stay on this iPhone. Check the terminal before resending after a connection loss.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding().navigationTitle("Compose")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Done") { model.saveDraft(); composing = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Send") { Task { await model.sendDraft(); if model.draft.isEmpty { composing = false } } }
                                .disabled(model.draft.isEmpty || !model.connected || model.sessionState?.writable != true)
                        }
                    }
            }.onDisappear { model.saveDraft() }
        }
        .sheet(isPresented: $settings) {
            VStack(alignment: .leading, spacing: 20) {
                Text("Terminal text size").font(.headline)
                Slider(value: $model.fontSize, in: 10...22, step: 1)
                Text("\(Int(model.fontSize)) pt").font(.system(.body, design: .monospaced))
            }.padding(24).presentationDetents([.height(180)])
        }
    }
}

struct NativeTerminal: UIViewControllerRepresentable {
    @ObservedObject var model: AppModel
    func makeUIViewController(context: Context) -> TerminalController { TerminalController(model: model) }
    func updateUIViewController(_ controller: TerminalController, context: Context) { controller.refreshLayout() }
}

@MainActor final class TerminalController: UIViewController, TerminalViewDelegate {
    private let model: AppModel
    private let viewport = UIScrollView()
    private let terminal = TerminalView(frame: .zero)
    private var cancellables = Set<AnyCancellable>()
    private var controlNext = false
    private var layingOut = false
    private var lastRequestedSize = ""
    init(model: AppModel) { self.model = model; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(viewport); viewport.addSubview(terminal)
        viewport.alwaysBounceHorizontal = false
        viewport.keyboardDismissMode = .interactive
        terminal.terminalDelegate = self
        terminal.nativeBackgroundColor = UIColor(red: 0.06, green: 0.08, blue: 0.07, alpha: 1)
        terminal.nativeForegroundColor = UIColor(red: 0.86, green: 0.90, blue: 0.84, alpha: 1)
        terminal.getTerminal().changeScrollback(10_000)
        let toolbar = UIToolbar(); toolbar.sizeToFit()
        let keys: [(String, String)] = [("Esc", "\u{1b}"), ("Tab", "\t"), ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("←", "\u{1b}[D"), ("→", "\u{1b}[C"), ("^C", "\u{3}"), ("↵", "\r")]
        toolbar.items = keys.map { title, value in
            UIBarButtonItem(title: title, primaryAction: UIAction { [weak self] _ in self?.model.send(Data(value.utf8)) })
        } + [UIBarButtonItem(title: "Ctrl", primaryAction: UIAction { [weak self] _ in self?.controlNext.toggle() })]
        terminal.inputAccessoryView = toolbar
        model.output.sink { [weak self] data in
            guard let self else { return }
            terminal.feed(byteArray: Array(data)[...]); model.bracketedPaste = terminal.getTerminal().bracketedPasteMode
        }.store(in: &cancellables)
        model.resetTerminal.sink { [weak self] in self?.terminal.feed(text: "\u{1b}c") }.store(in: &cancellables)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); refreshLayout() }
    func refreshLayout() {
        guard isViewLoaded, !layingOut, view.bounds.width > 0, view.bounds.height > 0 else { return }
        layingOut = true; defer { layingOut = false }
        let font = UIFont.monospacedSystemFont(ofSize: model.fontSize, weight: .regular)
        if terminal.font.pointSize != font.pointSize { terminal.font = font }
        viewport.frame = view.bounds
        let advance = ("M" as NSString).size(withAttributes: [.font: font]).width
        let state = model.sessionState
        let fixed = state.map { $0.localAttached || !$0.writable } ?? false
        let width = fixed ? max(view.bounds.width, CGFloat(state!.cols) * advance + 4) : view.bounds.width
        let height = fixed ? max(view.bounds.height, CGFloat(state!.rows) * font.lineHeight + 4) : view.bounds.height
        let frame = CGRect(x: 0, y: 0, width: width, height: height)
        if terminal.frame != frame { terminal.frame = frame }
        viewport.contentSize = frame.size
        if fixed, let state { terminal.resize(cols: state.cols, rows: state.rows) }
        else if model.sessionState?.writable == true {
            let dimensions = terminal.getTerminal().getDims()
            sizeChanged(source: terminal, newCols: dimensions.cols, newRows: dimensions.rows)
        }
    }
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        var bytes = Array(data)
        if controlNext, bytes.count == 1, let first = bytes.first, first >= 64, first <= 127 { bytes[0] = first & 0x1f; controlNext = false }
        model.send(Data(bytes))
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard model.sessionState?.localAttached != true, model.sessionState?.writable == true else { return }
        let key = "\(newCols):\(newRows)"
        guard key != lastRequestedSize else { return }; lastRequestedSize = key
        model.resize(cols: newCols, rows: newRows)
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        // OSC 52 is remote-controlled; require an explicit user action before replacing the clipboard.
        guard let text = String(data: content, encoding: .utf8), presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Copy from remote session?", message: "The terminal requested to copy \(text.count) characters.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Copy", style: .default) { _ in UIPasteboard.general.string = text })
        present(alert, animated: true)
    }
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), let scheme = url.scheme, ["https", "http"].contains(scheme), presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Open link?", message: url.absoluteString, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open", style: .default) { _ in UIApplication.shared.open(url) })
        present(alert, animated: true)
    }
}
