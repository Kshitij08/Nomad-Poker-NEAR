// M8 research: what MagicBlock's TEE attestation endpoints return on devnet. Checks the quote is a
// genuine Intel TDX quote, whether /fast-quote's signing key is the TEE validator's identity, and
// prints the enclave measurements (MRTD, RTMR0-3) that a client would pin.
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { TEE_URL, TEE_VALIDATOR } from "./lib";
const dcap = require("@phala/dcap-qvl");

async function quoteOf(path: string) {
  const challenge = randomBytes(64);
  const t0 = Date.now();
  const r = await fetch(`${TEE_URL}/${path}?challenge=${encodeURIComponent(challenge.toString("base64"))}`);
  const body: any = await r.json();
  const raw = Buffer.from(body.quote, "base64");
  const collateral = await dcap.getCollateral("https://pccs.phala.network/tdx/certification/v4", raw);
  const verified = dcap.verify(raw, collateral, Math.floor(Date.now() / 1000));
  const q = dcap.Quote.parse(raw);
  const td = q.report.asTd10() ?? q.report.asTd15()?.base;
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const out: any = { path, http: r.status, ms: Date.now() - t0, tcbStatus: verified?.status ?? verified?.tcbStatus ?? null, advisories: verified?.advisory_ids ?? verified?.advisoryIds ?? null,
    mrTd: hex(td.mrTd), rtMr0: hex(td.rtMr0), rtMr1: hex(td.rtMr1), rtMr2: hex(td.rtMr2), rtMr3: hex(td.rtMr3), mrConfigId: hex(td.mrConfigId), mrOwner: hex(td.mrOwner),
    reportDataIsChallenge: Buffer.from(td.reportData).equals(challenge) };
  if (body.pubkey) {
    const pk = Buffer.from(body.pubkey, "base64");
    out.pubkey = new PublicKey(pk).toBase58();
    out.pubkeyIsTeeValidator = new PublicKey(pk).equals(TEE_VALIDATOR);
    out.signatureOverChallengeValid = nacl.sign.detached.verify(challenge, Buffer.from(body.signature, "base64"), pk);
    out.reportDataIsSha512OfPubkey = Buffer.from(td.reportData).equals(createHash("sha512").update(pk).digest());
    out.challengeEchoed = Buffer.from(body.challenge ?? "", "base64").equals(challenge);
  }
  out.responseKeys = Object.keys(body);
  return out;
}

(async () => {
  const results: any[] = [];
  for (const p of ["quote", "fast-quote"]) {
    try { results.push(await quoteOf(p)); } catch (e: any) { results.push({ path: p, error: String(e?.message ?? e).slice(0, 300) }); }
  }
  console.log(JSON.stringify(results, null, 1));
  fs.writeFileSync(`results/tee-attestation-${Date.now()}.json`, JSON.stringify({ ranAt: new Date().toISOString(), teeUrl: TEE_URL, validator: TEE_VALIDATOR.toBase58(), results }, null, 1));
})();
