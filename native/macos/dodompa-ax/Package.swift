// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "dodompa-ax",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "dodompa-ax",
            path: "Sources"
        )
    ]
)
