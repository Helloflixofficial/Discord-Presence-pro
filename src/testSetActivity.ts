import "dotenv/config";
import { Client } from "@xhayper/discord-rpc";
import { getFrames } from "./db.js";

const clientId = "1312641019795345439";

async function main() {
  console.log("Connecting with client ID:", clientId);

  const client = new Client({ clientId });

  const allFrames = await getFrames();
  const largeFrames = allFrames.map((f) => f.url);

  console.log(`Large frames in DB: ${largeFrames.length}`);

  console.log("Logging into Discord...");
  await client.login();
  console.log("Logged in! User:", client.user?.username);

  client.on("debug", (msg) => console.log("[RPC DEBUG]", msg));

  const mpCache = new Map<string, string>();

  console.log("Setting activity...");
  const act = {
    type: 0,
    name: "Custom Presence",
    details: "Testing presence",
    state: "Running",
    largeImageKey: largeFrames[0] || undefined,
    largeImageText: "Main artwork",
    instance: false
  };

  const start = Date.now();
  try {
    const res = await Promise.race([
      client.user?.setActivity(act),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 5000))
    ]);
    console.log(`setActivity succeeded in ${Date.now() - start}ms:`, res);
  } catch (err) {
    console.error("setActivity failed:", err);
  } finally {
    try { client.destroy(); } catch { /* ignore */ }
  }
}

main().catch(console.error);
