#!/bin/bash
cd "$(dirname "$0")/../native/macos/dodompa-ax"
swift build -c release
cp .build/release/dodompa-ax ../../../resources/bin/
echo "Built dodompa-ax successfully"
