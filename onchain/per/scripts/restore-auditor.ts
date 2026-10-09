// Sets the program's auditor back to the backend's auditor key (keys folder auditor.json).
import { CONFIG_PDA, loadKey, programFor } from "./lib";
(async () => {
  const deployer = loadKey("deployer"), auditor = loadKey("auditor").publicKey;
  const sig = await programFor(deployer).methods.setAuditor(auditor).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc();
  console.log("auditor set to", auditor.toBase58(), sig);
})().catch((e) => { console.error(e); process.exit(1); });
