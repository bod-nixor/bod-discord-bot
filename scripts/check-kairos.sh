#!/usr/bin/env bash
set -euo pipefail

check_internal() {
  local pattern="$1"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "true"
  else
    echo "false"
  fi
}

check_external() {
  local url="$1"
  if curl --silent --show-error --max-time 5 --fail "$url" >/dev/null 2>&1; then
    echo "true"
  else
    echo "false"
  fi
}

status_icon() {
  if [[ "$1" == "true" ]]; then
    echo "✅"
  else
    echo "❌"
  fi
}

tunnel_process=$(check_internal "kairos-ws.yaml")
python_process=$(check_internal "ws_server.py")
website_public=$(check_external "https://kairos.nixorcorporate.com/signoff/")
socket_public=$(check_external "https://kairos.nixorcorporate.com/websocket/socket.io/?EIO=4&transport=polling")

tunnel_status=$(status_icon "$tunnel_process")
python_status=$(status_icon "$python_process")
website_status=$(status_icon "$website_public")
socket_status=$(status_icon "$socket_public")

cat <<STATUS
**System Status Report**
---------------------------
**Internal Processes (cPanel)**
${tunnel_status} Cloudflare Tunnel (Process)
${python_status} Python Server (Process)

**External Access (Public URL)**
${website_status} Website (HTTPS)
${socket_status} Websocket (WSS/Socket.io)
STATUS
