#!/usr/bin/env bash

EZBASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PATH_LINE="export PATH=\"$EZBASE_DIR:\$PATH\""

# Detect rc file
if [ -n "$ZSH_VERSION" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
  RC_FILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  RC_FILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  RC_FILE="$HOME/.bash_profile"
else
  RC_FILE="$HOME/.profile"
fi

# Check if already added
if grep -qF "$EZBASE_DIR" "$RC_FILE" 2>/dev/null; then
  printf "Already in %s\n" "$RC_FILE"
else
  printf "\n# ezbase\n%s\n" "$PATH_LINE" >> "$RC_FILE"
  printf "Added to %s\n" "$RC_FILE"
fi

# If sourced, update current session immediately
export PATH="$EZBASE_DIR:$PATH"
