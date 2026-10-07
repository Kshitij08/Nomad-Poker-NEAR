// Compares the program bytes the TEE rollup runs with the ones on Solana L1 (sha256 of the
// program-data account's ELF), to tell whether the rollup has picked up the latest upgrade.
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { connection, loadKey, PROGRAM_ID, teeConnection } from "./lib";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAMDATA_HEADER = 45; // slot (8) + option tag (1) + authority (32) + enum tag (4)

async function main() {
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER);
  const er = await teeConnection(loadKey("deployer"));
  const describe = async (name: string, c: typeof connection) => {
    const a = await c.getAccountInfo(programData);
    if (!a) return { name, found: false };
    const elf = a.data.subarray(PROGRAMDATA_HEADER);
    const end = elf.length - [...elf].reverse().findIndex((b) => b !== 0);
    return { name, found: true, deploySlot: a.data.readBigUInt64LE(4).toString(), bytes: a.data.length, sha256: createHash("sha256").update(elf.subarray(0, end)).digest("hex").slice(0, 16) };
  };
  console.log(JSON.stringify([await describe("L1", connection), await describe("TEE", er)], null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
