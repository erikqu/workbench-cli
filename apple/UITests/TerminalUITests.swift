import XCTest

final class TerminalUITests: XCTestCase {
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
