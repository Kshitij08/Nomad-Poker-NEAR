/**
 * The table's "verified" badge: MagicBlock's TEE attested in the player's own browser. Port of
 * Per/Unity/PerAttestation.cs + Plugins/WebGL/PerAttest.jslib: loads the same bundle the WebGL build ships
 * (public/assets/web3/per-attest.js, built from per/client-web/per-attest.ts) and calls
 * window.PokerPerAttest.verify(teeUrl, pins). Runs only when a private table opens (never at boot); once per page
 * load when it passes, retried next time when it fails (often a network blip).
 */
export interface AttestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface AttestReport {
  ok: boolean;
  checks: AttestCheck[];
  ms: number;
}

let last: AttestReport | null = null;
let pending: ((r: AttestReport) => void)[] | null = null;

export const PerAttestation = {
  get last(): AttestReport | null {
    return last;
  },

  run(scriptUrl: string, teeUrl: string, pins: Record<string, string>, done: (r: AttestReport) => void): void {
    if (last) return done(last);
    if (pending) {
      pending.push(done);
      return;
    }
    pending = [done];
    const finish = (raw: Partial<AttestReport>) => {
      // Decide from the individual checks, not the script's own summary.
      const checks = Array.isArray(raw.checks) ? raw.checks.filter(Boolean) : [];
      const r: AttestReport = { ok: checks.length > 0 && checks.every((c) => c.ok), checks, ms: raw.ms ?? 0 };
      if (r.ok) last = r;
      const cbs = pending ?? [];
      pending = null;
      for (const cb of cbs) cb(r);
      console.log(`[PerAttestation] ${r.ok ? 'verified' : 'NOT verified'} in ${r.ms} ms`);
    };
    const fail = (name: string, detail: unknown) => finish({ ok: false, checks: [{ name, ok: false, detail: String(detail ?? '') }], ms: 0 });
    const g = globalThis as unknown as { PokerPerAttest?: { verify(url: string, pins: unknown): Promise<AttestReport> } };
    const go = () => g.PokerPerAttest!.verify(teeUrl, pins).then(finish, (e) => fail('attestation ran', e));
    if (g.PokerPerAttest) return void go();
    if (typeof document === 'undefined') return fail('attestation runs in the browser only', 'no document');
    const s = document.createElement('script');
    s.src = scriptUrl;
    s.onload = () => void go();
    s.onerror = () => fail('attestation script loaded', scriptUrl);
    document.head.append(s);
  },
};
