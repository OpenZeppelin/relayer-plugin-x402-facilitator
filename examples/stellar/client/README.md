# x402 Client Example

Concurrent x402 payment client that fires multiple paid requests in parallel against the server example, using Stellar testnet.

## Prerequisites

- Node.js >= 22.18.0
- pnpm
- The [server example](../server/) running locally
- A funded Stellar testnet account (secret key)
  - Create and fund one at the [Stellar Laboratory](https://lab.stellar.org/)

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

| Variable              | Description                          | Default                 |
| --------------------- | ------------------------------------ | ----------------------- |
| `STELLAR_PRIVATE_KEY` | Stellar secret key (starts with `S`) | _(required)_            |
| `SERVER_URL`          | URL of the x402 server example       | `http://localhost:4021` |
| `CONCURRENT_REQUESTS` | Number of parallel requests to fire  | `5`                     |

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env-local .env
# Edit .env with your STELLAR_PRIVATE_KEY

# 3. Make sure the server example is running first, then start the client
pnpm start
```

## Expected Output

```
Sending 5 concurrent x402 requests to http://localhost:4021

[#1 Weather ($0.001)] 200 (320ms) {"report":{"weather":"sunny","temperature":70}}
[#2 Premium ($0.01)] 200 (450ms) {"content":{"title":"Premium Stellar Insights",...}}
[#3 Weather ($0.001)] 200 (310ms) {"report":{"weather":"sunny","temperature":70}}
[#4 Premium ($0.01)] 200 (460ms) {"content":{"title":"Premium Stellar Insights",...}}
[#5 Weather ($0.001)] 200 (325ms) {"report":{"weather":"sunny","temperature":70}}

--- Summary ---
Total:     5 requests in 480ms
Fulfilled: 5
Rejected:  0
```
