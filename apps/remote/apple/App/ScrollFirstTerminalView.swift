import UIKit
import SwiftTerm

/// Touch drags scroll; they never emulate holding down a desktop mouse button.
/// tmux uses mouse-wheel events to enter and navigate its scrollback.
@MainActor final class ScrollFirstTerminalView: TerminalView, UIGestureRecognizerDelegate {
    private(set) var mouseScrollGesture: UIPanGestureRecognizer!
    private var scrollRemainder: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        let scroll = UIPanGestureRecognizer(target: self, action: #selector(scrollMouse(_:)))
        scroll.maximumNumberOfTouches = 1
        scroll.delegate = self
        scroll.isEnabled = false
        addGestureRecognizer(scroll)
        mouseScrollGesture = scroll
        panGestureRecognizer.require(toFail: scroll)
        for gesture in gestureRecognizers ?? [] {
            if let hold = gesture as? UILongPressGestureRecognizer {
                hold.minimumPressDuration = 0.9
                hold.allowableMovement = 8
            }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func mouseModeChanged(source: Terminal) {
        // Do not call super: its pan recognizer sends left-button selection drags.
        mouseScrollGesture?.isEnabled = source.mouseMode != .off
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === mouseScrollGesture {
            guard !hasActiveSelection else { return false }
            let movement = mouseScrollGesture.velocity(in: self)
            return abs(movement.y) > abs(movement.x)
        }
        if gestureRecognizer === panGestureRecognizer {
            // Let the outer viewport pan an oversized desktop grid when there
            // is no local scrollback for this scroll view to consume.
            return contentSize.height > bounds.height + 1
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }

    @objc private func scrollMouse(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began {
            scrollRemainder = 0
            UIMenuController.shared.hideMenu()
        }
        guard gesture.state == .began || gesture.state == .changed else { return }
        let movement = gesture.translation(in: self)
        gesture.setTranslation(.zero, in: self)
        scrollRemainder += movement.y
        let rowHeight = max(10, bounds.height / CGFloat(max(1, getTerminal().rows)))
        let steps = min(12, Int(abs(scrollRemainder) / rowHeight))
        guard steps > 0 else { return }
        let upward = scrollRemainder > 0
        scrollRemainder -= CGFloat(steps) * rowHeight * (upward ? 1 : -1)
        let terminal = getTerminal()
        let point = gesture.location(in: self)
        let x = min(terminal.cols - 1, max(0, Int(point.x / max(1, bounds.width) * CGFloat(terminal.cols))))
        let y = min(terminal.rows - 1, max(0, Int((point.y - contentOffset.y) / rowHeight)))
        let flags = terminal.encodeButton(button: upward ? 4 : 5, release: false, shift: false, meta: false, control: false)
        for _ in 0..<steps {
            terminal.sendEvent(buttonFlags: flags, x: x, y: y, pixelX: max(0, Int(point.x)), pixelY: max(0, Int(point.y - contentOffset.y)))
        }
    }
}
