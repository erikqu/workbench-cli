// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "WorkbenchCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "WorkbenchCore", targets: ["WorkbenchCore"]), .executable(name: "workbench-transport-check", targets: ["TransportCheck"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.12.0"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.81.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "3.12.3")
    ],
    targets: [
        .target(name: "WorkbenchCore", dependencies: [.product(name: "NIOSSH", package: "swift-nio-ssh"), .product(name: "NIOCore", package: "swift-nio"), .product(name: "NIOPosix", package: "swift-nio"), .product(name: "Crypto", package: "swift-crypto")]),
        .executableTarget(name: "TransportCheck", dependencies: ["WorkbenchCore"]),
        .testTarget(name: "WorkbenchCoreTests", dependencies: ["WorkbenchCore"])
    ],
    swiftLanguageModes: [.v5]
)
