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
    @State private var keyboardShown = false
    private var workspaceName: String {
        model.workspaces.first { workspace in workspace.panes.contains { $0.id == pane.id } }?.name ?? "Terminal"
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(model.connected && !model.isPreview ? Color.green : Color.orange).frame(width: 6, height: 6)
                Text(model.status).font(.caption).lineLimit(2)
                Spacer()
                if model.connected && model.sessionState?.writable == false {
                    Button("Take control") { Task { await model.takeControl() } }.font(.caption.bold())
                }
            }.padding(12).background(Color.white.opacity(0.04))
            if let state = model.sessionState, state.localAttached {
                HStack(spacing: 8) {
                    Text(state.phoneLayout ? "Phone layout" : "Desktop layout · \(state.cols) × \(state.rows)")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Button(state.phoneLayout ? "Desktop size" : "Fit to iPhone") {
                        Task { await model.setPhoneLayout(!state.phoneLayout) }
                    }
                    .font(.caption2.bold())
                    .disabled(!state.writable)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
            }
            NativeTerminal(model: model).background(Color(red: 0.06, green: 0.08, blue: 0.07))
            if !model.connected || model.sessionState == nil {
                Button("Reconnect") { if model.connected { Task { await model.open(pane) } } else if let machine = model.activeMachine { model.connect(machine) } }
                    .buttonStyle(.bordered).padding(8).disabled(model.connecting)
            }
            HStack {
                Button { model.keyboardVisibility.send(!keyboardShown) } label: {
                    Label(keyboardShown ? "Hide keyboard" : "Keyboard", systemImage: keyboardShown ? "keyboard.chevron.compact.down" : "keyboard")
                }.accessibilityIdentifier("terminal.keyboard")
                Spacer()
                Button { model.keyboardVisibility.send(false); composing = true } label: {
                    Label("Compose", systemImage: "square.and.pencil")
                }.accessibilityIdentifier("terminal.compose")
            }
            .font(.subheadline.weight(.medium)).padding(.horizontal, 16).frame(height: 44)
            .background(Color.white.opacity(0.04))
        }
        .navigationTitle(workspaceName).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.keyboardVisibility.send(false); settings = true } label: {
                    HStack(spacing: 5) { Image(systemName: "line.3.horizontal"); Text("Menu") }
                }
                .accessibilityIdentifier("terminal.menu")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardShown = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardShown = false }
        .task { await model.open(pane) }
        .onDisappear { model.leaveTerminal() }
        .sheet(isPresented: $composing) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Draft instructions, then send them to this session.").font(.subheadline).foregroundStyle(.secondary)
                    TextEditor(text: $model.draft).font(.system(.body, design: .monospaced)).autocorrectionDisabled()
                        .accessibilityIdentifier("terminal.draft")
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
            NavigationStack {
                Form {
                    Section("Text size") {
                        Slider(value: $model.fontSize, in: 10...22, step: 1).accessibilityLabel("Terminal text size")
                        Text("\(Int(model.fontSize)) pt").font(.system(.body, design: .monospaced))
                    }
                    if let state = model.sessionState, state.localAttached {
                        Section {
                            Button(state.phoneLayout ? "Use desktop layout" : "Fit to iPhone") {
                                Task { await model.setPhoneLayout(!state.phoneLayout) }
                            }.disabled(!state.writable)
                        } header: { Text("Layout") } footer: {
                            Text("Phone layout also changes the terminal on your computer while enabled. Leaving the session restores its previous sizing setting.")
                        }
                    }
                }.navigationTitle("Terminal menu").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { settings = false } } }
            }.presentationDetents([.medium, .large])
        }
    }
}

struct NativeTerminal: UIViewControllerRepresentable {
    @ObservedObject var model: AppModel
    func makeUIViewController(context: Context) -> TerminalController { TerminalController(model: model) }
    func updateUIViewController(_ controller: TerminalController, context: Context) { controller.refreshLayout() }
}

