/**
 * @coral-xyz/anchor is CommonJS; the backend is ESM (`"type": "module"`).
 * Use the default export so Node does not require named CJS re-exports at runtime.
 */
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";

export const AnchorProvider = anchor.AnchorProvider;
export const Program = anchor.Program;
export const Wallet = anchor.Wallet;
export { BN };
