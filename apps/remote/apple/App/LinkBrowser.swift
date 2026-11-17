import SwiftUI
import Combine
import WebKit
import WorkbenchCore

@MainActor final class LinkBrowser: ObservableObject {
    @Published private(set) var tabs: [LinkBrowserTab] = []
    @Published var selectedID: UUID?
    let opened = PassthroughSubject<Void, Never>()
    private let dataStore = WKWebsiteDataStore.nonPersistent()
    var selected: LinkBrowserTab? { tabs.first { $0.id == selectedID } }

    @discardableResult func open(_ link: String) -> Bool {
        guard let url = WebLink.url(link) else { return false }
        let tab = LinkBrowserTab(url: url, dataStore: dataStore, browser: self)
        tabs.append(tab)
        selectedID = tab.id
        opened.send()
        return true
    }
    func close(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].webView.stopLoading()
        tabs.remove(at: index)
        if selectedID == id { selectedID = tabs.isEmpty ? nil : tabs[min(index, tabs.count - 1)].id }
    }
    func closeAll() { for tab in tabs { tab.webView.stopLoading() }; tabs = []; selectedID = nil }
}

@MainActor final class LinkBrowserTab: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id = UUID()
    let initialURL: URL
    let webView: WKWebView
    private weak var browser: LinkBrowser?
    var title: String { webView.title?.isEmpty == false ? webView.title! : (webView.url?.host ?? initialURL.host ?? "Web page") }

    init(url: URL, dataStore: WKWebsiteDataStore, browser: LinkBrowser) {
        initialURL = url
        self.browser = browser
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(WebLink.url(action.request.url?.absoluteString ?? "") == nil ? .cancel : .allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url { browser?.open(url.absoluteString) }
        return nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { browser?.objectWillChange.send() }
}

struct LinkBrowserView: View {
    @ObservedObject var browser: LinkBrowser
    @Environment(\.dismiss) private var dismiss
    @State private var newTab = false
    @State private var address = ""
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(browser.tabs) { tab in
                            HStack(spacing: 0) {
                                Button { browser.selectedID = tab.id } label: {
                                    Text(tab.title).lineLimit(1).frame(maxWidth: 180).padding(.horizontal, 10).frame(minHeight: 44)
                                }.accessibilityIdentifier("browser.tab.\(tab.id)")
                                Button { browser.close(tab.id) } label: { Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle()) }
                                    .accessibilityLabel("Close \(tab.title)").accessibilityIdentifier("browser.close.\(tab.id)")
                            }.buttonStyle(.plain)
                                .background(browser.selectedID == tab.id ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                                .id(tab.id)
                        }
                    }.padding(6)
                }
                .onAppear { if let id = browser.selectedID { reader.scrollTo(id, anchor: .trailing) } }
                .onChange(of: browser.selectedID) { _, id in if let id { reader.scrollTo(id, anchor: .trailing) } }
                }
                if let tab = browser.selected {
                    BrowserWebView(webView: tab.webView).id(tab.id)
                } else {
                    ContentUnavailableView("No browser tabs", systemImage: "globe", description: Text("Open a terminal link or add a tab."))
                }
            }
            .navigationTitle(browser.selected?.webView.url?.host ?? "Browser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done", systemImage: "xmark") { dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("New tab", systemImage: "plus") { address = ""; newTab = true }.accessibilityIdentifier("browser.newTab")
                    Button("Open in Safari", systemImage: "safari") {
                        if let tab = browser.selected { UIApplication.shared.open(tab.webView.url ?? tab.initialURL) }
                    }.disabled(browser.selected == nil)
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Back", systemImage: "chevron.left") { browser.selected?.webView.goBack() }.disabled(browser.selected?.webView.canGoBack != true)
                    Button("Forward", systemImage: "chevron.right") { browser.selected?.webView.goForward() }.disabled(browser.selected?.webView.canGoForward != true)
                    Button("Reload", systemImage: "arrow.clockwise") { browser.selected?.webView.reload() }.disabled(browser.selected == nil)
                }
            }
            .alert("New browser tab", isPresented: $newTab) {
                TextField("https://example.com", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Open") { browser.open(address) }.disabled(WebLink.url(address) == nil)
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}

private struct BrowserWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
