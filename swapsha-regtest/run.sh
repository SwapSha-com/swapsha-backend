#!/usr/bin/env bash
# Start the SwapSha backend against the local two-chain regtest.
#
#   ./swapsha-regtest/run.sh          Postgres + backend (+ sidecar), foreground
#   ./swapsha-regtest/run.sh db-stop  stop the Postgres container
#   ./swapsha-regtest/run.sh reset    delete backend data and database (keeps chains)
#
# Needs: Docker running, swapsha_regtest.sh nodes started with `provider` done,
# `cargo build -p boltzr` done.
set -euo pipefail
cd "$(dirname "$0")/.."

HERE=swapsha-regtest
DATA="$HERE/data"
PG=swapsha-postgres

rpc() {
  curl -s --user swapsha:swapsha -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" \
    "http://127.0.0.1:$1/wallet/swapsha"
}

check_nodes() {
  for spec in "BTC 18443" "XBT 18543"; do
    set -- $spec
    local out; out=$(rpc "$2" getbalance || true)
    if ! echo "$out" | grep -q '"error":null'; then
      echo "$1 node on port $2 is not ready, or has no \"swapsha\" wallet."
      echo "Run: ~/Claude/swapsha/regtest/swapsha_regtest.sh start"
      echo "     ~/Claude/swapsha/regtest/swapsha_regtest.sh provider"
      echo "Node said: $out"
      exit 1
    fi
    echo "$1 node ok, swapsha wallet balance: $(echo "$out" | sed -n 's/.*"result":\([0-9.]*\).*/\1/p')"
  done
}

start_db() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Open Docker Desktop and try again."; exit 1
  fi
  if [ -z "$(docker ps -aq -f name="^${PG}$")" ]; then
    docker run -d --name "$PG" -e POSTGRES_USER=boltz -e POSTGRES_PASSWORD=boltz \
      -e POSTGRES_DB=boltz -p 127.0.0.1:5432:5432 postgres:17 >/dev/null
  else
    docker start "$PG" >/dev/null
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG" pg_isready -U boltz >/dev/null 2>&1 && { echo "Postgres ready"; return; }
    sleep 1
  done
  echo "Postgres did not become ready"; exit 1
}

case "${1:-run}" in
  db-stop) docker stop "$PG" >/dev/null && echo "Postgres stopped" ;;
  reset)
    docker rm -f "$PG" >/dev/null 2>&1 || true
    rm -rf "$DATA"
    echo "Backend data and database removed (chains untouched)"
    ;;
  run)
    check_nodes
    [ -x target/debug/boltzr ] || { echo "Sidecar not built. Run: cargo build -p boltzr"; exit 1; }
    start_db
    npm run compile:typescript
    mkdir -p "$DATA"
    # The sidecar finds its seed and certificates next to the config file, so
    # the config has to live inside the backend data dir.
    cp "$HERE/boltz.conf" "$DATA/boltz.conf"
    exec node bin/boltzd --datadir "$DATA" --configpath "$DATA/boltz.conf"
    ;;
  *) sed -n '2,10p' "$0" ;;
esac
