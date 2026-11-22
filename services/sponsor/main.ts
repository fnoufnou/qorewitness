/**
 * QoreWitness fee sponsor for the free beta ("Free beta: we cover the network fees"), testnet only.
 *
 *   pnpm -s tsx services/sponsor/main.ts           run the API and the top-up loop
 *   pnpm -s tsx services/sponsor/main.ts --once    one top-up pass, then exit
 *
 * Refuses to start unless the chain is qorechain-diana (EVM chain id 9800).
 * See docs/SPONSOR.md.
 */
import { HybridPayer, RpcChainReader } from "./chain.js";
import { loadConfig, loadMnemonic } from "./config.js";
import { createSponsorServer } from "./http.js";
import { consoleLogger as log } from "./log.js";
import { Sponsor } from "./service.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = new RpcChainReader(cfg);
  const payer = await HybridPayer.create(loadMnemonic(cfg.secretFile), cfg);
  const sponsor = new Sponsor(cfg, chain, payer, undefined, log);
  await sponsor.start();
  log.info("start", {
    hotWallet: payer.address(), registry: cfg.registry, capCameraDayUqor: cfg.capCameraDayUqor.toString(),
    capGlobalDayUqor: cfg.capGlobalDayUqor.toString(), maxCameras: cfg.maxCameras, paused: sponsor.paused(),
  });

  const pass = async () => {
    try {
      const r = await sponsor.runOnce();
      log.info("pass", { paid: r.paid, totalUqor: r.totalUqor.toString(), skipped: r.skipped.length });
    } catch (e) {
      log.alert("pass_failed", { error: e instanceof Error ? e.message.split("\n")[0] : "error" });
    }
  };

  if (process.argv.includes("--once")) {
    await pass();
    return;
  }

  const server = createSponsorServer(sponsor, log, cfg.trustedProxies);
  server.listen(cfg.port, cfg.host, () => log.info("listening", { host: cfg.host, port: cfg.port }));
  await pass();
  const timer = setInterval(pass, cfg.loopMinutes * 60_000);
  const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e: unknown) => {
  log.alert("fatal", { error: e instanceof Error ? e.message.split("\n")[0] : "error" });
  process.exitCode = 1;
});
