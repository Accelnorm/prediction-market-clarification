import { readFileSync } from "fs";
import { homedir } from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { exact } = require("/home/user/gemini-pm/apps/public-console/node_modules/x402/dist/cjs/schemes/index.js");
const { createKeyPairSignerFromBytes } = require("/home/user/gemini-pm/apps/public-console/node_modules/@solana/kit");

// Load keypair
const keypairBytes = JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"));
const secretKey = Uint8Array.from(keypairBytes);

// Payment requirements from the 402 response
const paymentRequirements = {
  feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
  x402Version: 1,
  scheme: "exact",
  network: "solana-devnet",
  amount: "1000000",
  maxAmountRequired: "1000000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  assetSymbol: "USDC",
  description: "Create a clarification request for 4020.",
  mimeType: "application/json",
  payTo: "DzRbLD4mGwV8TRuS1W79zD9UT3qfyF5DDzTqKqYQWks8",
  resource: "http://127.0.0.1:3000/api/clarify/4020",
  maxTimeoutSeconds: 300,
  extra: {
    cluster: "devnet",
    eventId: "4020",
    feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
    requesterId: null,
    purpose: "clarification_request"
  }
};

// Create signer
const signer = await createKeyPairSignerFromBytes(secretKey);
console.log("Payer address:", signer.address);

// Create and sign payment
const rpcUrl = "https://api.devnet.solana.com";
const payment = await exact.svm.createAndSignPayment(
  signer,
  1,
  paymentRequirements,
  { svmConfig: { rpcUrl } }
);

const paymentWithAccepted = { ...payment, accepted: paymentRequirements };
const encoded = Buffer.from(JSON.stringify(paymentWithAccepted)).toString("base64");

console.log("Payment signed. Submitting to backend...");

// Submit with payment header
const question = "If the NBER formally declares a recession before the deadline but no two consecutive quarters of negative GDP appear in the BEA advance estimates, does this market resolve Yes or No?";

const response = await fetch("http://127.0.0.1:3000/api/clarify/4020", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "payment-signature": encoded
  },
  body: JSON.stringify({ question })
});

const body = await response.json();
console.log("Status:", response.status);
console.log("Response:", JSON.stringify(body, null, 2));
