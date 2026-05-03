#!/usr/bin/env bash
# Set up a worktree on another branch: copy gitignored files from CWD and run `npm i`.
# Presents an interactive picker of all worktrees (excluding the current one).
# Usage: ./scripts/setup-worktree.sh

set -euo pipefail

SOURCE_DIR="$(pwd)"

# Files to copy, relative to the repo root. Edit this list as needed.
FILES_TO_COPY=(
    "api-server/.env"
    "api-server/.env.production"
    "client/.env"
    "api-server/src/tests-sync-audit/.secrets/gcal-e2e.json"
    ".vscode/launch.json"
    ".vscode/settings.json"
    ".claude/settings.local.json"
    "api-server/.claude/settings.local.json"
    "client/.claude/settings.local.json"
)

# Build parallel arrays of worktrees: paths, branches, and display labels.
# Skips the current worktree, detached HEADs, and bare repos.
declare -a WT_PATHS WT_BRANCHES WT_LABELS

while IFS= read -r line; do
    case "$line" in
        "worktree "*) current_path="${line#worktree }" ;;
        "branch "*)
            current_branch="${line#branch refs/heads/}"
            if [[ "$current_path" != "$SOURCE_DIR" ]]; then
                WT_PATHS+=("$current_path")
                WT_BRANCHES+=("$current_branch")
                WT_LABELS+=("$current_branch  ($current_path)")
            fi
            ;;
    esac
done < <(git worktree list --porcelain)

if [[ ${#WT_PATHS[@]} -eq 0 ]]; then
    echo "No other worktrees found. Create one with 'git worktree add'." >&2
    exit 1
fi

# Present picker.
echo "Source: $SOURCE_DIR"
echo
echo "Select target worktree:"
PS3="> "
TARGET_DIR=""
BRANCH=""
select choice in "${WT_LABELS[@]}"; do
    if [[ -n "${choice:-}" ]]; then
        idx=$((REPLY - 1))
        TARGET_DIR="${WT_PATHS[$idx]}"
        BRANCH="${WT_BRANCHES[$idx]}"
        break
    fi
    echo "Invalid selection."
done

if [[ -z "$TARGET_DIR" ]]; then
    echo "No selection made; aborting." >&2
    exit 1
fi

echo
echo "Target: $TARGET_DIR (branch: $BRANCH)"
echo

# Copy gitignored files, prompting on conflict.
copy_file() {
    local rel="$1"
    local src="$SOURCE_DIR/$rel"
    local dst="$TARGET_DIR/$rel"

    if [[ ! -e "$src" ]]; then
        echo "  skip (missing in source): $rel"
        return
    fi

    if [[ -e "$dst" ]]; then
        read -r -p "  exists in target: $rel — overwrite? [y/N] " reply
        if [[ ! "$reply" =~ ^[Yy]$ ]]; then
            echo "    kept existing"
            return
        fi
    fi

    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "  copied: $rel"
}

echo "Copying gitignored files..."
for rel in "${FILES_TO_COPY[@]}"; do
    copy_file "$rel"
done
echo

# Install dependencies in both packages.
run_npm_install() {
    local pkg_dir="$1"
    if [[ ! -f "$pkg_dir/package.json" ]]; then
        echo "  skip (no package.json): $pkg_dir"
        return
    fi
    echo "  npm i in $pkg_dir"
    (cd "$pkg_dir" && npm i)
}

echo "Installing dependencies..."
run_npm_install "$TARGET_DIR/api-server"
run_npm_install "$TARGET_DIR/client"
echo
echo "Done. Worktree ready: $TARGET_DIR"
