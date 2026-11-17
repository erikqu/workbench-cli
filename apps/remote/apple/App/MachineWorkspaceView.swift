import SwiftUI
import WorkbenchCore

/// Keep the terminal in the split view's detail column as Duo changes displays.
/// The system adapts these columns around reserved regions, including the fold.
struct MachineWorkspaceView: View {
    @ObservedObject var model: AppModel
    let machine: Machine
    var onBack: () -> Void = {}
    @State private var selectedPane: Pane?
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            WorkspaceList(model: model, machine: machine, selectPane: select)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Computers", systemImage: "chevron.backward", action: onBack)
                            .accessibilityIdentifier("workspace.computers")
                    }
                }
        } detail: {
            if let selectedPane {
                TerminalScreen(model: model, pane: selectedPane)
            } else {
                ContentUnavailableView("Choose a session", systemImage: "terminal",
                    description: Text("Select an agent or terminal from your workspaces."))
            }
        }
        .navigationSplitViewStyle(.balanced)
        .task {
            if model.isPreview, selectedPane == nil,
               !["--workspace-list-preview", "--workspace-activity-preview", "--session-cycle-preview", "--saved-workspaces-preview"].contains(where: ProcessInfo.processInfo.arguments.contains),
               let pane = model.workspaces.first?.panes.first { select(pane) }
        }
        .onChange(of: model.activePane?.id) { _, id in
            if let pane = model.activePane, id != selectedPane?.id { selectedPane = pane }
        }
        .onChange(of: model.workspaces) { _, workspaces in
            if let pane = selectedPane, !workspaces.contains(where: { $0.panes.contains(where: { $0.id == pane.id }) }) {
                selectedPane = model.nextSession(after: pane.id)
                compactColumn = selectedPane == nil ? .sidebar : .detail
            }
        }
    }

    private func select(_ pane: Pane) {
        selectedPane = pane
        compactColumn = .detail
    }
}
