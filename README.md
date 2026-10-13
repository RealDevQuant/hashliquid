# HashLiquid

A hash-locked wallet for trading perps on Solana, the AI agents that trade from it, and the site.
Live at [hashliquid.tech](https://hashliquid.tech).

A **bunker** is an account that owns a trading account on the venue (an on-chain perp exchange, program
`vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`). It has no private key. The only way to make it act is a one-time
hash-based signature (Winternitz over SHA-256) made with a key derived from 24 words: place this order, cancel that
one, withdraw this much to that token account. Breaking or stealing an Ed25519 wallet key gets nobody into it.

We don't run the exchange. Orders, prices, liquidity, liquidations and keepers are the venue's; the only thing
HashLiquid adds is who is allowed to give the orders.

**Status.** The program `6PWQ13DKweZ66XQRMG7kZyau98jE6CJnc1ugxtgnRQn2` is live on mainnet, immutable (no upgrade
authority) and its build is verifiable: source, verification and `security.txt` are in
[hashliquid-program](https://github.com/RealDevQuant/hashliquid-program). This repository holds everything around it:
the TypeScript SDK, the agents' service and the site.

## Repositories

| Where | What |
|---|---|
| [hashliquid-program](https://github.com/RealDevQuant/hashliquid-program) | The on-chain program (`lib.rs`: bunker, authorize, execute; `wots.rs`: the signature scheme) and its verifiable build |
| this repository | `client/` SDK and tests, `client/agents/` the trading agents, `web/` the site, `scripts/` the local validator and the deploy script |

## What the bunker protects

| | Authorized by |
|---|---|
| Place and cancel orders, open and close positions | a one-time key (24 words) |
| Withdraw, and where the money goes | a one-time key: the destination token account is part of what is signed |
| Change anything else about the account (the venue's delegate role included) | a one-time key |
| Create the bunker and its trading account; deposit | anyone (a wallet pays): neither can take anything from a bunker |
| Pay transaction fees | any wallet. It has no power over the bunker |

On the venue only an account's *authority* can withdraw, and the authority is the bunker. A wallet that tries to
trade or withdraw on the bunker's account is refused by the exchange itself (checked in the tests).

Not covered, and worth saying plainly:

- **The exchange.** The money sits in the venue, an upgradeable program controlled by its team. A bunker doesn't
  make the exchange safer; it makes *your access to it* safer.
- **Solana.** Every transaction still has an Ed25519 fee payer, and the chain itself is not hash-based.
- **The words.** Lose them and nothing can move what is in the bunker. Positions can still be liquidated by the
  exchange like anyone's.

## How it works

The bunker's address is derived from its seed and the hash of its first key, so the address *is* the keys. The
account stores the hash of the key that must sign next and its number.

Acting takes two transactions, because an 840-byte signature doesn't fit next to an instruction's accounts:

1. **`authorize`** carries the signature over the hash of the exact venue instruction (its bytes, its accounts,
   their flags). The program verifies it against the bunker's current key, retires that key, stores the next key's
   hash, and records the instruction's hash as the bunker's *pending action*. No wallet signature is involved:
   anyone can pay.
2. **`execute`** carries the instruction itself. It must hash to the pending action; the program then sends it to
   the venue with the bunker signing by CPI. Anyone can send it, and it runs once.

A key signs exactly once. The client keeps a ledger of what each key number signed (`SignedLedger`): asked to sign
anything else with a key that already signed, it refuses, and rebuilds the first message byte for byte to send
again. An authorized action that is no longer wanted is called off by authorizing "nothing" with the next key.

Two things need no signature: `init_trading` (creates the bunker's trading account, with no referrer) and
`deposit` (moves tokens the bunker already holds into its own trading account, and only there).

The bunker only ever calls the venue: `execute` has that program's address built in.

## The signature scheme

`wots.rs` in the program repository, mirrored byte for byte by `client/src/wots.ts`.

- Winternitz one-time signatures, w = 256, SHA-256 truncated to 28 bytes, 30 chains: **840-byte signatures**,
  112-bit security against Grover.
- Ported from Shelter (MIT). Parameters and test vectors are unchanged; the same code already runs on mainnet.
- **This is not RFC 8554 LM-OTS and not SLH-DSA**: those signatures don't fit a Solana transaction.

## The agents

Three agents (Ash One, Ash Two, Ash Three) trade real money from bunkers of their own, one decision every ten
minutes on a Claude model, every position and every reason public on the site and in a JSON feed. The code is
`client/agents/`:

- `brain.ts`: the prompt and the decision call. The model proposes; the code decides.
- `engine.ts`: the gates (setup score, risk per trade, leverage, daily loss, drawdown, cooldowns), the orders, the
  exit plans, and a **guard** every two minutes that enforces stops, targets, breakeven and trailing stops no
  matter what the model says.
- Anyone with a bunker can **hire** an agent: one signed move sets the agent's key as the account's delegate on the
  venue. A delegate can place and cancel orders and nothing else: it cannot withdraw and cannot name another
  delegate (both are the authority's alone, verified in the exchange's source and in `agents/hire.e2e.ts`). The
  owner's words fire it with one more move. The agent applies to hired bunkers the same decisions it takes for
  itself, sized by the aggressiveness the owner chose.
- Anyone can also **create an agent**: a base method, a name, a logo and an aggressiveness. The configuration lives
  in the 32-byte name of the trading account (`client/src/agentname.ts`): only the bunker can write it, so there is
  no database to trust. User-made agents run on a smaller model, up to a cap; the rest wait in a queue.

The service needs its own secrets (the agents' words, the delegate keys, a fee payer, an API key) under
`.secrets/`, which is not in this repository.

## Layout

| Path | What |
|---|---|
| `client/src/` | TypeScript SDK: `bunker.ts` (keys, signing, ledger, our instructions), `velocity.ts` (the venue's accounts and instructions, from its IDL), `codec.ts` (IDL-driven encoding), `wots.ts`, `words.ts`, `agentname.ts` |
| `client/test/` | Vectors + IDL checks (`npm test`), `local.e2e.ts` (the program against the real exchange on a local validator), `ui.e2e.ts` (the site in headless Chrome) |
| `client/agents/` | The agents' service: `run.ts` (CLI), `engine.ts`, `brain.ts`, `chain.ts`, `store.ts`, `config.ts`, `setup.ts`, `hire.e2e.ts` |
| `web/` | The site: landing (`index.html`), terminal (`app.html`), agents (`agents.html`), deploy wizard (`deploy.html`), docs; two small Vercel functions in `web/api/` (a relay to the venue's data API, the logo upload) |
| `scripts/localnet.sh` | Local validator with the venue copied from mainnet |
| `scripts/deploy-mainnet.sh` | How the program was deployed (writes through TPU, the public RPC only reads) |

## Run it

Needs Node 23.6+ (the client is TypeScript run directly by Node) and, for the chain tests, a Solana 4.3 release
and the program built from its repository.

```bash
npm --prefix client install
npm --prefix client test                  # vectors shared with the Rust half, ledger rules, both IDLs, agent names
```

### The real exchange, locally

The venue is built for the Solana version mainnet runs (SBPF v3); a 2.x test validator can't load it. Put a 4.3
release next to the project (it doesn't touch your installed Solana):

```bash
mkdir -p .tools/agave-4.3.0
gh release download v4.3.0 --repo anza-xyz/agave --pattern 'solana-release-aarch64-apple-darwin.tar.bz2' --dir .tools/agave-4.3.0
tar -xjf .tools/agave-4.3.0/*.tar.bz2 -C .tools/agave-4.3.0
cp .tools/agave-4.3.0/solana-release/bin/solana-test-validator .tools/agave-4.3.0/solana-release/bin/hashliquid-localnet
```

```bash
scripts/localnet.sh                       # terminal 1 (RPC_PORT=18899 scripts/localnet.sh if 8899 is taken)
npm --prefix client run test:e2e          # terminal 2 (RPC=http://127.0.0.1:18899 to match)
AGENTS_DATA=/tmp/agents RPC=http://127.0.0.1:18899 npm --prefix client run test:hire   # hire, mirror, guard, fire, create your agent
```

`localnet.sh` copies the venue's program, state, markets, the collateral market and the oracles from mainnet as they
are at that moment. The only thing local is the collateral mint's authority, so tests can mint test USDT.

The site:

```bash
npm --prefix web install
VITE_RPC_URL=http://127.0.0.1:8899 npm --prefix web run dev    # http://localhost:5183
npm --prefix client run fund -- <the test wallet's address>    # 5 SOL + 10,000 test USDT
PUPPETEER=<path to a puppeteer-core install> npm --prefix client run test:ui
```

`VITE_CLUSTER` is `localnet` (default), `devnet` or `mainnet`: keys are derived per cluster. The page sends limit
orders through the oracle price by the slippage you set: they fill like market orders, never worse than that.

## No token, no fee

Nothing in the program takes a fee or knows about a token: the fees on a trade are the venue's.
