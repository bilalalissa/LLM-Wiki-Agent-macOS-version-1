import AppKit
import Foundation

let output = CommandLine.arguments.dropFirst().first ?? "AppIcon.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

image.lockFocus()

let rect = NSRect(origin: .zero, size: size)
NSColor.clear.setFill()
rect.fill()

let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.24)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()

let outer = NSBezierPath(roundedRect: rect.insetBy(dx: 76, dy: 76), xRadius: 218, yRadius: 218)
NSGradient(colors: [
  NSColor(calibratedRed: 0.07, green: 0.42, blue: 0.98, alpha: 1),
  NSColor(calibratedRed: 0.06, green: 0.76, blue: 0.86, alpha: 1)
])?.draw(in: outer, angle: 135)

NSGraphicsContext.current?.saveGraphicsState()
outer.addClip()
let glow = NSBezierPath(ovalIn: NSRect(x: 500, y: 490, width: 520, height: 520))
NSColor.white.withAlphaComponent(0.26).setFill()
glow.fill()
NSGraphicsContext.current?.restoreGraphicsState()

NSShadow().set()
let page = NSBezierPath(roundedRect: NSRect(x: 306, y: 214, width: 432, height: 596), xRadius: 58, yRadius: 58)
NSColor.white.withAlphaComponent(0.94).setFill()
page.fill()

let fold = NSBezierPath()
fold.move(to: NSPoint(x: 626, y: 810))
fold.line(to: NSPoint(x: 738, y: 696))
fold.line(to: NSPoint(x: 638, y: 696))
fold.curve(to: NSPoint(x: 626, y: 810), controlPoint1: NSPoint(x: 632, y: 720), controlPoint2: NSPoint(x: 626, y: 764))
fold.close()
NSColor(calibratedRed: 0.82, green: 0.94, blue: 1.0, alpha: 1).setFill()
fold.fill()

let spine = NSBezierPath(roundedRect: NSRect(x: 244, y: 220, width: 98, height: 584), xRadius: 50, yRadius: 50)
NSColor(calibratedRed: 0.02, green: 0.22, blue: 0.55, alpha: 0.36).setFill()
spine.fill()

let lineColor = NSColor(calibratedRed: 0.06, green: 0.15, blue: 0.28, alpha: 1)
lineColor.setStroke()
for y in stride(from: 632, through: 440, by: -82) {
  let line = NSBezierPath()
  line.lineWidth = 28
  line.lineCapStyle = .round
  line.move(to: NSPoint(x: 404, y: y))
  line.line(to: NSPoint(x: 648, y: y))
  line.stroke()
}

let nodeColor = NSColor(calibratedRed: 0.02, green: 0.23, blue: 0.50, alpha: 1)
let accentColor = NSColor(calibratedRed: 0.05, green: 0.70, blue: 0.83, alpha: 1)
for point in [
  NSPoint(x: 410, y: 350),
  NSPoint(x: 518, y: 300),
  NSPoint(x: 646, y: 354),
  NSPoint(x: 574, y: 426)
] {
  let dot = NSBezierPath(ovalIn: NSRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48))
  (point.x == 518 ? accentColor : nodeColor).setFill()
  dot.fill()
}

lineColor.withAlphaComponent(0.82).setStroke()
let edge = NSBezierPath()
edge.lineWidth = 16
edge.lineCapStyle = .round
edge.move(to: NSPoint(x: 410, y: 350))
edge.line(to: NSPoint(x: 518, y: 300))
edge.line(to: NSPoint(x: 646, y: 354))
edge.move(to: NSPoint(x: 518, y: 300))
edge.line(to: NSPoint(x: 574, y: 426))
edge.stroke()

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fatalError("Could not render icon PNG")
}

try png.write(to: URL(fileURLWithPath: output))
