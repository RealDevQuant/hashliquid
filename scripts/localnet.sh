#!/usr/bin/env bash
# A local validator with the wallet program loaded next to the REAL exchange: Velocity's program, state, the
# SOL-PERP market, the USDT collateral market and their oracles are copied from mainnet as they are right now.
# The one thing changed is the USDT mint's authority, set to a throwaway key (.localnet/admin.json) so tests can
# mint test USDT.
#
#   anchor build && scripts/localnet.sh            # RPC on 8899
#   RPC_PORT=18899 scripts/localnet.sh             # another port, when 8899 is taken
#
# Then, in another terminal:  cd client && npm run test:e2e
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT="${RPC_PORT:-8899}"
# The exchange is built for the Solana version mainnet runs (SBPF v3): an older validator can't load it. Use the
# 4.3 one in .tools/ when it is there (see README), or whatever VALIDATOR points to.
# (hashliquid-localnet is a copy of that release's solana-test-validator under another name, so that other work
# on this machine that restarts "every solana-test-validator" doesn't take this one down mid-test.)
VALIDATOR="${VALIDATOR:-.tools/agave-4.3.0/solana-release/bin/hashliquid-localnet}"
[ -x "$VALIDATOR" ] || VALIDATOR=solana-test-validator
MAINNET="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
DIR=.localnet
mkdir -p "$DIR"
[ -f "$DIR/admin.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$DIR/admin.json"
PROGRAM_ID="$(solana-keygen pubkey target/deploy/hashliquid-keypair.json)"
ADMIN="$(solana-keygen pubkey "$DIR/admin.json")"

VELOCITY=vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P
STATE=2etx5NvPNxeMZ7EfHE6GjJfW2imRYEUANehNS1WB4CVW
SOL_PERP=FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY
SOL_ORACLE=2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV
USDT_MARKET=2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc
USDT_VAULT=G9NKtiafHiCTArgVouXx6XS7Jb3DqigrT6S6BgSDLrvz
USDT_ORACLE=Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4
USDT_MINT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
# a second market, so the page has something to switch to
BTC_PERP=7s5WRWA3GahueLNfNb8bbVnHnxCssK5YjGCR3wP6Aa1t
BTC_ORACLE=J7Fp8iTKuKdCM7PnzqHXTdTo5Jr7ykAmiDyvpz58GJGZ

# the USDT mint as on mainnet, with our throwaway key as mint authority
curl -s -m 30 "$MAINNET" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$USDT_MINT\",{\"encoding\":\"base64\"}]}" \
  | ADMIN_KEY="$ADMIN" MINT="$USDT_MINT" python3 -c '
import sys, json, base64, os
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    return n.to_bytes(32, "big")
v = json.load(sys.stdin)["result"]["value"]
data = bytearray(base64.b64decode(v["data"][0]))
data[0:4] = (1).to_bytes(4, "little")
data[4:36] = b58d(os.environ["ADMIN_KEY"])
json.dump({"pubkey": os.environ["MINT"], "account": {"lamports": v["lamports"], "data": [base64.b64encode(bytes(data)).decode(), "base64"], "owner": v["owner"], "executable": False, "rentEpoch": 0, "space": len(data)}}, sys.stdout)
' > "$DIR/usdt-mint.json"

# The exchange program itself: its bytes are read from mainnet and loaded here at genesis. (Cloning it as an
# upgradeable program would bring along the slot it was deployed at, and it would not run until the local clock
# got there.) The local clock starts at zero, so it is behind the slot the copied oracle prices were posted at:
# that is what keeps them fresh for the exchange however long this validator runs.
rpc() { curl -s -m 120 "$MAINNET" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$1\",{\"encoding\":\"$2\"}]}"; }
PROGRAM_DATA="$(rpc "$VELOCITY" jsonParsed | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["value"]["data"]["parsed"]["info"]["programData"])')"
rpc "$PROGRAM_DATA" base64 | OUT="$DIR/velocity.so" python3 -c '
import sys, json, base64, os
data = base64.b64decode(json.load(sys.stdin)["result"]["value"]["data"][0])
# ProgramData header: 4-byte tag, 8-byte deploy slot, 1 + 32 bytes of upgrade authority
assert data[:4] == (3).to_bytes(4, "little"), "not a ProgramData account"
open(os.environ["OUT"], "wb").write(data[45:])
print("velocity program:", len(data) - 45, "bytes, deployed on mainnet at slot", int.from_bytes(data[4:12], "little"))
'

echo "wallet program $PROGRAM_ID · admin $ADMIN · rpc http://127.0.0.1:$RPC_PORT · exchange copied from $MAINNET"
echo "validator: $("$VALIDATOR" --version)"
exec "$VALIDATOR" --reset --quiet \
  --ledger "$DIR/ledger" \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$((RPC_PORT + 1001))" \
  --gossip-port "$((RPC_PORT + 102))" \
  --dynamic-port-range "$((RPC_PORT + 103))-$((RPC_PORT + 133))" \
  --bpf-program "$PROGRAM_ID" target/deploy/hashliquid.so \
  --url "$MAINNET" \
  --upgradeable-program "$VELOCITY" "$DIR/velocity.so" none \
  --clone "$STATE" --clone "$SOL_PERP" --clone "$SOL_ORACLE" --clone "$BTC_PERP" --clone "$BTC_ORACLE" \
  --clone "$USDT_MARKET" --clone "$USDT_VAULT" --clone "$USDT_ORACLE" \
  --account "$USDT_MINT" "$DIR/usdt-mint.json" \
  ${EXTRA_CLONES:-}
