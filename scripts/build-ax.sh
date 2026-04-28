#!/bin/bash
set -e
cd "$(dirname "$0")/../native/macos/dodompa-ax"
swift build -c release
mkdir -p ../../../resources/bin
cp .build/release/dodompa-ax ../../../resources/bin/
echo "Built dodompa-ax successfully"
