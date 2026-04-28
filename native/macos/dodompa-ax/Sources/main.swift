import Foundation
import CoreGraphics

// MARK: - JSON Output

let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return e
}()

func outputJSON<T: Encodable>(_ value: T) {
    do {
        let data = try encoder.encode(value)
        if let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    } catch {
        exitError("Failed to encode JSON: \(error.localizedDescription)")
    }
}

func exitError(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    exit(1)
}

// MARK: - Argument Parsing

func getFlag(_ args: [String], _ flag: String) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func hasFlag(_ args: [String], _ flag: String) -> Bool {
    return args.contains(flag)
}

func requireFlag(_ args: [String], _ flag: String) -> String {
    guard let value = getFlag(args, flag) else {
        exitError("Missing required flag: \(flag)")
    }
    return value
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())

guard let command = args.first else {
    exitError("Usage: dodompa-ax <command> [options]\n\nCommands:\n  list-windows\n  tree --pid <PID> [--depth N]\n  find --pid <PID> --role <AXRole> [--title text]\n  element-at --x <X> --y <Y> [--depth N]\n  pick [--timeout N] [--depth N]\n  perform-action --pid <PID> --path <path> --action <AXAction>")
}

struct PickResultJSON: Codable {
    let x: Double
    let y: Double
    let element: AXNodeJSON?
}

func waitForNextClick(timeout: TimeInterval) -> CGPoint? {
    let mask = CGEventMask(1 << CGEventType.leftMouseDown.rawValue)
    var captured = CGPoint.zero

    let callback: CGEventTapCallBack = { _, _, event, refcon in
        let ptr = refcon!.assumingMemoryBound(to: CGPoint.self)
        ptr.pointee = event.location
        CFRunLoopStop(CFRunLoopGetCurrent())
        return nil // swallow the click so the underlying UI doesn't fire
    }

    return withUnsafeMutablePointer(to: &captured) { ptr -> CGPoint? in
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: UnsafeMutableRawPointer(ptr)
        ) else {
            return nil
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
        CGEvent.tapEnable(tap: tap, enable: true)
        defer {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
        }
        let result = CFRunLoopRunInMode(.defaultMode, timeout, false)
        return result == .stopped ? ptr.pointee : nil
    }
}

switch command {
case "list-windows":
    let windows = listWindows()
    outputJSON(windows)

case "tree":
    let pidStr = requireFlag(args, "--pid")
    guard let pid = Int32(pidStr) else {
        exitError("Invalid PID: \(pidStr)")
    }
    let depth = Int(getFlag(args, "--depth") ?? "5") ?? 5
    let tree = getTree(pid: pid, maxDepth: depth)
    outputJSON(tree)

case "find":
    let pidStr = requireFlag(args, "--pid")
    guard let pid = Int32(pidStr) else {
        exitError("Invalid PID: \(pidStr)")
    }
    let role = requireFlag(args, "--role")
    let title = getFlag(args, "--title")
    let results = findElements(pid: pid, role: role, title: title)
    outputJSON(results)

case "element-at":
    let xStr = requireFlag(args, "--x")
    let yStr = requireFlag(args, "--y")
    guard let x = Float(xStr), let y = Float(yStr) else {
        exitError("Invalid coordinates: x=\(xStr), y=\(yStr)")
    }
    let depth = Int(getFlag(args, "--depth") ?? "3") ?? 3
    if let element = elementAtPoint(x: x, y: y, maxDepth: depth) {
        outputJSON(element)
    } else {
        exitError("No element found at (\(xStr), \(yStr))")
    }

case "pick":
    let timeout = TimeInterval(getFlag(args, "--timeout") ?? "30") ?? 30
    let depth = Int(getFlag(args, "--depth") ?? "3") ?? 3
    guard let point = waitForNextClick(timeout: timeout) else {
        exitError("Timed out after \(Int(timeout))s waiting for click (or failed to create event tap — check Accessibility permission)")
    }
    let element = elementAtPoint(x: Float(point.x), y: Float(point.y), maxDepth: depth)
    outputJSON(PickResultJSON(x: Double(point.x), y: Double(point.y), element: element))

case "perform-action":
    let pidStr = requireFlag(args, "--pid")
    guard let pid = Int32(pidStr) else {
        exitError("Invalid PID: \(pidStr)")
    }
    let path = requireFlag(args, "--path")
    let action = requireFlag(args, "--action")
    do {
        try performAction(pid: pid, path: path, action: action)
        outputJSON(["success": true])
    } catch {
        exitError(error.localizedDescription)
    }

case "click":
    let xStr = requireFlag(args, "--x")
    let yStr = requireFlag(args, "--y")
    guard let x = Double(xStr), let y = Double(yStr) else {
        exitError("Invalid coordinates: x=\(xStr), y=\(yStr)")
    }
    let point = CGPoint(x: x, y: y)
    let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!
    let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!
    mouseDown.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(50000) // 50ms between down/up
    mouseUp.post(tap: CGEventTapLocation.cghidEventTap)
    outputJSON(["success": true])

case "right-click":
    let xStr = requireFlag(args, "--x")
    let yStr = requireFlag(args, "--y")
    guard let x = Double(xStr), let y = Double(yStr) else {
        exitError("Invalid coordinates: x=\(xStr), y=\(yStr)")
    }
    let point = CGPoint(x: x, y: y)
    let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)!
    let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)!
    mouseDown.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(50000)
    mouseUp.post(tap: CGEventTapLocation.cghidEventTap)
    outputJSON(["success": true])

case "move":
    let xStr = requireFlag(args, "--x")
    let yStr = requireFlag(args, "--y")
    guard let x = Double(xStr), let y = Double(yStr) else {
        exitError("Invalid coordinates: x=\(xStr), y=\(yStr)")
    }
    let point = CGPoint(x: x, y: y)
    let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)!
    moveEvent.post(tap: CGEventTapLocation.cghidEventTap)
    outputJSON(["success": true])

case "drag":
    let fxStr = requireFlag(args, "--from-x")
    let fyStr = requireFlag(args, "--from-y")
    let txStr = requireFlag(args, "--to-x")
    let tyStr = requireFlag(args, "--to-y")
    guard let fx = Double(fxStr), let fy = Double(fyStr), let tx = Double(txStr), let ty = Double(tyStr) else {
        exitError("Invalid coordinates")
    }
    let fromPt = CGPoint(x: fx, y: fy)
    let toPt = CGPoint(x: tx, y: ty)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: fromPt, mouseButton: .left)!
    down.post(tap: CGEventTapLocation.cghidEventTap)
    usleep(100000) // 100ms
    let steps = 10
    for i in 1...steps {
        let frac = Double(i) / Double(steps)
        let midPt = CGPoint(x: fx + (tx - fx) * frac, y: fy + (ty - fy) * frac)
        let dragEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: midPt, mouseButton: .left)!
        dragEvent.post(tap: CGEventTapLocation.cghidEventTap)
        usleep(20000) // 20ms
    }
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: toPt, mouseButton: .left)!
    up.post(tap: CGEventTapLocation.cghidEventTap)
    outputJSON(["success": true])

default:
    exitError("Unknown command: \(command)\n\nCommands: list-windows, tree, find, element-at, pick, perform-action, click, right-click, move, drag")
}
