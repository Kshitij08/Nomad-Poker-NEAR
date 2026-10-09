// Prints the program config (admin, dev wallet, rake, stake cap, escape delay, auditor).
import { CONFIG_PDA, loadKey, programFor } from "./lib";

(async () => {
  const c: any = await (programFor(loadKey("deployer")).account as any).config.fetch(CONFIG_PDA);
  console.log(JSON.stringify({
    admin: c.admin.toBase58(), devWallet: c.devWallet.toBase58(), rakeBps: c.rakeBps, maxBuyIn: c.maxBuyIn.toString(),
    paused: c.paused, escapeIdleSecs: c.escapeIdleSecs, auditor: c.auditor.toBase58(),
  }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