@MainActor final class TerminalController: UIViewController, @preconcurrency TerminalViewDelegate {
    private let model: AppModel
    private let viewport = UIScrollView()
    private let terminal = ScrollFirstTerminalView(frame: .zero)
    private var cancellables = Set<AnyCancellable>()
    private var controlNext = false
    private weak var controlButton: UIButton?
    private var layingOut = false
    private var lastRequestedSize = ""
    init(model: AppModel) { self.model = model; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(viewport); viewport.addSubview(terminal)
        let background = UIColor(red: 0.06, green: 0.08, blue: 0.07, alpha: 1)
        view.backgroundColor = background
        viewport.backgroundColor = background
        viewport.isDirectionalLockEnabled = true
        viewport.contentInsetAdjustmentBehavior = .never
        viewport.showsVerticalScrollIndicator = true
        viewport.keyboardDismissMode = .interactive
        viewport.panGestureRecognizer.require(toFail: terminal.mouseScrollGesture)
        terminal.terminalDelegate = self
        terminal.backgroundColor = background
        terminal.contentInsetAdjustmentBehavior = .never
        terminal.showsHorizontalScrollIndicator = false
        terminal.nativeBackgroundColor = background
        terminal.nativeForegroundColor = UIColor(red: 0.86, green: 0.90, blue: 0.84, alpha: 1)
        terminal.getTerminal().changeScrollback(10_000)
        terminal.accessibilityIdentifier = "terminal.content"
        terminal.inputAccessoryView = makeKeyboardAccessory()
        model.output.sink { [weak self] data in
            guard let self else { return }
            terminal.feed(byteArray: Array(data)[...]); model.bracketedPaste = terminal.getTerminal().bracketedPasteMode
        }.store(in: &cancellables)
        model.resetTerminal.sink { [weak self] in
            guard let self else { return }
            lastRequestedSize = ""
            controlNext = false
            updateControlButton()
            viewport.contentOffset = .zero
            terminal.feed(text: "\u{1b}c")
            refreshLayout()
        }.store(in: &cancellables)
        model.keyboardVisibility.sink { [weak self] visible in
            if visible { _ = self?.terminal.becomeFirstResponder() } else { _ = self?.terminal.resignFirstResponder() }
        }.store(in: &cancellables)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Metal keeps glyphs pixel-aligned while a large desktop-sized terminal is panned.
        try? terminal.setUseMetal(true)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); refreshLayout() }
    private func makeKeyboardAccessory() -> UIView {
        let accessory = UIInputView(frame: CGRect(x: 0, y: 0, width: 0, height: 48), inputViewStyle: .keyboard)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = false
        accessory.addSubview(scroll)

        let stack = UIStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 2
        scroll.addSubview(stack)

        let keys: [(String, String?)] = [
            ("Esc", "\u{1b}"), ("Tab", "\t"), ("Ctrl", nil),
            ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("←", "\u{1b}[D"), ("→", "\u{1b}[C"),
            ("^C", "\u{3}"), ("↵", "\r")
        ]
        for (title, value) in keys {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.setTitleColor(.label, for: .normal)
            button.titleLabel?.font = .monospacedSystemFont(ofSize: 14, weight: .semibold)
            button.backgroundColor = .secondarySystemFill
            button.layer.cornerRadius = 8
            button.accessibilityLabel = title == "↵" ? "Return" : title
            button.widthAnchor.constraint(equalToConstant: title.count > 1 ? 44 : 36).isActive = true
            button.heightAnchor.constraint(equalToConstant: 44).isActive = true
            if let value {
                button.addAction(UIAction { [weak self] _ in self?.model.send(Data(value.utf8)) }, for: .touchUpInside)
            } else {
                controlButton = button
                button.addAction(UIAction { [weak self] _ in
                    guard let self else { return }
                    controlNext.toggle()
                    updateControlButton()
                }, for: .touchUpInside)
            }
            stack.addArrangedSubview(button)
        }

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: accessory.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: accessory.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: accessory.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: accessory.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 5),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -5),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 2),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -2),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor, constant: -4)
        ])
        return accessory
    }
    private func updateControlButton() {
        controlButton?.backgroundColor = controlNext ? UIColor.systemGreen.withAlphaComponent(0.38) : .secondarySystemFill
        controlButton?.accessibilityValue = controlNext ? "On for next key" : "Off"
    }
    func refreshLayout() {
        guard isViewLoaded, !layingOut, view.bounds.width > 0, view.bounds.height > 0 else { return }
        layingOut = true; defer { layingOut = false }
        let font = UIFont.monospacedSystemFont(ofSize: model.fontSize, weight: .regular)
        if terminal.font.pointSize != font.pointSize { terminal.font = font }
        viewport.frame = view.bounds
        let padding = UIEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        let availableSize = CGSize(
            width: max(1, view.bounds.width - padding.left - padding.right),
            height: max(1, view.bounds.height - padding.top - padding.bottom)
        )
        let state = model.sessionState
        let fixed = state.map { ($0.localAttached && !$0.phoneLayout) || !$0.writable } ?? false
        let terminalSize: CGSize
        if fixed, let state {
            terminal.resize(cols: state.cols, rows: state.rows)
            // SwiftTerm pixel-snaps its own cell measurements. Its optimal frame is the
            // only size guaranteed to map the remote grid to whole local cells.
            terminalSize = terminal.getOptimalFrameSize().size
        } else {
            let grid = terminal.getTerminal().getDims()
            let optimal = terminal.getOptimalFrameSize().size
            let cellWidth = optimal.width / CGFloat(max(1, grid.cols))
            let cellHeight = optimal.height / CGFloat(max(1, grid.rows))
            let cols = max(2, Int(availableSize.width / max(1, cellWidth)))
            let rows = max(1, Int(availableSize.height / max(1, cellHeight)))
            terminal.resize(cols: cols, rows: rows)
            // Do not leave a partial row beneath the cursor after rotation or
            // keyboard resizing; both modes use whole terminal cells.
            terminalSize = terminal.getOptimalFrameSize().size
        }
        let frame = CGRect(x: padding.left, y: padding.top, width: terminalSize.width, height: terminalSize.height)
        if terminal.frame != frame { terminal.frame = frame }
        // Apply UIKit's pending bounds resize before reading the terminal grid.
        terminal.layoutIfNeeded()
        viewport.contentSize = CGSize(
            width: max(view.bounds.width, terminalSize.width + padding.left + padding.right),
            height: max(view.bounds.height, terminalSize.height + padding.top + padding.bottom)
        )
        viewport.alwaysBounceHorizontal = fixed
        viewport.showsHorizontalScrollIndicator = fixed
        viewport.showsVerticalScrollIndicator = fixed && terminalSize.height > view.bounds.height
        if !fixed { viewport.contentOffset = .zero }
        let dimensions = terminal.getTerminal().getDims()
        if !fixed { model.terminalSize = (dimensions.cols, dimensions.rows) }
        if !fixed, model.sessionState?.writable == true {
            requestSize(cols: dimensions.cols, rows: dimensions.rows)
        }
    }
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        var bytes = Array(data)
        if controlNext, bytes.count == 1, let first = bytes.first, first >= 64, first <= 127 {
            bytes[0] = first & 0x1f
            controlNext = false
            updateControlButton()
        }
        model.send(Data(bytes))
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard !layingOut else { return }
        requestSize(cols: newCols, rows: newRows)
    }
    private func requestSize(cols newCols: Int, rows newRows: Int) {
        guard let state = model.sessionState, (!state.localAttached || state.phoneLayout), state.writable else { return }
        let key = "\(state.sessionId):\(state.phoneLayout):\(newCols):\(newRows)"
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
