import SwiftUI
import UIKit
import ImageIO
import WorkbenchCore

/// A read-only browser. All paths stay relative to the selected workspace on the host.
struct WorkspaceFilesView: View {
    @ObservedObject var model: AppModel
    let workspace: Workspace
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WorkspaceDirectoryView(model: model, workspace: workspace, path: "", done: { dismiss() })
        }
    }
}

private struct WorkspaceDirectoryView: View {
    @ObservedObject var model: AppModel
    let workspace: Workspace
    let path: String
    let done: () -> Void
    @State private var listing: DirectoryListing?
    @State private var failure: String?
    @State private var loading = true
    @State private var reload = UUID()
    @State private var loadID = UUID()

    private var entries: [RemoteFile] {
        (listing?.entries ?? []).sorted {
            if ($0.kind == "directory") != ($1.kind == "directory") { return $0.kind == "directory" }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    var body: some View {
        List {
            Section {
                Label("Read-only · \(workspace.name)", systemImage: "lock")
                    .font(.caption).foregroundStyle(.secondary)
                Text(path.isEmpty ? workspace.cwd : workspace.cwd + "/" + path)
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if loading {
                HStack { Spacer(); ProgressView("Loading files…"); Spacer() }.padding(.vertical, 24)
            } else if let failure {
                ContentUnavailableView {
                    Label("Couldn’t load files", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(failure)
                } actions: {
                    Button("Try again") { reload = UUID() }.accessibilityIdentifier("files.retry")
                }.listRowBackground(Color.clear)
            } else if entries.isEmpty {
                ContentUnavailableView("Empty folder", systemImage: "folder", description: Text("There are no files in this folder."))
                    .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(entries) { file in
                        if file.kind == "directory" {
                            NavigationLink {
                                WorkspaceDirectoryView(model: model, workspace: workspace, path: file.path, done: done)
                            } label: {
                                WorkspaceFileRow(file: file)
                            }.accessibilityIdentifier("files.entry.\(file.path)")
                        } else if file.kind == "file" {
                            NavigationLink {
                                WorkspaceFilePreview(model: model, workspace: workspace, file: file, done: done)
                            } label: {
                                WorkspaceFileRow(file: file)
                            }.accessibilityIdentifier("files.entry.\(file.path)")
                        } else {
                            WorkspaceFileRow(file: file).foregroundStyle(.secondary)
                                .accessibilityIdentifier("files.entry.\(file.path)")
                                .accessibilityHint("Links and special files cannot be opened.")
                        }
                    }
                } footer: {
                    if listing?.truncated == true {
                        Text("This folder has more entries than can be shown. Open a subfolder to browse further.")
                    }
                }
            }
        }
        .accessibilityIdentifier("files.list")
        .navigationTitle(path.isEmpty ? "Files" : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
        .task(id: reload) { await load() }
        .refreshable { await load() }
    }

    @MainActor private func load() async {
        let request = UUID()
        loadID = request
        loading = true; failure = nil
        do {
            let result = try await model.listFiles(workspaceId: workspace.id, path: path)
            try Task.checkCancellation()
            guard loadID == request else { return }
            listing = result
        } catch is CancellationError { return }
        catch {
            guard loadID == request else { return }
            failure = error.localizedDescription
        }
        loading = false
    }
}

private struct WorkspaceFileRow: View {
    let file: RemoteFile
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(.tint).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name).lineLimit(2)
                if file.kind == "symlink" {
                    Text("Symbolic link · not opened").font(.caption).foregroundStyle(.secondary)
                } else if file.kind != "directory" && file.kind != "file" {
                    Text("Special file · not opened").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if file.kind == "file" {
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 3)
    }

    private var icon: String {
        switch file.kind {
        case "directory": return "folder"
        case "symlink": return "link"
        default: return WorkspaceFileDecoder.imageExtensions.contains((file.name as NSString).pathExtension.lowercased()) ? "photo" : "doc.text"
        }
    }
}

private struct WorkspaceFilePreview: View {
    @ObservedObject var model: AppModel
    let workspace: Workspace
    let file: RemoteFile
    let done: () -> Void
    @State private var content: WorkspaceFileContent?
    @State private var failure: String?
    @State private var loading = true
    @State private var progress = 0.0
    @State private var reload = UUID()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Read-only", systemImage: "lock")
                Spacer()
                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.vertical, 10)
            Divider()
            if loading {
                VStack(spacing: 14) {
                    ProgressView(value: progress).frame(maxWidth: 220)
                    Text(progress >= 1 ? "Preparing preview…" : "Loading file… \(Int(progress * 100))%")
                        .font(.subheadline).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure {
                ContentUnavailableView {
                    Label("Preview unavailable", systemImage: "doc.questionmark")
                } description: {
                    Text(failure)
                } actions: {
                    Button("Try again") { reload = UUID() }.accessibilityIdentifier("files.preview.retry")
                }.accessibilityIdentifier("files.preview.error")
            } else if let content {
                switch content {
                case .image(let image):
                    ZoomableWorkspaceImage(image: image, name: file.name)
                    Text("Pinch to zoom · double-tap to fit").font(.caption).foregroundStyle(.secondary).padding(10)
                case .text(let text, let truncated):
                    if truncated {
                        Label("Showing the first 256 KiB of this file", systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary).padding(10)
                    }
                    GeometryReader { viewport in
                        ScrollView([.horizontal, .vertical]) {
                            Text(text.isEmpty ? "Empty file" : text)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                                .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
                                .accessibilityIdentifier("files.preview.text")
                                .padding(16)
                                .frame(minWidth: viewport.size.width, minHeight: viewport.size.height, alignment: .topLeading)
                        }
                    }
                }
            }
        }
        .navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
        .task(id: reload) { await load() }
    }

    @MainActor private func load() async {
        loading = true; failure = nil; progress = 0; content = nil
        do {
            guard file.size <= 20 * 1024 * 1024 else {
                throw WorkbenchError.message("Files larger than 20 MiB can’t be previewed on your phone. Open this file on your computer.")
            }
            let data = try await model.readFile(workspaceId: workspace.id, path: file.path) { progress = min(1, max(0, $0)) }
            try Task.checkCancellation()
            progress = 1
            let name = file.name
            let decoded = try await Task.detached(priority: .userInitiated) {
                try WorkspaceFileDecoder.decode(data, name: name)
            }.value
            try Task.checkCancellation()
            content = decoded
        } catch is CancellationError { return }
        catch { failure = error.localizedDescription }
        loading = false
    }
}

private enum WorkspaceFileContent: @unchecked Sendable {
    case image(UIImage)
    case text(String, truncated: Bool)
}

private enum WorkspaceFileDecoder {
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "tif", "tiff", "bmp"]
    static let textLimit = 256 * 1024

    static func decode(_ data: Data, name: String) throws -> WorkspaceFileContent {
        if imageExtensions.contains((name as NSString).pathExtension.lowercased()) {
            // ImageIO decodes a thumbnail, never a full-resolution UIImage. Animated files show their first frame.
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1600,
                    kCGImageSourceShouldCacheImmediately: true
                  ] as CFDictionary) else {
                throw WorkbenchError.message("This image could not be decoded. It may be damaged or use an unsupported image format.")
            }
            return .image(UIImage(cgImage: thumbnail))
        }
        let truncated = data.count > textLimit
        let prefix = Data(data.prefix(textLimit))
        let isUTF16 = prefix.starts(with: [0xFF, 0xFE]) || prefix.starts(with: [0xFE, 0xFF])
        let encoding: String.Encoding = isUTF16 ? .utf16 : .utf8
        var text = String(data: prefix, encoding: encoding)
        // A byte limit can cut a UTF-8 codepoint or UTF-16 surrogate pair in half.
        if text == nil && truncated {
            for count in 1...3 where !isUTF16 || count == 2 {
                text = String(data: prefix.dropLast(count), encoding: encoding)
                if text != nil { break }
            }
        }
        guard var text, !text.unicodeScalars.contains(where: {
            ($0.value < 32 && ![9, 10, 12, 13].contains($0.value)) || $0.value == 127
        }) else {
            throw WorkbenchError.message("This is a binary file or uses an unsupported text encoding. Preview supports UTF-8/UTF-16 text and PNG, JPEG, GIF, HEIC, WebP, TIFF, and BMP images.")
        }
        if text.first == "\u{FEFF}" { text.removeFirst() }
        return .text(text, truncated: truncated)
    }
}

