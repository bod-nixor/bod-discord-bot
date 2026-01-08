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

tunnel_process=$(check_internal "kairos-ws.yaml")
python_process=$(check_internal "ws_server.py")
website_public=$(check_external "https://kairos.nixorcorporate.com/signoff/")
socket_public=$(check_external "https://kairos.nixorcorporate.com/websocket/socket.io/?EIO=4&transport=polling")

if [[ "$tunnel_process" == "true" ]]; then
  tunnel_status="✅"
else
  tunnel_status="❌"
fi

if [[ "$python_process" == "true" ]]; then
  python_status="✅"
else
  python_status="❌"
fi

if [[ "$website_public" == "true" ]]; then
  website_status="✅"
else
  website_status="❌"
fi

if [[ "$socket_public" == "true" ]]; then
  socket_status="✅"
else
  socket_status="❌"
fi

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
