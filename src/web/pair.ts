/**
 * `pair` command for install.sh: creates the first-run pairing token and code
 * (once) and prints them as two lines, token=... and code=... . After the owner
 * has set a password it prints "claimed" and nothing secret.
 * Runs in the ui container: docker compose run --rm -T ui pair [--new-password]
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { dataPaths, ensureDirs } from "../setup/steps.js";
import { ensurePairing } from "./auth.js";

const p = dataPaths();
ensureDirs(p);
// --new-password: forget the dashboard password (and every session). Camera, keys and account stay.
if (process.argv.includes("--new-password")) rmSync(join(p.uiDir, "auth.json"), { force: true });
const { pairing } = ensurePairing(p.uiDir);
if (pairing) {
  process.stdout.write(`token=${pairing.token}\ncode=${pairing.code}\n`);
} else {
  process.stdout.write("claimed\n");
}
