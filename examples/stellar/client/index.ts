import { config } from "dotenv";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { Transaction } from "@stellar/stellar-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";

config();

// --- Environment validation ---

const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY;
if (!stellarPrivateKey) {
  console.error("STELLAR_PRIVATE_KEY is required");
  process.exit(1);
}

const serverUrl = process.env.SERVER_URL || "http://localhost:4021";
const concurrentRequests = Number(process.env.CONCURRENT_REQUESTS) || 5;
const stellarRpcUrl =
  process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";

// --- Client setup ---

const stellarSigner = createEd25519Signer(stellarPrivateKey);
const rpcConfig = { url: stellarRpcUrl };
const client = new x402Client();
client.register("stellar:*", new ExactStellarScheme(stellarSigner, rpcConfig));

const payFetch = wrapFetchWithPayment(fetch, client);

// --- Endpoints to test ---

const endpoints = [
  { path: "/weather", label: "Weather ($0.001)" },
  { path: "/premium", label: "Premium ($0.01)" },
];

// --- Run concurrent requests ---

async function main() {
  console.log(
    `Sending ${concurrentRequests} concurrent x402 requests to ${serverUrl}\n`,
  );

  const requests = Array.from({ length: concurrentRequests }, (_, i) => {
    const endpoint = endpoints[i % endpoints.length];
    const url = `${serverUrl}${endpoint.path}`;

    return {
      label: `#${i + 1} ${endpoint.label}`,
      promise: (async () => {
        const start = performance.now();
        const response = await payFetch(url);
        const elapsed = performance.now() - start;
        return { status: response.status, response, elapsed };
      })(),
    };
  });

  const totalStart = performance.now();
  const results = await Promise.allSettled(requests.map((r) => r.promise));
  const totalElapsed = performance.now() - totalStart;

  // --- Results report ---

  let fulfilled = 0;
  let rejected = 0;

  results.forEach((result, i) => {
    const label = requests[i].label;

    if (result.status === "fulfilled") {
      fulfilled++;
      const { status, response, elapsed } = result.value;
      const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
      if (paymentHeader) {
        const settleResponse = decodePaymentResponseHeader(paymentHeader);
        console.log(
          `[${label}] ${status} (${elapsed.toFixed(0)}ms) tx_hash: ${settleResponse.transaction}`,
        );
      } else {
        console.log(`[${label}] ${status} (${elapsed.toFixed(0)}ms)`);
      }
    } else {
      rejected++;
      console.error(`[${label}] FAILED:`, result.reason);
    }
  });

  console.log(`\n--- Summary ---`);
  console.log(
    `Total:     ${concurrentRequests} requests in ${totalElapsed.toFixed(0)}ms`,
  );
  console.log(`Fulfilled: ${fulfilled}`);
  console.log(`Rejected:  ${rejected}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
