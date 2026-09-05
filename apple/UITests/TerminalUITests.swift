import XCTest

final class TerminalUITests: XCTestCase {
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
        XCTAssertEqual(activity.value as? String, "Working · 1 agent · 1 recent")
        XCTAssertFalse(app.descendants(matching: .any)["workspace.activity.activity-idle"].firstMatch.exists)
        XCTAssertEqual(app.buttons["workspace.pane.activity-working-agent"].value as? String, "Working")
        XCTAssertEqual(app.buttons["workspace.pane.activity-recent-agent"].value as? String, "Recent activity")
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
        XCTAssertEqual(terminal.value as? String, "Selected, Idle")
        agent.tap()
        XCTAssertEqual(agent.value as? String, "Selected, Idle")
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
        XCTAssertTrue(app.buttons["Desktop size"].waitForExistence(timeout: 3), "Opening a session automatically fits it to the phone")
        XCTAssertTrue(app.buttons["terminal.compose"].isHittable)
        capture("01-terminal")
        let terminal = app.textViews["terminal.content"]
        terminal.swipeDown()
        XCTAssertTrue(app.staticTexts["Preview · scrolled up"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.menuItems["Copy"].exists)
        terminal.swipeUp()
        XCTAssertTrue(app.staticTexts["Preview · scrolled down"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.menuItems["Copy"].exists)
        menu.tap()
        XCTAssertTrue(app.navigationBars["Terminal menu"].waitForExistence(timeout: 3))
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

        app.buttons["Desktop size"].tap()
        XCTAssertTrue(app.buttons["Fit to iPhone"].waitForExistence(timeout: 3))
        app.buttons["Fit to iPhone"].tap()
        XCTAssertTrue(app.buttons["Desktop size"].waitForExistence(timeout: 3))
        capture("07-phone-layout")
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
