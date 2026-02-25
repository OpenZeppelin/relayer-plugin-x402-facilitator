# x402 Server Example

Express server with payment-protected endpoints using the x402 protocol on Stellar testnet.

## Prerequisites

- Node.js >= 22.18.0
- pnpm
- A running [OpenZeppelin Relayer](https://github.com/OpenZeppelin/openzeppelin-relayer) with the x402 facilitator plugin configured (see the [main README](../../README.md))
- A Stellar testnet account (public key)

## Note on `@x402/stellar`

The `@x402/stellar` package in `package.json` is currently referenced as a local `.tgz` file. This is a temporary workaround while waiting for the official release to npm. Once published, replace it with the npm version (e.g., `"@x402/stellar": "^2.3.0"`).

To build that `.tgz` in the meantime, you need the Stellar support changes from PR [coinbase/x402#711](https://github.com/coinbase/x402/pull/711), which is based on a fork branch (`marcelosalloum/x402:stellar-support`), not a branch in the main `coinbase/x402` repo.

Example checkout options:

```bash
# Option 1: GitHub CLI (recommended)
gh repo clone coinbase/x402
cd x402
gh pr checkout 711

# Option 2: Manual git checkout from the fork branch (TEMPORARY SOLUTION)
git clone https://github.com/coinbase/x402.git
cd x402
git remote add marcelosalloum https://github.com/marcelosalloum/x402.git
git fetch marcelosalloum stellar-support
git checkout -b stellar-support marcelosalloum/stellar-support
```

Then follow the x402 repo instructions to build/pack `@x402/stellar` and update the local `.tgz` path as needed.

### Generate the `@x402/stellar` `.tgz`

After checking out the PR branch in your local `x402` clone, build and pack the Stellar package so the local file dependency exists:

```bash
# Install dependencies (repo root)
pnpm install

# Go to the Stellar mechanism package
cd typescript/packages/mechanisms/stellar

# Build/package the library (if required by the package scripts)
pnpm build

# Generate the .tgz file used by this example
pnpm pack
```

This should produce a tarball like:

```bash
x402-stellar-2.3.0.tgz
```

By default, this example expects it at:

```bash
../../../x402/typescript/packages/mechanisms/stellar/x402-stellar-2.3.0.tgz
```

If the generated filename/version differs, update the `@x402/stellar` entry in `package.json` to match the actual `.tgz` file path.

## Setup

```bash
pnpm install
cp .env-local .env
```

Edit `.env` with your values:

| Variable          | Description                | Default                                          |
| ----------------- | -------------------------- | ------------------------------------------------ |
| `STELLAR_ADDRESS` | Stellar public key (payee) | _(required)_                                     |
| `FACILITATOR_URL` | Relayer plugin endpoint    | `http://localhost:8080/api/v1/plugins/x402/call` |
| `RELAYER_API_KEY` | Auth key for the relayer   | _(required)_                                     |
| `PORT`            | Server port                | `4021`                                           |

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env-local .env
# Edit .env with your STELLAR_ADDRESS, FACILITATOR_URL, and RELAYER_API_KEY

# 3. Start the server (start this before the client)
pnpm start
```

## Endpoints

| Method | Path       | Price  | Description     |
| ------ | ---------- | ------ | --------------- |
| GET    | `/health`  | Free   | Health check    |
| GET    | `/weather` | $0.001 | Weather data    |
| GET    | `/premium` | $0.01  | Premium content |

## Verify

```bash
# Should return {"status":"ok"}
curl http://localhost:4021/health

# Should return 402 Payment Required
curl http://localhost:4021/weather
```
