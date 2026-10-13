#!/usr/bin/env bash
# Deploys the wallet program to mainnet, UPGRADEABLE, with the paying wallet as upgrade authority.
# (Making it immutable is a separate, later step: `solana program set-upgrade-authority --final`.)
#
#   anchor build
#   WALLET=/path/to/payer.json scripts/deploy-mainnet.sh
#
# Needs about 2.65 SOL for rent (2 × program size) plus fees. Prints only public addresses.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WALLET:?set WALLET to the payer keypair file}"
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
SO=target/deploy/hashliquid.so
KEY=target/deploy/hashliquid-keypair.json
PROGRAM_ID="$(solana-keygen pubkey "$KEY")"
PAYER="$(solana-keygen pubkey "$WALLET")"

grep -q "declare_id!(\"$PROGRAM_ID\")" programs/hashliquid/src/lib.rs || { echo "lib.rs declare_id does not match $KEY: run 'anchor keys sync' and rebuild"; exit 1; }
echo "program  $PROGRAM_ID"
echo "payer    $PAYER  ($(solana balance "$PAYER" --url "$RPC"))"
echo "bytes    $(stat -f%z "$SO")  sha256 $(shasum -a 256 "$SO" | cut -c1-64)"
echo "rent     $(solana rent $(( $(stat -f%z "$SO") + 16384 + 45 )) --url "$RPC" 2>&1 | tail -1)"

# The program data account is sized to the program plus 16 KB (rent ~1.9 SOL) instead of the default 2× (~2.6 SOL).
# A bigger upgrade later needs `solana program extend` first.
MAX_LEN=$(( $(stat -f%z "$SO") + 16384 ))
# Without --use-rpc the writes go straight to the leaders (TPU/QUIC) and only the reads hit the RPC, which is what a
# public, rate-limited RPC can take. DEPLOY_FLAGS=--use-rpc sends everything through the RPC instead.
# The full output (it includes the recovery phrase of the temporary buffer, needed to resume a broken deploy)
# goes to a private log; the chat sees it without that phrase.
mkdir -p .secrets && chmod 700 .secrets
LOG=.secrets/deploy-mainnet.log
solana program deploy "$SO" --program-id "$KEY" --keypair "$WALLET" --url "$RPC" --max-len "$MAX_LEN" \
  --with-compute-unit-price 2000 --max-sign-attempts 60 ${DEPLOY_FLAGS:-} > "$LOG" 2>&1 || true
chmod 600 "$LOG"
grep -v -i -E 'seed phrase|recover|^([a-z]+ ){11}[a-z]+$|^=+$' "$LOG"
solana program show "$PROGRAM_ID" --keypair "$WALLET" --url "$RPC"
cp target/idl/hashliquid.json client/src/idl/hashliquid.json
echo "deployed. Next: WALLET=$WALLET RPC=$RPC npm --prefix client run canary"
