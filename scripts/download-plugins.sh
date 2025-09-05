#!/bin/bash
# Script to download the actual Rete plugin files to replace the stubs
# Run this to get the real plugin files for production

set -e

VENDOR_DIR="scripts/public/vendor"

echo "Downloading Rete plugin files..."

# Download connection plugin v0.9.0
curl -o "$VENDOR_DIR/connection-plugin.min.js" \
  "https://unpkg.com/rete-connection-plugin@0.9.0/build/connection-plugin.min.js"

# Download vue render plugin v0.5.2  
curl -o "$VENDOR_DIR/vue-render-plugin.min.js" \
  "https://unpkg.com/rete-vue-render-plugin@0.5.2/build/vue-render-plugin.min.js"

echo "✅ Plugin files downloaded successfully!"
echo "The application will now load plugins from local vendor files with CDN fallback."