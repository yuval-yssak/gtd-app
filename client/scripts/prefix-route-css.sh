#!/usr/bin/env bash
set -euo pipefail

find src/routes -name "*.css" | while read -r file; do
    dir=$(dirname "$file")
    base=$(basename "$file")
    mv "$file" "$dir/-$base"
done
