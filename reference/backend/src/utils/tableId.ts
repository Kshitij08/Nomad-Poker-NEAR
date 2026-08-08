import { PublicKey } from "@solana/web3.js";

export function tableIdFromString(id: string): Buffer {
  const buf = Buffer.alloc(32);
  buf.write(id);
  return buf;
}

export function tableIdToNumberArray(id: string): number[] {
  return [...tableIdFromString(id)];
}

export function resolveTableIdBytes(tableId: string | number[]): Buffer {
  if (typeof tableId === "string") {
    return tableIdFromString(tableId);
  }
  return Buffer.from(tableId);
}

export function deriveTablePdas(programId: PublicKey, tableId: Buffer) {
  const [tablePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("table"), tableId],
    programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), tableId],
    programId
  );
  return { tablePda, vaultPda };
}
