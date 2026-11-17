import XCTest
@testable import WorkbenchCore

final class WebLinkTests: XCTestCase {
    func testWebLinksIncludeLocalDevelopmentServers() {
        XCTAssertEqual(WebLink.url("https://www.apple.com/iphone-duo/")?.host, "www.apple.com")
        XCTAssertEqual(WebLink.url("http://127.0.0.1:3000/test")?.port, 3000)
        XCTAssertEqual(WebLink.url(" www.example.com/test ")?.scheme, "https")
        XCTAssertNotNil(WebLink.url("http://[::1]:3000"))
    }
    func testTerminalURIsCannotOpenLocalFilesOrLaunchApps() {
        for link in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "workbench-remote://pair?data=secret", "https://", "https://user:password@example.com", "https://example.com/\nsecret"] {
            XCTAssertNil(WebLink.url(link), link)
        }
    }
}
