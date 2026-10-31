import XCTest

final class TerminalUITests: XCTestCase {
    @MainActor func testCurrentSessionStoppingOffersNewStartInsteadOfReconnect() {
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--stop-after-open-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["terminal.recoverStopped"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Reconnect"].exists)
        app.buttons["terminal.recoverStopped"].tap()
        XCTAssertTrue(app.buttons["session.start.confirm"].waitForExistence(timeout: 5))
        app.buttons["session.start.confirm"].tap()
        XCTAssertFalse(app.buttons["terminal.recoverStopped"].exists)
        XCTAssertEqual(app.buttons["terminal.tab.workbench_h_preview"].value as? String, "Not selected, Stopped")
    }
    @MainActor func testCreateEmptyWorkspaceThenStartAgent() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--workspace-list-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["workspace.new"].waitForExistence(timeout: 15))
        app.buttons["workspace.new"].tap()
        app.textFields["workspace.name"].tap()
        app.textFields["workspace.name"].typeText("empty-phone")
        let choice = app.buttons["workspace.agent"]
        reveal(choice, in: app)
        choice.tap()
        app.buttons["Workspace only"].tap()
        app.buttons["workspace.create"].tap()
        let header = app.staticTexts.matching(NSPredicate(format: "label == 'empty-phone' AND identifier BEGINSWITH 'workspace.header.'")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["terminal.menu"].exists, "Empty workspaces must not navigate to a phantom terminal")
        capture("29-empty-workspace-start")
        let workspaceID = String(header.identifier.dropFirst("workspace.header.".count))
        let start = app.buttons["workspace.start.empty.\(workspaceID)"]
        XCTAssertTrue(start.isHittable)
        start.tap()
        XCTAssertTrue(app.buttons["session.start.confirm"].waitForExistence(timeout: 5))
        capture("30-start-agent")
        app.buttons["session.start.confirm"].tap()
        XCTAssertTrue(app.navigationBars["empty-phone"].waitForExistence(timeout: 5))
        let agent = app.buttons.matching(NSPredicate(format: "label == 'Codex' AND identifier BEGINSWITH 'terminal.tab.'")).firstMatch
        XCTAssertEqual(agent.value as? String, "Selected, Quiet")
        XCTAssertTrue(app.buttons["terminal.files"].isHittable)
        app.buttons["terminal.files"].tap()
        XCTAssertTrue(app.buttons["files.entry.README.md"].waitForExistence(timeout: 5))
        let firstFile = app.buttons["files.entry.images"]
        XCTAssertLessThan(firstFile.frame.minY, app.frame.height * 0.3, "Files should begin near the compact path bar")
        capture("31-compact-file-browser")
        firstFile.tap()
        app.buttons["files.path"].tap()
        app.buttons["empty-phone"].tap()
        XCTAssertTrue(app.buttons["files.entry.README.md"].waitForExistence(timeout: 5), "Breadcrumb returns to workspace root")
    }

    @MainActor func testStoppedSessionRecoveryAndStartFromTerminalMenu() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--session-cycle-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        app.buttons["workspace.pastSessions"].tap()
        let stopped = app.buttons["workspace.pane.workbench_h_cycle_stopped"]
        XCTAssertTrue(stopped.waitForExistence(timeout: 15))
        stopped.tap()
        XCTAssertTrue(app.buttons["session.start.confirm"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(stopped.exists)
        stopped.tap()
        app.buttons["session.start.confirm"].tap()
        XCTAssertTrue(app.navigationBars["Project Alpha"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["terminal.tab.workbench_h_cycle_stopped"].exists, "Starting keeps the stopped session")
        XCTAssertTrue(app.buttons["terminal.tab.workbench_h_cycle_codex"].exists, "Starting keeps other live sessions")
        let firstNew = app.buttons.matching(NSPredicate(format: "label == 'Codex' AND identifier BEGINSWITH 'terminal.tab.'")).firstMatch
        let firstNewID = firstNew.identifier
        app.buttons["terminal.menu"].tap()
        app.buttons["terminal.startSession"].tap()
        XCTAssertTrue(app.buttons["session.start.confirm"].waitForExistence(timeout: 5), "Menu must dismiss before presenting start")
        app.buttons["session.start.agent"].tap()
        app.buttons["Claude"].tap()
        app.buttons["session.start.confirm"].tap()
        let claude = app.buttons.matching(NSPredicate(format: "label == 'Claude' AND identifier BEGINSWITH 'terminal.tab.'")).firstMatch
        XCTAssertTrue(claude.waitForExistence(timeout: 5))
        XCTAssertEqual(claude.value as? String, "Selected, Quiet")
        XCTAssertNotEqual(claude.identifier, firstNewID)
        capture("32-started-claude-session")
    }

    @MainActor func testDeleteStoppedAndRunningSessionsFromOverview() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--session-cycle-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        app.buttons["workspace.pastSessions"].tap()
        let stopped = "workbench_h_cycle_stopped"
        XCTAssertTrue(app.buttons["workspace.actions.\(stopped)"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["workspace.pane.\(stopped)"].isEnabled, "Stopped sessions offer a new start")
        app.buttons["workspace.actions.\(stopped)"].tap()
        app.buttons["session.delete.\(stopped)"].tap()
        XCTAssertTrue(app.buttons["session.delete.confirm"].firstMatch.waitForExistence(timeout: 3))
        capture("26-delete-confirmation")
        app.buttons["session.delete.cancel"].firstMatch.tap()
        XCTAssertTrue(app.buttons["workspace.actions.\(stopped)"].exists)
        app.buttons["workspace.actions.\(stopped)"].tap()
        app.buttons["session.delete.\(stopped)"].tap()
        app.buttons["session.delete.confirm"].firstMatch.tap()
        XCTAssertFalse(app.buttons["workspace.actions.\(stopped)"].exists)
        let codex = "workbench_h_cycle_codex"
        app.buttons["workspace.pane.\(codex)"].swipeLeft()
        app.buttons["session.delete.\(codex)"].tap()
        XCTAssertTrue(app.buttons["session.delete.confirm"].firstMatch.exists, "Swiping must not delete without confirmation")
        app.buttons["session.delete.confirm"].firstMatch.tap()
        XCTAssertFalse(app.buttons["workspace.actions.\(codex)"].exists)
        XCTAssertTrue(app.buttons["workspace.pane.workbench_h_cycle_claude"].exists, "Other workspaces must not change")
        app.buttons["workspace.terminals.cycle-alpha"].tap()
        app.buttons["session.delete.workbench_t_cycle"].tap()
        app.buttons["session.delete.confirm"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["workspace.header.cycle-alpha"].exists)
        XCTAssertTrue(app.buttons["workspace.files.cycle-alpha"].isHittable)
        XCTAssertFalse(app.buttons["workspace.terminals.cycle-alpha"].exists)
        capture("27-empty-workspace-files-kept")
    }

    @MainActor func testDeleteCurrentSessionSwitchesAndLastDeletionReturnsToWorkspace() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["terminal.menu"].waitForExistence(timeout: 15))
        app.buttons["terminal.menu"].tap()
        XCTAssertTrue(app.navigationBars["Terminal menu"].waitForExistence(timeout: 3))
        let deleteAgent = app.buttons["session.delete.workbench_h_preview"]
        for _ in 0..<4 {
            if deleteAgent.exists && deleteAgent.isHittable { break }
            app.collectionViews.element(boundBy: max(0, app.collectionViews.count - 1)).swipeUp()
        }
        XCTAssertTrue(deleteAgent.isHittable, "Scroll the Terminal menu to its Sessions section")
        deleteAgent.tap()
        app.buttons["session.delete.confirm"].firstMatch.tap()
        let shell = app.buttons["terminal.tab.workbench_t_preview"]
        XCTAssertTrue(shell.waitForExistence(timeout: 5))
        XCTAssertEqual(shell.value as? String, "Selected, Running")
        XCTAssertFalse(app.buttons["terminal.tab.workbench_h_preview"].exists)
        capture("28-delete-active-session")
        app.buttons["terminal.menu"].tap()
        XCTAssertTrue(app.navigationBars["Terminal menu"].waitForExistence(timeout: 3))
        let deleteShell = app.buttons["session.delete.workbench_t_preview"]
        for _ in 0..<4 {
            if deleteShell.exists && deleteShell.isHittable { break }
            app.collectionViews.element(boundBy: max(0, app.collectionViews.count - 1)).swipeUp()
        }
        XCTAssertTrue(deleteShell.isHittable)
        deleteShell.tap()
        app.buttons["session.delete.confirm"].firstMatch.tap()
        app.buttons["workspace.pastSessions"].tap()
        XCTAssertTrue(app.staticTexts["workspace.header.preview"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["workspace.files.preview"].isHittable)
        app.buttons["workspace.files.preview"].tap()
        XCTAssertTrue(app.buttons["files.entry.README.md"].waitForExistence(timeout: 5), "Deleting every session must keep workspace files accessible")
    }

    @MainActor func testTerminalOnlyWorkspaceRemainsAccessible() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--workspace-list-preview", "--terminal-only-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let shortcut = app.buttons["workspace.terminals.shell-only"]
        XCTAssertTrue(shortcut.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["workspace.pane.workbench_t_shell_only"].exists)
        capture("25-terminal-only-overview")
        shortcut.tap()
        app.buttons["workspace.terminal.workbench_t_shell_only"].tap()
        XCTAssertTrue(app.navigationBars["Shell workspace"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["terminal.tab.workbench_t_shell_only"].exists)
    }

    @MainActor func testOverviewShowsLiveSessionsBeforePastSessions() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--saved-workspaces-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.staticTexts["workspace.header.cycle-alpha"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["workspace.header.cycle-beta"].exists)
        let gitChanges = app.descendants(matching: .any)["workspace.git.cycle-alpha"].firstMatch
        XCTAssertTrue(gitChanges.waitForExistence(timeout: 5))
        XCTAssertEqual(gitChanges.value as? String, "42 added lines, 13 deleted lines, 2 untracked files")
        XCTAssertFalse(app.staticTexts["workspace.header.saved-project"].exists)
        XCTAssertFalse(app.buttons["workspace.pane.workbench_h_cycle_stopped"].exists)
        capture("33-live-workspace-groups")
        app.buttons["workspace.pastSessions"].tap()
        XCTAssertTrue(app.staticTexts["workspace.header.saved-project"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["workspace.pane.workbench_h_cycle_stopped"].exists)
        capture("34-past-sessions")
    }

    @MainActor func testBrowseAndOpenExistingWorkspace() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--workspace-list-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["workspace.new"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["workspace.pane.workbench_t_preview"].exists, "Machine overview lists coding harnesses, not shell rows")
        app.buttons["workspace.new"].tap()
        app.buttons["workspace.browseParent"].tap()
        XCTAssertTrue(app.buttons["folders.home"].waitForExistence(timeout: 5))
        app.buttons["folders.home"].tap()
        app.buttons["folders.entry./home/preview/projects"].tap()
        capture("22-host-folder-picker")
        app.buttons["folders.select"].tap()
        XCTAssertEqual(app.textFields["workspace.parent"].value as? String, "/home/preview/projects")
        app.segmentedControls["workspace.mode"].buttons["Open existing"].tap()
        XCTAssertFalse(app.buttons["workspace.create"].isEnabled)
        app.buttons["workspace.browseExisting"].tap()
        app.buttons["folders.entry./home/preview/projects/existing-project"].tap()
        XCTAssertTrue(app.staticTexts["No subfolders"].waitForExistence(timeout: 5))
        app.buttons["folders.select"].tap()
        XCTAssertEqual(app.textFields["workspace.existingFolder"].value as? String, "/home/preview/projects/existing-project")
        capture("23-open-existing-workspace")
        app.buttons["workspace.create"].tap()
        XCTAssertTrue(app.navigationBars["existing-project"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["terminal.files"].isHittable)
        capture("24-compact-agent-view")
    }

    @MainActor func testNextSessionCyclesAcrossWorkspaces() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--session-cycle-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let overviewNext = app.buttons["workspace.nextSession"]
        XCTAssertTrue(overviewNext.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["workspace.pane.workbench_t_cycle"].exists)
        capture("19-session-overview-icons")
        overviewNext.tap()
        XCTAssertTrue(app.navigationBars["Project Alpha"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["terminal.tab.workbench_h_cycle_codex"].value as? String, "Selected, Working")
        let next = app.buttons["terminal.nextSession"]
        XCTAssertTrue(next.isHittable)
        capture("20-codex-next-session")
        next.tap()
        XCTAssertEqual(app.buttons["terminal.tab.workbench_t_cycle"].value as? String, "Selected, Running", "Next skips the stopped agent")
        next.tap()
        XCTAssertTrue(app.navigationBars["Project Beta"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["terminal.tab.workbench_h_cycle_claude"].value as? String, "Selected, Quiet")
        capture("21-claude-next-session")
        next.tap()
        XCTAssertTrue(app.navigationBars["Project Alpha"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["terminal.tab.workbench_h_cycle_codex"].value as? String, "Selected, Working")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(overviewNext.waitForExistence(timeout: 5))
        overviewNext.tap()
        XCTAssertTrue(app.navigationBars["Project Alpha"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["terminal.tab.workbench_t_cycle"].value as? String, "Selected, Running", "Overview continues after the last viewed session")
    }

    @MainActor func testWorkspaceListShowsActivityAndPrioritizesBusyWorkspaces() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--workspace-activity-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()

        let busy = app.staticTexts["workspace.header.activity-busy"]
        let idle = app.staticTexts["workspace.header.activity-idle"]
        XCTAssertTrue(busy.waitForExistence(timeout: 15))
        XCTAssertTrue(idle.waitForExistence(timeout: 5))
        let headers = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'workspace.header.'"))
        XCTAssertEqual(headers.element(boundBy: 0).identifier, "workspace.header.activity-busy", "Active workspaces appear first even if the host lists an idle workspace first")
        XCTAssertLessThan(busy.frame.minY, idle.frame.minY)

        let activity = app.descendants(matching: .any)["workspace.activity.activity-busy"].firstMatch
        XCTAssertTrue(activity.exists)
        XCTAssertEqual(activity.value as? String, "Working · 1 agent · 1 recent output")
        XCTAssertFalse(app.descendants(matching: .any)["workspace.activity.activity-idle"].firstMatch.exists)
        XCTAssertEqual(app.buttons["workspace.pane.activity-working-agent"].value as? String, "Working")
        XCTAssertEqual(app.buttons["workspace.pane.activity-recent-agent"].value as? String, "Recent output")
        XCTAssertTrue(app.buttons["workspace.new"].isHittable)
        capture("18-workspace-activity")
    }

    @MainActor func testFileTextFitsPhoneWidth() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["terminal.files"].waitForExistence(timeout: 15))
        app.buttons["terminal.files"].tap()
        app.buttons["files.entry.long-lines.txt"].tap()
        let preview = app.descendants(matching: .any)["files.preview.text"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        capture("15-long-text-portrait")
        XCTAssertLessThanOrEqual(preview.frame.maxX, app.frame.maxX, "File text must fit within the iPhone width")
        XCTAssertGreaterThanOrEqual(preview.frame.minX, 0)
        preview.swipeUp()
        XCTAssertFalse(app.menuItems["Copy"].exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("16-long-text-scrolled")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertLessThanOrEqual(preview.frame.maxX, app.frame.maxX)
        capture("17-long-text-landscape")
        XCUIDevice.shared.orientation = .portrait
    }

    @MainActor func testWorkspaceCreationTabsAndFiles() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--workspace-list-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let newWorkspace = app.buttons["workspace.new"]
        XCTAssertTrue(newWorkspace.waitForExistence(timeout: 15))
        newWorkspace.tap()
        let name = app.textFields["workspace.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["workspace.create"].isEnabled)
        name.tap()
        name.typeText("phone-project")
        capture("08-new-workspace")
        app.buttons["workspace.create"].tap()
        XCTAssertTrue(app.navigationBars["phone-project"].waitForExistence(timeout: 5))
        let agent = app.buttons.matching(NSPredicate(format: "label == 'Codex' AND identifier BEGINSWITH 'terminal.tab.'")).firstMatch
        let terminal = app.buttons.matching(NSPredicate(format: "label == 'Terminal 1' AND identifier BEGINSWITH 'terminal.tab.'")).firstMatch
        XCTAssertTrue(agent.isHittable)
        XCTAssertTrue(terminal.isHittable)
        terminal.tap()
        XCTAssertEqual(terminal.value as? String, "Selected, Running")
        agent.tap()
        XCTAssertEqual(agent.value as? String, "Selected, Quiet")
        capture("09-workspace-tabs")
        app.buttons["terminal.files"].tap()
        let readme = app.buttons["files.entry.README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 5))
        capture("10-files")
        readme.tap()
        let text = app.textViews["files.preview.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        XCTAssertLessThan(text.frame.minY, app.frame.height / 3, "Short text previews start at the top, not vertically centered")
        capture("11-text-preview")
        app.navigationBars.buttons["Files"].tap()
        app.buttons["files.entry.images"].tap()
        app.buttons["files.entry.images/preview.png"].tap()
        let image = app.images["files.preview.image"]
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        capture("12-image-preview")
        image.pinch(withScale: 2, velocity: 1)
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(image.isHittable)
        image.doubleTap()
        capture("13-image-landscape")
        XCUIDevice.shared.orientation = .portrait
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["terminal.menu"].waitForExistence(timeout: 5))
    }

    @MainActor func testWorkingAgentTab() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture", "--busy-preview"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let agent = app.buttons["terminal.tab.workbench_h_preview"]
        XCTAssertTrue(agent.waitForExistence(timeout: 15))
        XCTAssertEqual(agent.value as? String, "Selected, Working")
        capture("14-working-agent")
    }

    @MainActor func testMenuKeyboardComposeAndRotation() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--terminal-render-fixture"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()

        let menu = app.buttons["terminal.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["workbench-app"].exists)
        XCTAssertTrue(app.buttons["terminal.keyboard"].isHittable)
        capture("01-terminal")
        let terminal = app.textViews["terminal.content"]
        XCTAssertGreaterThan(terminal.frame.height, app.frame.height * 0.7, "The coding view should retain most portrait height")
        terminal.swipeDown()
        XCTAssertEqual(app.descendants(matching: .any)["terminal.status"].firstMatch.value as? String, "Preview · scrolled up")
        XCTAssertFalse(app.menuItems["Copy"].exists)
        terminal.swipeUp()
        XCTAssertEqual(app.descendants(matching: .any)["terminal.status"].firstMatch.value as? String, "Preview · scrolled down")
        XCTAssertFalse(app.menuItems["Copy"].exists)
        menu.tap()
        XCTAssertTrue(app.navigationBars["Terminal menu"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["terminal.layoutState"].label, "Phone layout", "Opening a session automatically fits it to the phone")
        capture("02-menu")
        XCTAssertTrue(app.sliders["Terminal text size"].waitForExistence(timeout: 3))
        app.sliders["Terminal text size"].adjust(toNormalizedSliderPosition: 0.35)
        capture("03-text-size")
        app.buttons["Done"].tap()

        app.buttons["terminal.keyboard"].tap()
        // A fresh simulator may show iOS's first-use swipe-typing introduction.
        if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Esc"].isHittable)
        XCTAssertTrue(app.buttons["Ctrl"].isHittable)
        app.buttons["Ctrl"].tap()
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "On for next key")
        app.typeText("c")
        XCTAssertEqual(app.buttons["Ctrl"].value as? String, "Off")
        capture("04-keyboard")
        app.buttons["terminal.keyboard"].tap()

        menu.tap()
        app.buttons["terminal.compose"].tap()
        let draft = app.textViews["terminal.draft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 3))
        draft.tap()
        draft.typeText("Check the terminal layout on iPhone.")
        capture("05-compose")
        app.buttons["Done"].tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 5))

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(menu.isHittable)
        capture("06-landscape")
        XCUIDevice.shared.orientation = .portrait

        menu.tap()
        app.buttons["Use desktop layout"].tap()
        XCTAssertTrue(app.buttons["Fit to iPhone"].waitForExistence(timeout: 3))
        app.buttons["Fit to iPhone"].tap()
        XCTAssertTrue(app.buttons["Use desktop layout"].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        capture("07-phone-layout")
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.collectionViews.element(boundBy: max(0, app.collectionViews.count - 1)).swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }
}
