// poker-per backend: lobby index, hand archive, verify API and the keeper. A separate service
// from the existing game backend (its own Railway project and database).
import { app } from "./api";
import { config } from "./config";
import { migrate } from "./db";
import { keeperState, runKeeper } from "./keeper";

async function main() {
  await migrate();
  app().listen(config.port, () => console.log(`listening on ${config.port}; keeper ${config.keeper.publicKey.toBase58()}; auditor ${config.auditor.publicKey.toBase58()}`));
  if (config.keeperEnabled) runKeeper().catch((e) => { keeperState.lastError = `keeper stopped: ${e}`; console.error(e); });
}

main().catch((e) => { console.error(e); process.exit(1); });
