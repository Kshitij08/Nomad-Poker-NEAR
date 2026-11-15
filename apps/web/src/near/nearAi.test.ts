import { describe, expect, it } from 'vitest';
import { recoverSigner, sealStrategy, verifyNearAiProof, type NearAiProof } from './nearAi';
import proofs from './__fixtures__/ailive-1-near-ai.json';

describe('NEAR-AI in the browser', () => {
  it('seals byte for byte like near/feeder/src/nearai.ts', () => {
    const sk = new Uint8Array(32).map((_, i) => i + 1);
    const pk = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    expect(sealStrategy('Play tight early, bluff rivers.', pk, 'nomad-b', sk)).toEqual({
      eph: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c',
      ct: '820af4a71781c776786a46be366ebc6d3bd42411eafe78acf8813f42906c0b436d56cb9e574ecd50985e75e08b6fa5',
    });
  });

  it('refuses an empty or too long strategy', () => {
    const pk = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    expect(() => sealStrategy('', pk, 'a')).toThrow();
    expect(() => sealStrategy('x'.repeat(1001), pk, 'a')).toThrow();
  });

  it('verifies the real proofs from testnet session ailive-1', () => {
    const list = proofs as NearAiProof[];
    expect(list.length).toBe(2);
    for (const p of list) {
      expect(recoverSigner(p.signature_text, p.signature)).toBe(p.signing_address.toLowerCase());
      expect(verifyNearAiProof(p, [p.signing_address.toLowerCase()])).toBe(true);
    }
  });

  it('rejects an edited reply, a swapped profile or an unattested signer', () => {
    const p = (proofs as NearAiProof[])[0]!;
    expect(verifyNearAiProof({ ...p, response: p.response.replace('"', ' "') })).toBe(false);
    expect(verifyNearAiProof({ ...p, profile: { ...p.profile, aggression: p.profile.aggression === 50 ? 51 : 50 } })).toBe(false);
    expect(verifyNearAiProof(p, ['0x0000000000000000000000000000000000000001'])).toBe(false);
  });
});
