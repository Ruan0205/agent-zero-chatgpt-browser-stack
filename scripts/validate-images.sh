#!/bin/sh
set -eu

queue=a0-public-check-queue
browser=a0-public-check-browser
vscode=a0-public-check-vscode

cleanup() {
  docker rm -f "$queue" "$browser" "$vscode" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

wait_exec() {
  container=$1
  command=$2
  count=0
  until docker exec "$container" sh -lc "$command" >/dev/null 2>&1; do
    count=$((count + 1))
    if [ "$count" -ge 30 ]; then
      docker logs --tail 100 "$container" >&2 || true
      return 1
    fi
    sleep 1
  done
}

docker run -d --rm --name "$queue" agent-zero-browser-stack-featherless-queue >/dev/null
wait_exec "$queue" "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)\""
echo "OK featherless-queue"

docker run -d --rm --name "$vscode" -e VSCODE_EXEC_TOKEN=validation-token agent-zero-browser-stack-vscode >/dev/null
wait_exec "$vscode" "curl -fsS http://127.0.0.1:8080/healthz"
echo "OK vscode"

docker run -d --rm --name "$browser" \
  -e VNC_PASSWORD=Test1234 \
  --tmpfs /data:uid=1000,gid=1000 \
  --tmpfs /workspace:uid=1000,gid=1000 \
  agent-zero-browser-stack-chatgpt-browser-agent >/dev/null
wait_exec "$browser" "node -e \"fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
echo "OK chatgpt-browser-agent"

docker run --rm --entrypoint /bin/sh agent-zero-browser-stack-meta-ai-whatsapp \
  -lc "test -x /usr/local/bin/wametaai"
echo "OK meta-ai-whatsapp binary"

echo "Todas as imagens locais passaram no smoke test."
