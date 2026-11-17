# iPhone Duo

Apple's guidance calls for Xcode 27.1 or later to use the complete display on
iPhone Duo. Build and test the signed release with that SDK before reporting
full Duo support.

The workspace screen uses `NavigationSplitView`: the outer display presents
one column at a time, and the inner display presents the workspace/session
sidebar alongside the terminal. The system adjusts the columns around reserved
regions, including the fold. The terminal stays in the detail column; layout
changes must not create a new SSH connection or restart a remote session.

Keep general navigation controls in native toolbars with titles and symbols.
The terminal requests a horizontal toolbar on iOS 27.1 and later to preserve
terminal columns; Menu stays at the rightmost end of its session bar. Other
screens retain the system's adaptive toolbar placement. Terminal links open
in separate Workbench browser tabs through an explicit link activation;
Hover highlights links; tapping or Command-clicking opens them. The browser also
provides an Open in Safari action.

Before release, test the closed outer display, fully open inner display,
partially folded poses, rotation, and Split View multitasking with Xcode's Duo
simulator or a physical Duo. Keep a session and browser tab open across these
transitions, verifying that selection, terminal output, and web navigation stay
intact. Test Command-click with an external keyboard and pointing device.

References:

- [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo)
- [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo)
- [iPhone Duo developer resources](https://developer.apple.com/iphone-duo/)
