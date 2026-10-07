// Prints the poker-per program and config state on devnet.
import { connection, CONFIG_PDA, PROGRAM_ID, programFor, loadKey } from "./lib";

async function main() {
  const program = programFor(loadKey("deployer"));
  const info = await connection.getAccountInfo(PROGRAM_ID);
  console.log("program", PROGRAM_ID.toBase58(), info ? `executable=${info.executable}` : "NOT DEPLOYED");
  const cfg = await (program.account as any).config.fetchNullable(CONFIG_PDA);
  if (!cfg) return console.log("config", CONFIG_PDA.toBase58(), "not initialized");
  console.log("config", CONFIG_PDA.toBase58(), JSON.stringify({
    version: cfg.version, admin: cfg.admin.toBase58(), pendingAdmin: cfg.pendingAdmin?.toBase58() ?? null,
    devWallet: cfg.devWallet.toBase58(), rakeBps: cfg.rakeBps, maxBuyIn: cfg.maxBuyIn.toString(), paused: cfg.paused,
  }));
}
main();
