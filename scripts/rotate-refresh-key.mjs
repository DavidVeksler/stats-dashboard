import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error("CLOUDFLARE_API_TOKEN must be set");
}

const key = randomBytes(16).toString("hex");
const windows = process.platform === "win32";
const command = windows ? "cmd.exe" : "npx";
const args = windows
  ? ["/d", "/s", "/c", "npx --no-install wrangler secret put REFRESH_KEY"]
  : ["--no-install", "wrangler", "secret", "put", "REFRESH_KEY"];

const child = spawn(command, args, { env: process.env, stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(key);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) throw new Error(`wrangler secret put failed with exit code ${code}`);

await mkdir(".deploy", { recursive: true });
await writeFile(".deploy/refresh_key.txt", `${key}\n`, { mode: 0o600 });
console.log("Rotated REFRESH_KEY and saved the local copy in .deploy/refresh_key.txt");
