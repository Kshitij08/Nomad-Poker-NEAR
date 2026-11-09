// The web app's security headers (Phase 7), shared by the Vercel deploy (deploy-vercel.mjs) and the local check
// (serve-dist.mjs). The Content-Security-Policy allows only what the build talks to: this origin, the stage's API,
// game server (https and wss) and PER service (private tables), Solana devnet RPC and MagicBlock's devnet TEE. The old
// stack's Railway backends are not
// allowed (the web3 module already refuses them unless ?web3deployed=1; on a deployed build the policy blocks them too).

/** @param {{ api: string, game: string, per?: string, extraConnect?: string[] }} stage */
export function securityHeaders(stage) {
  const origins = [stage.api, stage.game].filter(Boolean).map((u) => new URL(u).origin);
  const ws = origins.map((o) => o.replace(/^http/, 'ws'));
  // The PER service is plain HTTPS (no sockets). Without it the private tables' lobby, Quick Play and Agents fail
  // with "HTTP 0" (found on staging, 9 Nov: deposits worked, they go to devnet and the rollup directly).
  if (stage.per) origins.push(new URL(stage.per).origin);
  const connect = [
    "'self'",
    ...origins,
    ...ws,
    'https://api.devnet.solana.com',
    'wss://api.devnet.solana.com',
    'https://devnet-tee.magicblock.app',
    'wss://devnet-tee.magicblock.app',
    ...(stage.extraConnect ?? []),
  ];
  const csp = [
    "default-src 'self'",
    // Vite emits module scripts only (no inline script). No WebAssembly: its only user was the TEE badge's verifier,
    // removed 9 Nov 2026.
    "script-src 'self'",
    // The UI sets element styles from script; style attributes need 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Table voice uses the microphone; nothing else.
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}
