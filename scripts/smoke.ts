/*
 x402 Facilitator Plugin — Smoke Test Script

 What it does
 - Checks /supported endpoint to verify plugin is running and returns expected signers
 - Builds a Soroban SAC token transfer, signs auth entries, submits via /settle
 - Verifies the settlement response includes a transaction hash
 - Optionally verifies on-chain that the fee-bump source is the x402-channels-fund address

 Prerequisites
 - Node.js 22+ or Bun (global fetch available)
 - A Stellar key via CLI (`stellar keys`)
 - The payer account must have a trustline and balance for the test asset

 Usage Examples

   # Staging (x402-stg service)
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://channels-stg.openzeppelin.com/x402

   # Testnet (x402-testnet service)
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://channels.openzeppelin.com/testnet/x402

   # Run specific test
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://channels-stg.openzeppelin.com/x402 \
     --test-id supported

   # With on-chain verification of fee-bump source
   tsx scripts/smoke.ts \
     --api-key YOUR_API_KEY \
     --base-url https://channels-stg.openzeppelin.com/x402 \
     --verify-fee-bump-source GBTJBICZWJPEUYJO4HBHBXTBORKBEN4AKA2JQDOQIY7KI4DCBLOASZD3

 Flags / env (args > env > defaults)
   --api-key (API_KEY)               required: API key for authentication
   --base-url (BASE_URL)             required: x402 service URL (e.g. https://channels-stg.openzeppelin.com/x402)
   --account-name (ACCOUNT_NAME)     default: test-account (must exist in `stellar keys`)
   --pay-to (PAY_TO)                 default: same as payer address (self-payment for testing)
   --amount (AMOUNT)                 default: 1 (smallest unit of the asset)
   --asset (ASSET)                   default: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA (testnet USDC SAC)
   --network (NETWORK)               default: stellar:testnet
   --rpc-url (RPC_URL)               default: https://soroban-testnet.stellar.org
   --horizon-url (HORIZON_URL)       default: https://horizon-testnet.stellar.org
   --test-id (TEST_ID)               optional: run only one test (supported, verify, settle)
   --verify-fee-bump-source          optional: verify on-chain fee-bump source address after settle
   --max-timeout (MAX_TIMEOUT)       default: 30 (seconds)
   --debug                           optional: print full responses
*/

import { execSync } from "child_process";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Account,
  authorizeInvocation,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.includes("=") ? a.split("=") : [a, undefined];
    const key = k.replace(/^--/, "").trim();
    if (v !== undefined) out[key] = v;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function getKeypair(accountName?: string): {
  keypair: Keypair;
  address: string;
} {
  const name = accountName || "test-account";
  const address = execSync(`stellar keys address ${name}`, {
    encoding: "utf8",
  }).trim();
  const secret = execSync(`stellar keys show ${name}`, {
    encoding: "utf8",
  }).trim();
  return { keypair: Keypair.fromSecret(secret), address };
}