private struct ZoomableWorkspaceImage: UIViewRepresentable {
    let image: UIImage
    let name: String

    func makeUIView(context: Context) -> WorkspaceImageScrollView {
        WorkspaceImageScrollView(image: image, name: name)
    }

    func updateUIView(_ view: WorkspaceImageScrollView, context: Context) {}
}

private final class WorkspaceImageScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView: UIImageView
    private var previousBounds = CGSize.zero

    init(image: UIImage, name: String) {
        imageView = UIImageView(image: image)
        super.init(frame: .zero)
        delegate = self
        contentInsetAdjustmentBehavior = .never
        backgroundColor = .clear
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        imageView.frame = CGRect(origin: .zero, size: image.size)
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = name
        imageView.accessibilityIdentifier = "files.preview.image"
        addSubview(imageView)
        contentSize = image.size
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(resetZoom))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let image = imageView.image, bounds.width > 0, bounds.height > 0 else { return }
        if previousBounds != bounds.size {
            let relativeZoom = zoomScale / max(minimumZoomScale, 0.0001)
            previousBounds = bounds.size
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            maximumZoomScale = max(fit * 8, 1)
            minimumZoomScale = fit
            zoomScale = min(maximumZoomScale, fit * max(1, relativeZoom))
        }
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

    private func centerImage() {
        let insetX = max(0, (bounds.width - contentSize.width) / 2)
        let insetY = max(0, (bounds.height - contentSize.height) / 2)
        let next = UIEdgeInsets(top: insetY, left: insetX, bottom: insetY, right: insetX)
        if contentInset != next { contentInset = next }
    }

    @objc private func resetZoom() { setZoomScale(minimumZoomScale, animated: true) }
}
