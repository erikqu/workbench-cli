import AppKit
guard CommandLine.arguments.count == 2 else { fatalError("Pass the output PNG path") }
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
NSColor(red: 0.09, green: 0.13, blue: 0.09, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1024, height: 1024)).fill()
NSColor(red: 0.73, green: 0.87, blue: 0.60, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 160, y: 160, width: 704, height: 704), xRadius: 145, yRadius: 145).fill()
("w_" as NSString).draw(at: NSPoint(x: 254, y: 315), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 340, weight: .bold), .foregroundColor: NSColor(red: 0.09, green: 0.13, blue: 0.09, alpha: 1)])
NSGraphicsContext.restoreGraphicsState()
let url = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
try bitmap.representation(using: .png, properties: [:])!.write(to: url)