function getPassphrase(network: string): string {
  return network.includes("pubnet") || network.includes("mainnet")
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

/**
 * Call x402 plugin endpoint
 */
async function callEndpoint(
  baseUrl: string,
  path: string,
  apiKey: string,
  body?: unknown,
  method: string = "POST",
): Promise<{ status: number; data: any }> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

/**
 * Build a Soroban SAC token transfer transaction with signed auth entries.
 * The transaction envelope is NOT signed (relayer rebuilds it).
 */
async function buildTransferWithSignedAuth(opts: {
  rpcServer: rpc.Server;
  passphrase: string;
  keypair: Keypair;
  fromAddress: string;
  toAddress: string;
  amount: string;
  assetContract: string;
  maxTimeoutSeconds: number;
}): Promise<string> {
  const {
    rpcServer,
    passphrase,
    keypair,
    fromAddress,
    toAddress,
    amount,
    assetContract,
    maxTimeoutSeconds,
  } = opts;

  const latest = await rpcServer.getLatestLedger();
  // Auth expiration must be within ceil(maxTimeoutSeconds / 5) ledgers of current ledger
  // Use half the max to stay safely within the window
  const maxLedgerOffset = Math.ceil(maxTimeoutSeconds / 5);
  const validUntil =
    Number(latest.sequence) + Math.max(1, Math.floor(maxLedgerOffset / 2));

  // Build the transfer(from, to, amount) invocation
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(assetContract).toScAddress(),
    functionName: "transfer",
    args: [
      Address.fromString(fromAddress).toScVal(),
      Address.fromString(toAddress).toScVal(),
      xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          lo: xdr.Uint64.fromString(amount),
          hi: xdr.Int64.fromString("0"),
        }),
      ),
    ],
  });

  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  const rootInv = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        invokeArgs,
      ),
    subInvocations: [],
  });

  // Sign the auth entry (this is what the payer signs — not the envelope)
  const signedAuthEntry = await authorizeInvocation(
    keypair,
    validUntil,
    rootInv,
    fromAddress,
    passphrase,
  );

  // Build the transaction with signed auth but unsigned envelope
  const op = Operation.invokeHostFunction({
    func,
    auth: [signedAuthEntry],
  });

  // Placeholder source — relayer replaces this with a channel account
  const placeholderAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );
  const tx = new TransactionBuilder(placeholderAccount, {
    fee: "1000000",
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  // Return XDR WITHOUT signing the envelope
  return tx.toXDR();
}

/**
 * Verify on-chain that the fee-bump source matches expected address
 */
async function verifyFeeBumpSource(
  horizonUrl: string,
  txHash: string,
  expectedSource: string,
): Promise<{ match: boolean; actual?: string }> {
  const url = `${horizonUrl}/transactions/${txHash}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Horizon lookup failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as any;
  const feeBumpSource = data.fee_account;
  return {
    match: feeBumpSource === expectedSource,
    actual: feeBumpSource,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = String(args["api-key"] || process.env.API_KEY || "");
  const baseUrl = String(args["base-url"] || process.env.BASE_URL || "");
  const network = String(
    args["network"] || process.env.NETWORK || "stellar:testnet",
  );
  const passphrase = getPassphrase(network);
  const rpcUrl = String(
    args["rpc-url"] ||
      process.env.RPC_URL ||
      "https://soroban-testnet.stellar.org",
  );
  const horizonUrl = String(
    args["horizon-url"] ||
      process.env.HORIZON_URL ||
      "https://horizon-testnet.stellar.org",
  );
  const accountName = String(
    args["account-name"] || process.env.ACCOUNT_NAME || "test-account",
  );
  const asset = String(
    args["asset"] ||
      process.env.ASSET ||
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  );
  const amount = String(args["amount"] || process.env.AMOUNT || "1");
  const maxTimeout = parseInt(
    String(args["max-timeout"] || process.env.MAX_TIMEOUT || "30"),
    10,
  );
  const testId = (args["test-id"] || process.env.TEST_ID) as string | undefined;
  const debug = Boolean(args["debug"] || process.env.DEBUG);
  const feeBumpSource = (args["verify-fee-bump-source"] ||
    process.env.VERIFY_FEE_BUMP_SOURCE) as string | undefined;

  if (!apiKey) {
    console.error("Set --api-key or API_KEY");
    process.exit(1);
  }
  if (!baseUrl) {
    console.error("Set --base-url or BASE_URL");
    process.exit(1);
  }

  const rpcServer = new rpc.Server(rpcUrl);
  const { keypair, address } = getKeypair(accountName);
  const payTo = String(args["pay-to"] || process.env.PAY_TO || address);

  const paymentRequirements = {
    scheme: "exact" as const,
    network,
    amount,
    payTo,
    maxTimeoutSeconds: maxTimeout,
    asset,
    extra: { areFeesSponsored: true },
  };

  type Ctx = {
    baseUrl: string;
    apiKey: string;
    rpcServer: rpc.Server;
    passphrase: string;
    keypair: Keypair;
    address: string;
    payTo: string;
    amount: string;
    asset: string;
    network: string;
    maxTimeout: number;
    horizonUrl: string;
    feeBumpSource?: string;
    debug: boolean;
    paymentRequirements: typeof paymentRequirements;
  };

  const ctx: Ctx = {
    baseUrl,
    apiKey,
    rpcServer,
    passphrase,
    keypair,
    address,
    payTo,
    amount,
    asset,
    network,
    maxTimeout,
    horizonUrl,
    feeBumpSource:
      typeof feeBumpSource === "string" ? feeBumpSource : undefined,
    debug,
    paymentRequirements,
  };

  const TESTS: {
    id: string;
    label: string;
    run: (ctx: Ctx) => Promise<void>;
  }[] = [
    {
      id: "supported",
      label: "GET /supported — verify plugin is running",
      run: async ({ baseUrl, apiKey, debug }) => {
        const res = await callEndpoint(
          baseUrl,
          "/supported",
          apiKey,
          undefined,
          "GET",
        );
        if (res.status !== 200) {
          throw new Error(
            `/supported returned ${res.status}: ${JSON.stringify(res.data)}`,
          );
        }
        const kinds = res.data?.kinds || res.data?.data?.kinds;
        const signers = res.data?.signers || res.data?.data?.signers;
        if (debug) console.log(JSON.stringify(res.data, null, 2));
        console.log(`   kinds: ${JSON.stringify(kinds)}`);
        if (signers) console.log(`   signers: ${JSON.stringify(signers)}`);
        console.log("   /supported OK");
      },
    },
    {
      id: "verify",
      label: "POST /verify — verify a transfer payload",
      run: async (ctx) => {
        const txXdr = await buildTransferWithSignedAuth({
          rpcServer: ctx.rpcServer,
          passphrase: ctx.passphrase,
          keypair: ctx.keypair,
          fromAddress: ctx.address,
          toAddress: ctx.payTo,
          amount: ctx.amount,
          assetContract: ctx.asset,
          maxTimeoutSeconds: ctx.maxTimeout,
        });

        const body = {
          paymentPayload: {
            x402Version: 2,
            accepted: ctx.paymentRequirements,
            payload: { transaction: txXdr },
          },
          paymentRequirements: ctx.paymentRequirements,
        };

        const res = await callEndpoint(
          ctx.baseUrl,
          "/verify",
          ctx.apiKey,
          body,
        );
        if (ctx.debug) console.log(JSON.stringify(res.data, null, 2));

        const result = res.data?.data || res.data;
        if (result?.isValid) {
          console.log(`   payer: ${result.payer}`);
          console.log("   /verify OK — payload is valid");
        } else {
          throw new Error(
            `/verify rejected: ${result?.invalidReason || JSON.stringify(result)}`,
          );
        }
      },
    },
    {
      id: "settle",
      label: "POST /settle — settle a transfer on-chain",
      run: async (ctx) => {
        const txXdr = await buildTransferWithSignedAuth({
          rpcServer: ctx.rpcServer,
          passphrase: ctx.passphrase,
          keypair: ctx.keypair,
          fromAddress: ctx.address,
          toAddress: ctx.payTo,
          amount: ctx.amount,
          assetContract: ctx.asset,
          maxTimeoutSeconds: ctx.maxTimeout,
        });

        const body = {
          paymentPayload: {
            x402Version: 2,
            accepted: ctx.paymentRequirements,
            payload: { transaction: txXdr },
          },
          paymentRequirements: ctx.paymentRequirements,
        };

        const res = await callEndpoint(
          ctx.baseUrl,
          "/settle",
          ctx.apiKey,
          body,
        );
        if (ctx.debug) console.log(JSON.stringify(res.data, null, 2));

        const result = res.data?.data || res.data;
        if (result?.success && result?.transaction) {
          console.log(`   tx: ${result.transaction}`);
          console.log(`   network: ${result.network}`);
          if (result.payer) console.log(`   payer: ${result.payer}`);

          // On-chain fee-bump source verification
          if (ctx.feeBumpSource) {
            console.log("   Verifying fee-bump source on-chain...");
            // Wait a moment for Horizon to index
            await new Promise((r) => setTimeout(r, 3000));
            const check = await verifyFeeBumpSource(
              ctx.horizonUrl,
              result.transaction,
              ctx.feeBumpSource,
            );
            if (check.match) {
              console.log(
                `   fee_account: ${check.actual} (matches expected x402-channels-fund)`,
              );
            } else {
              console.log(
                `   WARNING: fee_account mismatch! expected=${ctx.feeBumpSource} actual=${check.actual}`,
              );
            }
          }

          console.log("   /settle OK");
        } else {
          throw new Error(
            `/settle failed: ${result?.errorReason || JSON.stringify(result)}`,
          );
        }
      },
    },
  ];

  const selected = testId ? TESTS.filter((t) => t.id === testId) : TESTS;
  if (selected.length === 0) {
    console.error(
      `Unknown --test-id '${testId}'. Available: ${TESTS.map((t) => t.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    "================================================================",
  );
  console.log("  x402 Facilitator Plugin — Smoke Tests");
  console.log(
    "================================================================\n",
  );
  console.log(`  base-url:  ${baseUrl}`);
  console.log(`  network:   ${network}`);
  console.log(`  payer:     ${address}`);
  console.log(`  pay-to:    ${payTo}`);
  console.log(`  asset:     ${asset}`);
  console.log(`  amount:    ${amount}`);
  console.log("");

  const start = Date.now();
  let failed = 0;

  for (const t of selected) {
    console.log(`> ${t.label}...`);
    try {
      await t.run(ctx);
    } catch (err: any) {
      failed++;
      console.error(`   FAILED: ${err?.message || err}`);
      if (debug && err?.stack) console.error(err.stack);
    }
    console.log("");
  }

  const elapsed = Date.now() - start;
  console.log(
    "================================================================",
  );
  if (failed > 0) {
    console.log(`  ${failed} test(s) FAILED (${elapsed}ms)`);
    process.exit(1);
  } else {
    console.log(`  All tests passed (${elapsed}ms)`);
  }
  console.log(
    "================================================================",
  );
}

main().catch((e) => {
  console.error("Fatal:", e?.message || String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
