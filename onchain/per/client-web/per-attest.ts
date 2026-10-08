// In-browser attestation of MagicBlock's TEE validator, for the Unity WebGL client's "verified" badge.
// Bundled to Assets/StreamingAssets/per-attest.js (npm script: build:attest). The page calls
// window.PokerPerAttest.verify(teeUrl, pins) and gets a JSON report.
//
// What passing means:
//  1. /fast-quote returns a genuine Intel TDX quote (Intel's collateral, checked here), TCB up to date;
//  2. its measurements (MRTD, RTMR0-3, MRCONFIGID, MROWNER) equal the pinned ones: the enclave runs the
//     same image we observed;
//  3. its report data is sha512 of an Ed25519 key, that key is the pinned one, and it signed our fresh
//     random challenge: the quote is live, not replayed.
// What it can't show (MagicBlock-side, item 8 of our report to them): that this enclave is the
// validator our transactions reach. Nothing in the quote names the validator or the TLS connection.
import nacl from "tweetnacl";
import { sha512 } from "@noble/hashes/sha2";
const dcap = require("@phala/dcap-qvl");

export type Pins = { mrTd: string; rtMr0: string; rtMr1: string; rtMr2: string; rtMr3: string; mrConfigId: string; mrOwner: string; key: string };
export type Report = { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[]; ms: number };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

export async function verify(teeUrl: string, pins: Pins): Promise<Report> {
  const t0 = Date.now();
  const checks: Report["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); return ok; };
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(64));
    const challengeB64 = btoa(String.fromCharCode(...challenge));
    const r = await fetch(`${teeUrl}/fast-quote?challenge=${encodeURIComponent(challengeB64)}`);
    const body = await r.json();
    if (!add("TEE returned a quote", r.status === 200 && typeof body.quote === "string", `HTTP ${r.status}`)) return done();
    const raw = b64(body.quote);
    const collateral = await dcap.getCollateral("https://pccs.phala.network/tdx/certification/v4", raw);
    const result = dcap.verify(raw, collateral, Math.floor(Date.now() / 1000));
    const tcb = result?.status ?? result?.tcbStatus;
    add("genuine Intel TDX quote", true);
    add("TCB up to date", tcb === "UpToDate", String(tcb));
    const td = dcap.Quote.parse(raw).report.asTd10();
    if (!add("TDX 1.0 report", !!td)) return done();
    for (const [name, got] of [["mrTd", td.mrTd], ["rtMr0", td.rtMr0], ["rtMr1", td.rtMr1], ["rtMr2", td.rtMr2], ["rtMr3", td.rtMr3], ["mrConfigId", td.mrConfigId], ["mrOwner", td.mrOwner]] as [keyof Pins, Uint8Array][])
      add(`${name} matches the pinned measurement`, hex(got) === pins[name], hex(got).slice(0, 16));
    const pk = b64(body.pubkey ?? "");
    add("enclave key is the pinned key", pk.length === 32 && base58(pk) === pins.key, pk.length === 32 ? base58(pk) : "missing");
    add("report data commits to that key (sha512)", hex(td.reportData) === hex(sha512(pk)));
    add("the key signed our fresh challenge", nacl.sign.detached.verify(challenge, b64(body.signature ?? ""), pk));
  } catch (e: any) {
    add("attestation ran", false, String(e?.message ?? e).slice(0, 200));
  }
  return done();
  function done(): Report { return { ok: checks.length > 0 && checks.every((c) => c.ok), checks, ms: Date.now() - t0 }; }
}

(globalThis as any).PokerPerAttest = { verify };
