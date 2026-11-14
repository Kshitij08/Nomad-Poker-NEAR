/**
 * The menu's chain hooks, shared by every chain: the Demo (Coins) / On-chain switch and `onchainApi`, the actions the v2
 * screens call. The registered chain's menu partial fills `onchainApi` once it binds (web3/nomad/onchainPartial.ts today).
 */
import { PlayerPrefs } from '../app/services';

const NOMAD_MODE_PREF = 'Nomad.PlayMode';

/** The Nomad menu's Demo (Coins) / On-chain switch, remembered between visits. */
export const NomadPlayMode = {
  get onchain(): boolean {
    return PlayerPrefs.getInt(NOMAD_MODE_PREF, 0) === 1;
  },
  set onchain(v: boolean) {
    PlayerPrefs.setInt(NOMAD_MODE_PREF, v ? 1 : 0);
  },
};

/** On-chain actions for the v2 screens (src/ui2). Filled when the chain's menu partial binds. */
export interface OnchainApi {
  toggleMode(): Promise<void>;
  connectWallet(): Promise<boolean>;
  /** Reads the wallet's game balance again. */
  refreshSol(): Promise<void>;
  deposit(): Promise<void>;
  withdraw(): Promise<void>;
  copyWallet(): void;
  /** The game balance for display, e.g. "◎0.5 ($50.00)" or "Not connected", plus a withdrawal note. */
  balanceText(): string;
  walletAddress(): string | null;
  quickPlay(level: number, buyIn?: bigint): Promise<void>;
  partyCreate(): Promise<void>;
  partyJoin(code: string): Promise<void>;
  openPrivateTables(): void;
  tableStakes(level: number): { blinds: string; minBuyIn: string; buyIn: string; label: string };
  stepBuyIn(level: number, dir: number): unknown;
  setBuyInEnd(level: number, end: 'min' | 'max' | 'double'): unknown;
  joinTable(level: number): unknown;
}
export const onchainApi: Partial<OnchainApi> = {};
