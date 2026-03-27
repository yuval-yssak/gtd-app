#!/usr/bin/env bash
set -euo pipefail

SERVICE=${1:-}
ENV=${2:-}

usage() {
    echo "Usage: $0 api staging|production"
    exit 1
}

[[ $SERVICE == "api" ]] || usage
[[ $ENV == "staging" || $ENV == "production" ]] || usage

echo "Deploying $SERVICE to $ENV..."
gh workflow run deploy-api.yml --repo yuval-yssak/gtd-app -f environment="$ENV"
echo "Track progress: https://github.com/yuval-yssak/gtd-app/actions/workflows/deploy-api.yml"
