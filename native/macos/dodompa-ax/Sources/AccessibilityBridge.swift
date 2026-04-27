import ApplicationServices
import AppKit
import Foundation

// MARK: - JSON Models

struct AXNodeJSON: Codable {
    let role: String?
    let title: String?
    let value: String?
    let description: String?
    let enabled: Bool
    let focused: Bool
    let position: PointJSON?
    let size: SizeJSON?
    let path: String
    let actions: [String]
    let children: [AXNodeJSON]?
}

struct PointJSON: Codable { let x: Double; let y: Double }
struct SizeJSON: Codable { let width: Double; let height: Double }

struct WindowInfoJSON: Codable {
    let pid: Int32
    let app: String?
    let bundleId: String?
    let title: String?
    let bounds: BoundsJSON?
    let focused: Bool
}

struct BoundsJSON: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

// MARK: - Helpers

private func axStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let str = value as? String else { return nil }
    return str
}

private func axBoolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return false }
    if let num = value as? NSNumber {
        return num.boolValue
    }
    return false
}

private func axPointAttribute(_ element: AXUIElement, _ attribute: String) -> PointJSON? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let axValue = value else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue(axValue as! AXValue, .cgPoint, &point) {
        return PointJSON(x: Double(point.x), y: Double(point.y))
    }
    return nil
}

private func axSizeAttribute(_ element: AXUIElement, _ attribute: String) -> SizeJSON? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let axValue = value else { return nil }
    var size = CGSize.zero
    if AXValueGetValue(axValue as! AXValue, .cgSize, &size) {
        return SizeJSON(width: Double(size.width), height: Double(size.height))
    }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    guard result == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let result = AXUIElementCopyActionNames(element, &names)
    guard result == .success, let actionNames = names as? [String] else { return [] }
    return actionNames
}

// MARK: - Public API

func listWindows() -> [WindowInfoJSON] {
    var windows: [WindowInfoJSON] = []
    let apps = NSWorkspace.shared.runningApplications

    // Get the frontmost app PID for focused detection
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier

    for app in apps where app.activationPolicy == .regular {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)

        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        guard result == .success, let axWindows = value as? [AXUIElement] else { continue }

        for axWindow in axWindows {
            let title = axStringAttribute(axWindow, kAXTitleAttribute as String)

            var boundsJSON: BoundsJSON? = nil
            if let pos = axPointAttribute(axWindow, kAXPositionAttribute as String),
               let sz = axSizeAttribute(axWindow, kAXSizeAttribute as String) {
                boundsJSON = BoundsJSON(x: pos.x, y: pos.y, width: sz.width, height: sz.height)
            }

            let isFocused = (pid == frontmostPid) && axBoolAttribute(axWindow, kAXFocusedAttribute as String)

            windows.append(WindowInfoJSON(
                pid: pid,
                app: app.localizedName,
                bundleId: app.bundleIdentifier,
                title: title,
                bounds: boundsJSON,
                focused: isFocused
            ))
        }
    }

    return windows
}

func getTree(pid: pid_t, maxDepth: Int) -> AXNodeJSON {
    let appElement = AXUIElementCreateApplication(pid)
    return buildNode(element: appElement, path: "0", depth: 0, maxDepth: maxDepth)
}

private func buildNode(element: AXUIElement, path: String, depth: Int, maxDepth: Int) -> AXNodeJSON {
    let role = axStringAttribute(element, kAXRoleAttribute as String)
    let title = axStringAttribute(element, kAXTitleAttribute as String)

    // Get value as string regardless of actual type
    var rawValue: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &rawValue)
    var valueStr: String? = nil
    if let rv = rawValue {
        if let s = rv as? String {
            valueStr = s
        } else if let n = rv as? NSNumber {
            valueStr = n.stringValue
        }
    }

    let desc = axStringAttribute(element, kAXDescriptionAttribute as String)
    let enabled = axBoolAttribute(element, kAXEnabledAttribute as String)
    let focused = axBoolAttribute(element, kAXFocusedAttribute as String)
    let position = axPointAttribute(element, kAXPositionAttribute as String)
    let size = axSizeAttribute(element, kAXSizeAttribute as String)
    let actions = axActionNames(element)

    var childNodes: [AXNodeJSON]? = nil
    if depth < maxDepth {
        let children = axChildren(element)
        if !children.isEmpty {
            childNodes = children.enumerated().map { (index, child) in
                buildNode(element: child, path: "\(path).\(index)", depth: depth + 1, maxDepth: maxDepth)
            }
        }
    }

    return AXNodeJSON(
        role: role,
        title: title,
        value: valueStr,
        description: desc,
        enabled: enabled,
        focused: focused,
        position: position,
        size: size,
        path: path,
        actions: actions,
        children: childNodes
    )
}

func findElements(pid: pid_t, role: String, title: String?) -> [AXNodeJSON] {
    let appElement = AXUIElementCreateApplication(pid)
    var results: [AXNodeJSON] = []
    searchTree(element: appElement, path: "0", role: role, title: title, results: &results)
    return results
}

private func searchTree(element: AXUIElement, path: String, role: String, title: String?, results: inout [AXNodeJSON]) {
    let elementRole = axStringAttribute(element, kAXRoleAttribute as String)
    let elementTitle = axStringAttribute(element, kAXTitleAttribute as String)
    let elementDesc = axStringAttribute(element, kAXDescriptionAttribute as String)

    var matches = (elementRole == role)
    if matches, let searchTitle = title {
        // Match against title OR description (Calculator buttons have labels in description, not title)
        let titleMatch = elementTitle?.localizedCaseInsensitiveContains(searchTitle) == true
        let descMatch = elementDesc?.localizedCaseInsensitiveContains(searchTitle) == true
        matches = titleMatch || descMatch
    }

    if matches {
        let node = buildNode(element: element, path: path, depth: 0, maxDepth: 0)
        results.append(node)
    }

    let children = axChildren(element)
    for (index, child) in children.enumerated() {
        searchTree(element: child, path: "\(path).\(index)", role: role, title: title, results: &results)
    }
}

func elementAtPoint(x: Float, y: Float) -> AXNodeJSON? {
    let systemWide = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(systemWide, x, y, &element)
    guard result == .success, let el = element else { return nil }

    // Try to determine a reasonable path - we don't know the full hierarchy, use "0"
    return buildNode(element: el, path: "0", depth: 0, maxDepth: 0)
}

func performAction(pid: pid_t, path: String, action: String) throws {
    let appElement = AXUIElementCreateApplication(pid)
    let indices = path.split(separator: ".").compactMap { Int($0) }

    guard !indices.isEmpty else {
        throw AXError.invalidPath(path)
    }

    // The first index "0" refers to the app element itself; navigate from the second index onward
    var current = appElement
    for i in indices.dropFirst() {
        let children = axChildren(current)
        guard i < children.count else {
            throw AXError.invalidPath(path)
        }
        current = children[i]
    }

    let result = AXUIElementPerformAction(current, action as CFString)
    guard result == .success else {
        throw AXError.actionFailed(action, Int(result.rawValue))
    }
}

enum AXError: LocalizedError {
    case invalidPath(String)
    case actionFailed(String, Int)

    var errorDescription: String? {
        switch self {
        case .invalidPath(let path):
            return "Invalid element path: \(path)"
        case .actionFailed(let action, let code):
            return "Action '\(action)' failed with code \(code)"
        }
    }
}
