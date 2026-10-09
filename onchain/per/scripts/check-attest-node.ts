// Runs the browser attestation code (client-web/per-attest.ts) in Node against the live TEE, with the
// game's pins, to check a change before a WebGL build.
import { verify } from "../client-web/per-attest";

const pins = {
  mrTd: "c1ee9c16e3afc506cfe042c5b846a368528f3b37618eafb27469bc114cf914e9222c91618470e7f2b28ac360968270a5",
  rtMr0: "c1f1f2bff33b16d1469134987fcdf0ea3bd9707350cc70e73f086c635a5fc4e96e0d214a7f775608e64d251382f20564",
  rtMr1: "b4fe8751e5d96b726a0dabb86ba821783626d80638caf6ca0045f31f5e4c4e90e20aee96fca711421db5bdc60e5c91ed",
  rtMr2: "51c09b72276c8bcd0e274865a7e0a408ee956a6ccfae8b4edd43467d7585ff352bb89e28f5cb62105114cad7225e11ef",
  rtMr3: "0".repeat(96),
  mrConfigId: "0".repeat(96),
  mrOwner: "44eeaee2768dd9b3a52b41747367e5751b18f7653f087febd7de11bffabbd1d75d4ff353a68154541215863ee7fc2903",
};

verify("https://devnet-tee.magicblock.app", pins).then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1); });
