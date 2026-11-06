#!/usr/bin/env bash
# Start the SwapSha backend against the public testnet4 nodes (Blueprint B7).
#
#   ./swapsha-testnet4/run.sh          Postgres + backend (+ sidecar), foreground
#   ./swapsha-testnet4/run.sh check    nodes synced, wallets funded? (no backend)
#
# Needs: Docker running, ~/Claude/swapsha/testnet4/swapsha_testnet4.sh nodes
# synced past the fork with "swapsha" wallets funded, `cargo build -p boltzr`
# done. Uses its own database (boltz_testnet4) and data dir, so the regtest
# stack is untouched. Stop the regtest backend first; one backend at a time.
set -euo pipefail
cd "$(dirname "$0")/.."

HERE=swapsha-testnet4
DATA="$HERE/data"
PG=swapsha-postgres
DB=boltz_testnet4

rpc() {
  curl -s --user swapsha:swapsha -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" \
    "http://127.0.0.1:$1$3"
}

check_nodes() {
  local ok=1
  for spec in "SHA256 48332" "BTC 48432"; do
    set -- $spec
    local info; info=$(rpc "$2" getblockchaininfo "" || true)
    if ! echo "$info" | grep -q '"error":null'; then
      echo "$1 node on port $2 is not running. Run: ~/Claude/swapsha/testnet4/swapsha_testnet4.sh start"
      exit 1
    fi
    if echo "$info" | grep -q '"initialblockdownload":true'; then
      echo "$1 node is still syncing: $(echo "$info" | sed -n 's/.*"blocks":\([0-9]*\).*/\1/p') of $(echo "$info" | sed -n 's/.*"headers":\([0-9]*\).*/\1/p') blocks"
      ok=0; continue
    fi
    local bal; bal=$(rpc "$2" getbalance /wallet/swapsha || true)
    if ! echo "$bal" | grep -q '"error":null'; then
      echo "$1 node has no \"swapsha\" wallet loaded. Run: ~/Claude/swapsha/testnet4/swapsha_testnet4.sh wallets"
      ok=0; continue
    fi
    local amount; amount=$(echo "$bal" | sed -n 's/.*"result":\([0-9.]*\).*/\1/p')
    echo "$1 node synced, swapsha wallet balance: $amount"
    if [ "$amount" = "0.00000000" ]; then
      echo "  $1 swapsha wallet is empty; the backend needs liquidity to lock its side"
      ok=0
    fi
  done
  [ "$ok" = 1 ] || { echo "Not ready yet."; exit 1; }
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
    docker exec "$PG" pg_isready -U boltz >/dev/null 2>&1 && break
    sleep 1
  done
  if ! docker exec "$PG" psql -U boltz -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
    docker exec "$PG" psql -U boltz -c "CREATE DATABASE $DB" >/dev/null
    echo "Created database $DB"
  fi
  echo "Postgres ready ($DB)"
}

case "${1:-run}" in
  check) check_nodes ;;
  run)
    check_nodes
    [ -x target/debug/boltzr ] || { echo "Sidecar not built. Run: cargo build -p boltzr"; exit 1; }
    # D38: cargo lists the sources the sidecar was built from in boltzr.d. One
    # of them newer than the binary is a change not built yet.
    newer=$(tr ' ' '\n' < target/debug/boltzr.d | tail -n +2 | while read -r f; do
      if [ -n "$f" ] && [ "$f" -nt target/debug/boltzr ]; then echo "$f"; break; fi
    done || true)
    [ -z "$newer" ] || { echo "Sidecar is older than ${newer#"$PWD"/}. Run: cargo build -p boltzr"; exit 1; }
    if curl -s -o /dev/null http://127.0.0.1:9001/v2/swap/chain; then
      echo "The regtest backend is running on 9001. Stop it first (Ctrl+C in its window)."; exit 1
    fi
    start_db
    npm run compile:typescript
    mkdir -p "$DATA"
    # The sidecar finds its seed and certificates next to the config file
    cp "$HERE/boltz.conf" "$DATA/boltz.conf"
    exec node bin/boltzd --datadir "$DATA" --configpath "$DATA/boltz.conf"
    ;;
  *) sed -n '2,10p' "$0" ;;
esac
