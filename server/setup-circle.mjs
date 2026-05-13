import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { config } from "dotenv";
import { resolve } from "path";
import { mkdirSync } from "fs";

config({ path: resolve("../.env") });

// Make sure recovery folder exists
mkdirSync("./recovery", { recursive: true });

console.log("API Key:", process.env.CIRCLE_API_KEY?.slice(0, 10) + "...");
console.log("Entity Secret:", process.env.CIRCLE_ENTITY_SECRET?.slice(0, 10) + "...");

try {
  const response = await registerEntitySecretCiphertext({
    apiKey: process.env.CIRCLE_API_KEY ?? "",
    entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? "",
    recoveryFileDownloadPath: "./recovery",
  });
  console.log("✅ Entity secret registered successfully");
  console.log("Recovery file saved to ./recovery");
  console.log(response.data);
} catch (err) {
  console.error("❌ Registration failed:", err.message);
}