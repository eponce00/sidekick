#!/usr/bin/env bash
set -euo pipefail

reference_root="${SIDEKICK_REFERENCE_ROOT:-$HOME/Documents/sidekick-references}"
mkdir -p "$reference_root"

sync_repo() {
  local name="$1"
  local url="$2"
  local ref="${3:-}"
  local target="$reference_root/$name"
  if [[ -d "$target/.git" ]]; then
    if [[ -n "$ref" ]]; then
      git -C "$target" fetch --depth 1 origin "tag" "$ref"
      git -C "$target" checkout --detach "$ref"
    else
      git -C "$target" pull --ff-only
    fi
  elif [[ -n "$ref" ]]; then
    git clone --depth 1 --branch "$ref" --single-branch "$url" "$target"
  else
    git clone --depth 1 "$url" "$target"
  fi
}

sync_repo opencode https://github.com/anomalyco/opencode.git
sync_repo cline https://github.com/cline/cline.git
sync_repo grok-build https://github.com/xai-org/grok-build.git
sync_repo claude-code-official https://github.com/anthropics/claude-code.git
sync_repo android-agent https://github.com/ghost-in-the-droid/android-agent.git v1.3.0
sync_repo hermes-agent https://github.com/NousResearch/hermes-agent.git
sync_repo pi https://github.com/earendil-works/pi.git
