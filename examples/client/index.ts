import { config } from "dotenv";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme } from "./stellar/exact/client/scheme";
import { createEd25519Signer } from "./stellar/signer";

config();

// --- Environment validation ---

const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY;
if (!stellarPrivateKey) {
  console.error("STELLAR_PRIVATE_KEY is required");
  process.exit(1);
}

const serverUrl = process.env.SERVER_URL || "http://localhost:4021";
const concurrentRequests = Number(process.env.CONCURRENT_REQUESTS) || 5;

// --- Client setup ---

const stellarSigner = createEd25519Signer(stellarPrivateKey);
const client = new x402Client();
client.register("stellar:*", new ExactStellarScheme(stellarSigner));

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
        const data = await response.json();
        return { status: response.status, data, elapsed };
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
      const { status, data, elapsed } = result.value;
      console.log(
        `[${label}] ${status} (${elapsed.toFixed(0)}ms)`,
        JSON.stringify(data),
      );
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
