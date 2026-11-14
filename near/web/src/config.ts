export const NETWORK = "testnet" as const;
export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "table.nomad-poker.testnet";
export const RPC = import.meta.env.VITE_RPC ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io";
/** The contract's chip value: 1 chip = 0.001 NEAR. */
export const CHIP_YOCTO = 10n ** 21n;
/** Value per share is scaled by 1e9 in the contract; a new pool starts at 1.0. */
export const PRICE_SCALE = 1_000_000_000;
export const TGAS = 10n ** 12n;
