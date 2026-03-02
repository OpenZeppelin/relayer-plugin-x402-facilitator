import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

config();

// --- Environment validation ---

const stellarAddress = process.env.STELLAR_ADDRESS;
if (!stellarAddress) {
  console.error("STELLAR_ADDRESS is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("FACILITATOR_URL is required");
  process.exit(1);
}

const relayerApiKey = process.env.RELAYER_API_KEY;
if (!relayerApiKey) {
  console.error("RELAYER_API_KEY is required");
  process.exit(1);
}

const stellarNetwork = (process.env.STELLAR_NETWORK ||
  "stellar:pubnet") as `${string}:${string}`;
const port = Number(process.env.PORT) || 4021;

// --- Facilitator client ---

const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  createAuthHeaders: async () => ({
    verify: { Authorization: `Bearer ${relayerApiKey}` },
    settle: { Authorization: `Bearer ${relayerApiKey}` },
    supported: { Authorization: `Bearer ${relayerApiKey}` },
  }),
});

// --- Express app ---

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: stellarNetwork,
            payTo: stellarAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
      "GET /premium": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: stellarNetwork,
            payTo: stellarAddress,
          },
        ],
        description: "Premium content",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      stellarNetwork,
      new ExactStellarScheme(),
    ),
  ),
);

// --- Routes ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/weather", (_req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.get("/premium", (_req, res) => {
  res.json({
    content: {
      title: "Premium Stellar Insights",
      body: "Detailed analysis of the Stellar network performance and trends.",
    },
  });
});

app.listen(port, () => {
  console.log(
    `x402 server listening at http://localhost:${port} (${stellarNetwork})`,
  );
  console.log(`  GET /health   - free`);
  console.log(`  GET /weather  - $0.001`);
  console.log(`  GET /premium  - $0.001`);
});
