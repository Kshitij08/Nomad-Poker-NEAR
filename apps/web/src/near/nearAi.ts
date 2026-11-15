/**
 * NEAR-AI agents in the browser: seal a pro's private strategy to the dealer, and check a session's signed model
 * choices. A port of near/feeder/src/nearai.ts (same bytes, same checks) onto the @noble versions this app uses;
 * `nearAi.test.ts` pins it to the feeder's output.
 *
 * - The pro's text is sealed to the dealer's X25519 key (`get_strategy_key`) with ChaCha20-Poly1305, aad = agent id.
 *   Only the ciphertext goes on chain; the sealed dealer opens it and asks a private model on NEAR AI Cloud (TEE).
 * - Each session record carries the model's signed reply per NEAR-AI seat; `verifyNearAiProof` re-checks it here.
 */
import { x25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { NEAR_CONTRACT, view } from './backing';
import { nearCall } from './wallet';

export const NEAR_AI_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
export const MAX_STRATEGY_BYTES = 1000;

export type ChosenProfile = { fold_below: number; raise_above: number; aggression: number; bluff_chance: number; raise_size: number; position_weight?: number };
export type NearAiProof = {
  seat: number;
  agent_id: string;
  model: string;
  chat_id: string;
  response: string;
  signature_text: string;
  signature: string;
  signing_address: string;
  profile: ChosenProfile;
};
export type PrivateStrategyView = { model: string; sealed_bytes: number; set_at: string };

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => {
  const t = s.replace(/^0x/, '');
  if (t.length % 2 || /[^0-9a-f]/i.test(t)) throw new Error('not hex');
  return Uint8Array.from(t.match(/../g) ?? [], (h) => parseInt(h, 16));
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/** UTF-8 bytes of a strategy text (the limit is in bytes). */
export const strategyBytes = (text: string): number => enc.encode(text).length;

/** Seals the strategy text to the dealer's X25519 key. aad = the agent id. */
export function sealStrategy(text: string, dealerPublicKeyHex: string, agentId: string, ephSecret?: Uint8Array): { eph: string; ct: string } {
  const msg = enc.encode(text);
  if (msg.length === 0 || msg.length > MAX_STRATEGY_BYTES) throw new Error(`Write 1 to ${MAX_STRATEGY_BYTES} characters.`);
  const dealerPk = unhex(dealerPublicKeyHex);
  const sk = ephSecret ?? x25519.utils.randomPrivateKey();
  const eph = x25519.getPublicKey(sk);
  const shared = x25519.getSharedSecret(sk, dealerPk);
  const key = sha256(concat(enc.encode('nomad-strategy-key:'), shared, eph, dealerPk));
  const ct = chacha20poly1305(key, new Uint8Array(12), enc.encode(agentId)).encrypt(msg);
  return { eph: hex(eph), ct: hex(ct) };
}

/** The Ethereum address an EIP-191 signature over `text` recovers to (lowercase, 0x). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error('the signature is not 65 bytes');
  const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  const msg = enc.encode(text);
  const digest = keccak_256(concat(enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return '0x' + hex(keccak_256(pub.subarray(1)).subarray(12));
}

const MIN = [10, 45, 10, 0, 30];
const MAX = [55, 90, 95, 25, 120];
const NAMES = ['fold_below', 'raise_above', 'aggression', 'bluff_chance', 'raise_size'] as const;

/** The profile a completion's raw response chooses (poker_core::nearai::profile_from_response). */
export function profileFromResponse(response: string): ChosenProfile {
  const v = JSON.parse(response);
  const msg = v?.choices?.[0]?.message ?? {};
  for (const k of ['reasoning_content', 'reasoning']) {
    const r = msg[k];
    if (r != null && (typeof r !== 'string' || r.trim() !== '')) throw new Error('the reply includes reasoning text');
  }
  if (typeof msg.content !== 'string') throw new Error('the reply has no content');
  let t = msg.content.trim();
  t = t.startsWith('```json') ? t.slice(7) : t.startsWith('```') ? t.slice(3) : t;
  t = (t.endsWith('```') ? t.slice(0, -3) : t).trim();
  const o = JSON.parse(t);
  const nums = NAMES.map((n) => {
    if (typeof o[n] !== 'number') throw new Error(`the reply has no ${n}`);
    return o[n] as number;
  });
  let pw = typeof o.position_weight === 'number' ? o.position_weight : 0;
  if (nums.every((x) => x <= 1.2)) {
    nums.forEach((x, i) => (nums[i] = x * 100));
    if (pw <= 1) pw *= 100;
  }
  const fit = (x: number, lo: number, hi: number) => Math.round(Math.min(Math.max(Math.sign(x) * Math.round(Math.abs(x)), lo), hi));
  return {
    fold_below: fit(nums[0]!, MIN[0]!, MAX[0]!),
    raise_above: fit(nums[1]!, MIN[1]!, MAX[1]!),
    aggression: fit(nums[2]!, MIN[2]!, MAX[2]!),
    bluff_chance: fit(nums[3]!, MIN[3]!, MAX[3]!),
    raise_size: fit(nums[4]!, MIN[4]!, MAX[4]!),
    position_weight: fit(pw, 0, 100),
  };
}

/** True when one proof checks out: signed text, signature, attested signer (when given), and the profile played. */
export function verifyNearAiProof(p: NearAiProof, allowedSigners: string[] | null = null): boolean {
  try {
    const parts = p.signature_text.split(':');
    const [resp, req] = [parts.pop() ?? '', parts.pop() ?? ''];
    if (parts.join(':') !== p.model) return false;
    if (resp !== hex(sha256(enc.encode(p.response))) || !/^[0-9a-f]{64}$/.test(req)) return false;
    if (recoverSigner(p.signature_text, p.signature) !== p.signing_address.toLowerCase()) return false;
    if (allowedSigners && !allowedSigners.includes(p.signing_address.toLowerCase())) return false;
    const chosen = profileFromResponse(p.response);
    if (!NAMES.every((n) => chosen[n] === p.profile[n]) || (chosen.position_weight ?? 0) !== (p.profile.position_weight ?? 0)) return false;
    return p.chat_id !== '' && p.response.includes(p.chat_id);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ contract

export const getStrategyKey = () => view<string | null>('get_strategy_key');
export const getPrivateStrategy = (agent_id: string) => view<PrivateStrategyView | null>('get_private_strategy', { agent_id });
export const getNearAiSigners = () => view<{ model: string; signing_addresses: string[] }[]>('get_near_ai_signers');
/** Makes an agent you listed a NEAR-AI agent (a new strategy version). */
export const setPrivateStrategy = (agentId: string, sealed: { eph: string; ct: string }, model = NEAR_AI_MODEL) =>
  nearCall(NEAR_CONTRACT, 'set_private_strategy', { agent_id: agentId, model, eph: sealed.eph, ct: sealed.ct }, 0n, 30n);
/** Back to the agent's Strategy-tab profile (a new strategy version). */
export const clearPrivateStrategy = (agentId: string) => nearCall(NEAR_CONTRACT, 'clear_private_strategy', { agent_id: agentId }, 0n, 30n);
