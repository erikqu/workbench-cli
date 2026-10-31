import XCTest
@testable import WorkbenchCore

final class SessionNavigationTests: XCTestCase {
    func testSessionPresentationDoesNotInventAgentState() throws {
        func pane(_ activity: String?, live: Bool = true, kind: String = "agent") throws -> Pane {
            let value: [String: Any] = ["id": "a", "tmux": "a", "name": "Agent", "kind": kind, "live": live, "activity": activity as Any? ?? NSNull()]
            return try JSONDecoder().decode(Pane.self, from: JSONSerialization.data(withJSONObject: value))
        }
        XCTAssertEqual(try pane("working").statusLabel(connected: false), "Offline")
        XCTAssertEqual(try pane("working", live: false).statusLabel(connected: true), "Stopped")
        XCTAssertEqual(try pane("working").statusLabel(connected: true), "Working")
        XCTAssertEqual(try pane("recent").statusLabel(connected: true), "Recent output")
        XCTAssertEqual(try pane("waiting").statusLabel(connected: true), "Needs input")
        XCTAssertEqual(try pane("idle").statusLabel(connected: true), "Quiet")
        XCTAssertEqual(try pane(nil).statusLabel(connected: true), "Running")
        XCTAssertEqual(try pane("idle", kind: "terminal").statusLabel(connected: true), "Running")
    }
    func testAddingSessionKeepsWorkspaceAndDeduplicatesIdentity() throws {
        let original = try workspaces()[0], pane = try workspaces()[1].panes[0]
        let added = original.addingSession(pane)
        XCTAssertEqual(added.id, original.id)
        XCTAssertEqual(added.cwd, original.cwd)
        XCTAssertEqual(added.panes.count, original.panes.count + 1)
        XCTAssertEqual(added.addingSession(pane), added)
    }
    func testRemovalKeepsWorkspaceAndSiblingSessions() throws {
        let original = try workspaces()[0]
        let removed = original.removingSession("codex")
        XCTAssertEqual(removed.panes.map(\.id), ["stopped", "shell"])
        XCTAssertEqual(removed.cwd, original.cwd)
        XCTAssertEqual(removed.id, original.id)
        XCTAssertEqual(removed.name, original.name)
        XCTAssertEqual(removed.removingSession("missing"), removed)
        XCTAssertTrue(removed.removingSession("stopped").removingSession("shell").panes.isEmpty)
    }
    private func workspaces() throws -> [Workspace] {
        try JSONDecoder().decode([Workspace].self, from: Data(#"[{"id":"one","name":"One","cwd":"/one","panes":[{"id":"codex","name":"Codex","tmux":"codex","kind":"agent","live":true},{"id":"stopped","name":"Stopped","tmux":"stopped","kind":"agent","live":false},{"id":"shell","name":"Terminal","tmux":"shell","kind":"terminal","live":true}]},{"id":"two","name":"Two","cwd":"/two","panes":[{"id":"claude","name":"Claude","tmux":"claude","kind":"agent","live":true},{"id":"codex","name":"Duplicate","tmux":"codex","kind":"agent","live":true}]}]"#.utf8))
    }

    func testCyclesAcrossWorkspacesAndWrapsWithoutStoppedOrDuplicatePanes() throws {
        let workspaces = try workspaces()
        XCTAssertEqual(SessionNavigation.livePanes(in: workspaces).map(\.id), ["codex", "shell", "claude"])
        XCTAssertEqual(SessionNavigation.next(in: workspaces, after: nil)?.id, "codex")
        XCTAssertEqual(SessionNavigation.next(in: workspaces, after: "codex")?.id, "shell")
        XCTAssertEqual(SessionNavigation.next(in: workspaces, after: "shell")?.id, "claude")
        XCTAssertEqual(SessionNavigation.next(in: workspaces, after: "claude")?.id, "codex")
        XCTAssertEqual(SessionNavigation.next(in: workspaces, after: "removed")?.id, "codex")
    }

    func testEmptyAndSingleSession() throws {
        XCTAssertNil(SessionNavigation.next(in: [], after: nil))
        let workspace = try JSONDecoder().decode(Workspace.self, from: Data(#"{"id":"one","name":"One","cwd":"/one","panes":[{"id":"only","name":"Terminal","tmux":"only","kind":"terminal","live":true}]}"#.utf8))
        XCTAssertEqual(SessionNavigation.next(in: [workspace], after: "only")?.id, "only")
        let stopped = try JSONDecoder().decode(Workspace.self, from: Data(#"{"id":"off","name":"Off","cwd":"/off","panes":[{"id":"dead","name":"Stopped","tmux":"dead","kind":"agent","live":false}]}"#.utf8))
        XCTAssertNil(SessionNavigation.next(in: [stopped], after: "dead"))
    }
}
