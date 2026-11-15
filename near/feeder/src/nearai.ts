// NEAR-AI agents in TypeScript: seal a pro's private strategy to the dealer, and verify the model's signed choice.
// Browser-safe (only @noble and fetch), so the web app can import it as is; Node runs it directly (type stripping).
//
// - sealStrategy(): what the pro's browser sends to set_private_strategy. Matches poker_core::seal::seal_strategy.
// - verifyNearAiProof(): checks one proof from a session record (get_session_record(..).near_ai[i]): the signature
//   recovers to the model's signing address, it signs exactly this reply, and the reply says exactly this profile.
// - checkAttestation(): asks NEAR AI Cloud for the model's attestation report with a fresh nonce and checks the quote's
//   report data binds that signing address and the nonce. The full Intel TDX (DCAP) and NVIDIA checks are what
//   https://cloud.near.ai/verify and https://github.com/nearai/nearai-cloud-verifier do; this does not repeat them.
import { x25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const NEAR_AI_API = "https://cloud-api.near.ai/v1";
export const DEFAULT_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
export const MAX_STRATEGY_BYTES = 1000;

export type Profile = {
  fold_below: number;
  raise_above: number;
  aggression: number;
  bluff_chance: number;
  raise_size: number;
  position_weight?: number;
  streets?: unknown[];
  style?: string;
};

export type NearAiProof = {
  seat: number;
  agent_id: string;
  model: string;
  chat_id: string;
  response: string;
  signature_text: string;
  signature: string;
  signing_address: string;
  profile: Profile;
};

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => {
  const t = s.replace(/^0x/, "");
  if (t.length % 2 || /[^0-9a-f]/i.test(t)) throw new Error("not hex");
  return Uint8Array.from(t.match(/../g) ?? [], (h) => parseInt(h, 16));
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/** Seals the strategy text to the dealer's X25519 key (get_strategy_key()). aad = the agent id. */
export function sealStrategy(text: string, dealerPublicKeyHex: string, agentId: string, ephSecret?: Uint8Array): { eph: string; ct: string } {
  const msg = enc.encode(text);
  if (msg.length === 0 || msg.length > MAX_STRATEGY_BYTES) throw new Error(`the strategy must be 1 to ${MAX_STRATEGY_BYTES} bytes`);
  const dealerPk = unhex(dealerPublicKeyHex);
  const sk = ephSecret ?? x25519.utils.randomSecretKey();
  const eph = x25519.getPublicKey(sk);
  const shared = x25519.getSharedSecret(sk, dealerPk);
  const key = sha256(concat(enc.encode("nomad-strategy-key:"), shared, eph, dealerPk));
  const ct = chacha20poly1305(key, new Uint8Array(12), enc.encode(agentId)).encrypt(msg);
  return { eph: hex(eph), ct: hex(ct) };
}

/** The Ethereum address an EIP-191 signature over `text` recovers to (lowercase, 0x). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error("the signature is not 65 bytes");
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const msg = enc.encode(text);
  const digest = keccak_256(concat(enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(digest).toBytes(false);
  return "0x" + hex(keccak_256(pub.subarray(1)).subarray(12));
}

const MIN = [10, 45, 10, 0, 30];
const MAX = [55, 90, 95, 25, 120];
const NAMES = ["fold_below", "raise_above", "aggression", "bluff_chance", "raise_size"] as const;

/** The profile a completion's raw response chooses; the same rules as poker_core::nearai::profile_from_response. */
export function profileFromResponse(response: string): Profile {
  const v = JSON.parse(response);
  const msg = v?.choices?.[0]?.message ?? {};
  for (const k of ["reasoning_content", "reasoning"]) {
    const r = msg[k];
    if (r != null && (typeof r !== "string" || r.trim() !== "")) throw new Error("the reply includes reasoning text");
  }
  if (typeof msg.content !== "string") throw new Error("the reply has no content");
  let t = msg.content.trim();
  t = t.startsWith("```json") ? t.slice(7) : t.startsWith("```") ? t.slice(3) : t;
  t = (t.endsWith("```") ? t.slice(0, -3) : t).trim();
  const o = JSON.parse(t);
  const nums = NAMES.map((n) => {
    if (typeof o[n] !== "number") throw new Error(`the reply has no ${n}`);
    return o[n] as number;
  });
  let pw = typeof o.position_weight === "number" ? o.position_weight : 0;
  if (nums.every((x) => x <= 1.2)) {
    nums.forEach((x, i) => (nums[i] = x * 100));
    if (pw <= 1) pw *= 100;
  }
  // Rust's f64::round rounds halves away from zero; these numbers are never negative after clamping.
  const fit = (x: number, lo: number, hi: number) => Math.round(Math.min(Math.max(Math.sign(x) * Math.round(Math.abs(x)), lo), hi));
  return {
    fold_below: fit(nums[0]!, MIN[0]!, MAX[0]!),
    raise_above: fit(nums[1]!, MIN[1]!, MAX[1]!),
    aggression: fit(nums[2]!, MIN[2]!, MAX[2]!),
    bluff_chance: fit(nums[3]!, MIN[3]!, MAX[3]!),
    raise_size: fit(nums[4]!, MIN[4]!, MAX[4]!),
    position_weight: fit(pw, 0, 100),
    streets: [],
    style: "NEAR AI",
  };
}

export type Check = { what: string; ok: boolean; detail: string };

/**
 * Verifies one NEAR-AI proof. `allowedSigners` (lowercase addresses) is the table's get_near_ai_signers() list for the
 * model; pass null to skip that check.
 */
export function verifyNearAiProof(p: NearAiProof, allowedSigners: string[] | null = null): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (what: string, ok: boolean, detail: string) => checks.push({ what, ok, detail });
  const respHash = hex(sha256(enc.encode(p.response)));
  const parts = p.signature_text.split(":");
  const [resp, req] = [parts.pop() ?? "", parts.pop() ?? ""];
  const model = parts.join(":");
  add("signed text names this model", model === p.model, model);
  add("signed text names this reply", resp === respHash, `sha256(reply) ${respHash}`);
  add("signed text has a request hash", /^[0-9a-f]{64}$/.test(req), "the request (with the private strategy) stays private; only its hash is signed");
  let recovered = "";
  try {
    recovered = recoverSigner(p.signature_text, p.signature);
  } catch (e) {
    recovered = `(${(e as Error).message})`;
  }
  add("signature recovers to the model's signing address", recovered === p.signing_address.toLowerCase(), recovered);
  if (allowedSigners) add("signing address is attested on this table", allowedSigners.includes(p.signing_address.toLowerCase()), p.signing_address);
  let chosen: Profile | null = null;
  try {
    chosen = profileFromResponse(p.response);
  } catch (e) {
    add("reply is a profile", false, (e as Error).message);
  }
  if (chosen) {
    const same = NAMES.every((n) => chosen![n] === p.profile[n]) && (chosen.position_weight ?? 0) === (p.profile.position_weight ?? 0);
    add("reply says exactly the profile played", same, JSON.stringify({ ...chosen, streets: undefined, style: undefined }));
  }
  add("chat id is this reply's", p.chat_id !== "" && p.response.includes(p.chat_id), p.chat_id);
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * The model's TEE attestation for a signing address, with a fresh nonce. Checks that a report for this address
 * exists, echoes the nonce, and that the TDX quote's REPORTDATA is the address (zero-padded to 32 bytes) followed by
 * the nonce. The quote's own signature chain (Intel DCAP) and the GPU evidence: https://cloud.near.ai/verify.
 */
export async function checkAttestation(model: string, signingAddress: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; checks: Check[] }> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const url = `${NEAR_AI_API}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;
  const r = await fetchImpl(url, { headers: { Accept: "application/json", "x-no-aliasing": "true" } });
  const body = await r.json();
  const checks: Check[] = [];
  const add = (what: string, ok: boolean, detail: string) => checks.push({ what, ok, detail });
  const all: any[] = body?.model_attestations ?? [];
  const a = all.find((x) => String(x.signing_address ?? "").toLowerCase() === signingAddress.toLowerCase());
  add("a model attestation names this signing address", Boolean(a), `${all.length} reports: ${all.map((x) => x.signing_address).join(", ")}`);
  if (!a) return { ok: false, checks };
  add("the report echoes our nonce", (a.request_nonce ?? "").toLowerCase() === nonce, a.request_nonce ?? "(none)");
  const want = hex(concat(unhex(signingAddress), new Uint8Array(12), unhex(nonce)));
  let reportData = (a.report_data ?? "").toLowerCase().replace(/^0x/, "");
  if (!reportData && a.intel_quote) {
    // TDX quote v4: 48-byte header, then the TD report body; REPORTDATA is its last 64 bytes (offset 520).
    reportData = hex(unhex(a.intel_quote).subarray(48 + 520, 48 + 584));
  }
  add("the TDX quote's report data binds the address and nonce", reportData === want, reportData || "(no quote)");
  add("GPU evidence is included", Boolean(a.nvidia_payload), a.nvidia_payload ? "nvidia_payload present (verify at cloud.near.ai/verify)" : "missing");
  return { ok: checks.every((c) => c.ok), checks };
}
