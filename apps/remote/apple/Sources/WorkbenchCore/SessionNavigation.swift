import Foundation

public enum SessionNavigation {
    /// Host order is stable even when the overview promotes working workspaces.
    public static func livePanes(in workspaces: [Workspace]) -> [Pane] {
        var seen = Set<String>()
        return workspaces.flatMap(\.panes).filter { $0.live && seen.insert($0.id).inserted }
    }

    public static func next(in workspaces: [Workspace], after sessionID: String?) -> Pane? {
        let panes = livePanes(in: workspaces)
        guard !panes.isEmpty else { return nil }
        guard let sessionID, let index = panes.firstIndex(where: { $0.id == sessionID }) else { return panes[0] }
        return panes[(index + 1) % panes.count]
    }
}
