// The web app's security headers, shared by the Vercel deploy (deploy-vercel.mjs) and the local check (serve-dist.mjs).
//
// NEAR: NEAR Connect (the wallet picker) loads its wallet list from GitHub, each wallet's icon from that wallet's own
// host, and runs the picked wallet's own script in a sandboxed frame that inherits this page's policy; those scripts
// talk to their wallet's servers and NEAR RPC nodes. The set of hosts changes as wallets are added, so scripts, frames,
// images and connections are allowed from any https origin (and inline, for the wallet frames). The replay of a
// settled agent session runs poker-core as WebAssembly ('wasm-unsafe-eval'). What stays locked: no embedding of this
// page, no plugins, the base URL and form targets are this site only.

/** @param {{ api: string, game: string, extraConnect?: string[] }} stage */
export function securityHeaders(stage) {
  const origins = [stage.api, stage.game].filter(Boolean).map((u) => new URL(u).origin);
  const ws = origins.map((o) => o.replace(/^http/, 'ws'));
  const connect = ["'self'", ...origins, ...ws, 'https:', 'wss:', ...(stage.extraConnect ?? [])];
  const csp = [
    "default-src 'self'",
    // Vite's module scripts, Google Identity Services, NEAR Connect's wallet scripts (inline in their frames), poker-core.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https:",
    // The UI sets element styles from script; style attributes need 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline' https:",
    // Uploaded profile pictures (the API) and the wallets' icons.
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: https:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    // Google sign-in's button and NEAR Connect's wallet frames.
    "frame-src 'self' blob: data: https:",
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
    // Wallets that open a popup (Meteor's web wallet) talk back to this window.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}
