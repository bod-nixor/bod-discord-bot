#!/usr/bin/env bash
set -euo pipefail

echo "Restarting Kairos services..."

if [[ -x /home/nixorc5/start-kairos.sh ]]; then
  /home/nixorc5/start-kairos.sh
  echo "✅ Restart script completed."
else
  echo "⚠️ /home/nixorc5/start-kairos.sh not found or not executable."
  echo "Please deploy the restart script on the host." 
  exit 1
fi
