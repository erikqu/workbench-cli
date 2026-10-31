import SwiftUI
import WorkbenchCore

/// Browses host directories without creating, opening, or changing a workspace.
struct HostFolderPicker: View {
    @ObservedObject var model: AppModel
    let selected: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var editingPath: Bool
    @State private var requestedPath: String
    @State private var pathInput: String
    @State private var listing: FolderListing?
    @State private var loading = true
    @State private var failure: String?
    @State private var loadToken = UUID()

    init(model: AppModel, initialPath: String, selected: @escaping (String) -> Void) {
        self.model = model
        self.selected = selected
        let path = initialPath
        _requestedPath = State(initialValue: path.isEmpty ? "~" : path)
        _pathInput = State(initialValue: path.isEmpty ? "~" : path)
    }

    private var enteredPath: String { pathInput }
    private var canSelect: Bool {
        guard model.connected, !loading, failure == nil, let listing else { return false }
        return !listing.path.isEmpty && listing.path != "/" && enteredPath == listing.path
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        TextField("Absolute path or ~", text: $pathInput)
                            .font(.subheadline.monospaced())
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.go).focused($editingPath)
                            .accessibilityIdentifier("folders.path")
                            .onSubmit { if !enteredPath.isEmpty { go(to: enteredPath) } }
                        Button("Go") { go(to: enteredPath) }
                            .buttonStyle(.borderless)
                            .disabled(enteredPath.isEmpty).accessibilityIdentifier("folders.go")
                    }
                    HStack {
                        Button { go(to: "~") } label: { Label("Home", systemImage: "house") }
                            .accessibilityIdentifier("folders.home")
                        Spacer()
                        Button {
                            if let parent = listing?.parentPath { go(to: parent) }
                        } label: { Label("Up", systemImage: "arrow.up") }
                            .disabled(loading || failure != nil || listing?.parentPath == nil)
                            .accessibilityIdentifier("folders.up")
                    }.buttonStyle(.borderless)
                } header: {
                    Text(model.activeMachine?.name ?? "Your computer")
                } footer: {
                    Text("Browse folders on your computer. Nothing is created or changed here.")
                }

                Section {
                    Text(listing?.path ?? requestedPath)
                        .font(.subheadline.monospaced()).textSelection(.enabled)
                        .accessibilityIdentifier("folders.current")
                    if loading {
                        HStack { Spacer(); ProgressView("Loading folders…"); Spacer() }
                            .padding(.vertical, 20)
                    } else if let failure {
                        ContentUnavailableView {
                            Label("Couldn’t load folders", systemImage: "folder.badge.questionmark")
                        } description: {
                            Text(failure)
                        } actions: {
                            Button("Try again") { go(to: requestedPath) }
                                .accessibilityIdentifier("folders.retry")
                        }.listRowBackground(Color.clear)
                    } else if let listing {
                        if listing.entries.isEmpty {
                            ContentUnavailableView("No subfolders", systemImage: "folder", description: Text("You can use this folder or browse another location."))
                                .listRowBackground(Color.clear)
                        } else {
                            ForEach(listing.entries.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { folder in
                                Button { go(to: folder.path) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "folder").foregroundStyle(.tint)
                                        Text(folder.name).foregroundStyle(.primary).lineLimit(2)
                                        Spacer(minLength: 8)
                                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    }.padding(.vertical, 4)
                                }
                                .accessibilityLabel(folder.name)
                                .accessibilityHint("Browse this folder")
                                .accessibilityIdentifier("folders.entry.\(folder.path)")
                            }
                        }
                    }
                } header: { Text("Current folder") } footer: {
                    if listing?.truncated == true {
                        Text("This folder has more entries than can be shown. Enter a full path above to browse a folder that is not listed.")
                    } else if listing?.path == "/" {
                        Text("Choose a folder inside the filesystem root.")
                    } else if !loading, failure == nil, let listing, enteredPath != listing.path {
                        Text("Tap Go to validate the path before choosing it.")
                    }
                }
            }
            .navigationTitle("Choose a folder").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    guard canSelect, let path = listing?.path else { return }
                    selected(path)
                    dismiss()
                } label: {
                    Label("Use this folder", systemImage: "folder.badge.checkmark")
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!canSelect).accessibilityIdentifier("folders.select")
                .padding().background(.bar)
            }
            .task(id: loadToken) { await load() }
        }
    }

    private func go(to path: String) {
        guard !path.isEmpty else { return }
        editingPath = false
        requestedPath = path
        pathInput = path
        listing = nil
        failure = nil
        loading = true
        loadToken = UUID()
    }

    @MainActor private func load() async {
        let request = loadToken
        do {
            let result = try await model.listFolders(path: requestedPath)
            try Task.checkCancellation()
            guard request == loadToken else { return }
            listing = result
            if pathInput == requestedPath { pathInput = result.path }
            failure = nil
            loading = false
        } catch is CancellationError { return }
        catch {
            guard request == loadToken, !Task.isCancelled else { return }
            listing = nil
            failure = error.localizedDescription
            loading = false
        }
    }
}
