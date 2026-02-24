#!/bin/bash
# Prepare the tlon plugin for bundling
# This script is called during the build process to install
# the plugin's production dependencies

set -e

PLUGIN_DIR="resources/tlon-plugin"

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "Warning: tlon-plugin directory not found at $PLUGIN_DIR"
  echo "Clone it with: git clone https://github.com/tloncorp/openclaw-tlon $PLUGIN_DIR"
  exit 0
fi

echo "Installing tlon-plugin dependencies..."
cd "$PLUGIN_DIR"
npm install --production
echo "tlon-plugin ready."
