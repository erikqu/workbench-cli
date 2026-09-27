# Workbench's SwiftTerm integration

This directory contains the SwiftTerm sources and their MIT license used by the
iOS app. Keep `LICENSE` with redistributions. The package manifest is reduced to
the library target and includes the Metal shader resource used by this renderer.

The app deliberately uses this local package via `apple/project.yml`, so a clean
checkout builds against the same renderer as the device-tested build. App-owned
touch scrolling behavior lives in `App/ScrollFirstTerminalView.swift`; it does
not require edits to the vendored mouse gesture implementation.

Do not add Xcode user data, `.swiftpm`, or build products to this directory's
tracked files. This source snapshot includes upstream/fork integration changes;
do not assume it is an unmodified SwiftTerm 1.20.0 release.
