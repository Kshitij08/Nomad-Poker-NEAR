/**
 * M9: the player's game balance (a vault the program controls, in the rollup) and the play key that spends it.
 * Port of Per/Unity/PerGameWallet.cs. The wallet signs only Solana transactions it can preview (open the vault,
 * deposit, withdraw) and one message per play key; buy-ins, cash-outs and moving money out of the vault are signed by
 * the play key or the seat's table key.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PlayerPrefs } from '../../app/services';
import type { PerHttp } from '../lib/http';
import { findPda, permissionOf, PerIds } from './addresses';
import { keypairFromStored, keypairToStored, PerSecrets } from './keys';
import { sol } from './money';
import { LocalSigner, PerRpc, PerTxException, PerUnauthorized, TeeAuth, type PerTransactionSigner } from './rpc';
import { decodeWalletState, eataOf, newVaultSeed, PerVault, PLAY_KEY_DAYS, playKeyMessage, PlayKey, setWalletState, vaultOf, vaultTokenOf, walletStateCached, walletStateOf } from './vault';
import { utf8 } from '../lib/bytes';
import type { TransactionInstruction } from '@solana/web3.js';

/** What PER needs from the browser wallet (SolanaService implements it). */
export interface PerWalletPort {
  readonly address: string | null;
  connect(): Promise<boolean>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransactionBytes(tx: Uint8Array): Promise<Uint8Array>;
}

export type Status = (s: string) => void;

export class PerGameWallet {
  readonly l1: PerRpc;
  private key: PlayKey | null = null;
  private keyRpc: PerRpc | null = null;
  private keyInFlight: Promise<PlayKey> | null = null;
  private keyInFlightWallet: string | null = null;

  constructor(
    private readonly http: PerHttp,
    solanaRpcUrl: string,
    private readonly teeUrl: string,
    readonly wallet: PerWalletPort,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.l1 = new PerRpc(http, solanaRpcUrl);
  }

  /** The connected wallet as a PublicKey (PerWallet.Address). */
  get address(): PublicKey | null {
    return this.wallet.address ? new PublicKey(this.wallet.address) : null;
  }

  private requireAddress(): PublicKey {
    const a = this.address;
    if (!a) throw new Error('no wallet connected');
    return a;
  }

  /** PerWallet.Signer: the wallet signs whole transactions. */
  get signer(): PerTransactionSigner {
    const self = this;
    return {
      get publicKey() {
        return self.requireAddress();
      },
      async signTransaction(tx: Transaction) {
        const bytes = await self.wallet.signTransactionBytes(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
        return Transaction.from(bytes);
      },
    };
  }

  private static pref = (wallet: PublicKey) => `per.playkey.${wallet.toBase58()}`;

  /** The wallet's play key; one request at a time (wallets show one "Sign message" at a time). */
  playKey(status?: Status): Promise<PlayKey> {
    const wallet = this.requireAddress();
    if (this.keyInFlight && this.keyInFlightWallet === wallet.toBase58()) {
      status?.('Waiting for the message signature in your wallet…');
      return this.keyInFlight;
    }
    this.keyInFlightWallet = wallet.toBase58();
    const p = this.playKeyOnce(status);
    this.keyInFlight = p;
    p.finally(() => {
      if (this.keyInFlight === p) this.keyInFlight = null;
    }).catch(() => {});
    return p;
  }

  private async playKeyOnce(status?: Status): Promise<PlayKey> {
    const wallet = this.requireAddress();
    const now = BigInt(Math.floor(this.nowMs() / 1000));
    const keySet = (await this.loadState(wallet)).keySet;
    if (this.key && this.key.wallet.equals(wallet) && this.key.expires > now + 3600n && this.key.keySet === keySet) return this.key;
    const saved = PlayerPrefs.getString(PerGameWallet.pref(wallet), '');
    if (saved) {
      // "key|expires|signature[|key set]": a key saved before M10 names key set 0.
      const parts = saved.split('|');
      const savedSet = parts.length >= 4 && /^\d+$/.test(parts[3]!) ? Number(parts[3]) : 0;
      if (parts.length >= 3 && /^\d+$/.test(parts[1]!) && BigInt(parts[1]!) > now + 3600n && savedSet === keySet) {
        let plain: string | null = null;
        try {
          plain = await PerSecrets.open(parts[0]!);
        } catch (e) {
          console.warn('[PerGameWallet] saved play key unreadable, asking for a new one:', (e as Error).message ?? e);
        }
        if (plain) {
          this.key = new PlayKey(keypairFromStored(plain), wallet, BigInt(parts[1]!), bs58.decode(parts[2]!), savedSet);
          this.keyRpc = null;
          if (!PerSecrets.isSealed(parts[0])) await this.savePlayKey(wallet, this.key);
          return this.key;
        }
      }
    }
    const key = Keypair.generate();
    const expires = now + BigInt(PLAY_KEY_DAYS * 86400);
    status?.('Sign the message in your wallet to let this browser play (no transaction, nothing is sent)…');
    const signature = await this.wallet.signMessage(playKeyMessage(key.publicKey, expires, keySet));
    if (!signature) throw new Error("the wallet didn't sign");
    this.key = new PlayKey(key, wallet, expires, signature, keySet);
    this.keyRpc = null;
    await this.savePlayKey(wallet, this.key);
    return this.key;
  }

  private async savePlayKey(wallet: PublicKey, k: PlayKey): Promise<void> {
    const sealed = await PerSecrets.seal(keypairToStored(k.key));
    PlayerPrefs.setString(PerGameWallet.pref(wallet), `${sealed}|${k.expires}|${bs58.encode(k.signature)}|${k.keySet}`);
  }

  /** M10: reads the wallet's state on Solana (play-key set, current vault) and caches it for vault addresses. */
  async loadState(wallet: PublicKey): Promise<{ keySet: number; seed: Uint8Array }> {
    const st = decodeWalletState(await this.l1.getAccount(walletStateOf(wallet), 'confirmed'));
    setWalletState(wallet, st.keySet, st.seed);
    return st;
  }

  /** M10: cancels every play key this wallet authorized, on every browser (one wallet transaction). */
  async revokePlayKeys(status: Status): Promise<void> {
    const wallet = this.requireAddress();
    status("Approve cancelling this wallet's play keys in your wallet (every browser will ask to sign again)…");
    await this.l1.sendWithWallet([PerVault.revokePlayKeys(wallet)], this.signer);
    this.forget(wallet);
    await this.loadState(wallet);
    status('Play keys cancelled. The next action here asks you to sign a new message.');
  }

  /** This browser already has an authorized play key for the wallet (reading the balance won't prompt). */
  hasPlayKey(wallet: PublicKey): boolean {
    const parts = PlayerPrefs.getString(PerGameWallet.pref(wallet), '').split('|');
    return parts.length >= 3 && /^\d+$/.test(parts[1]!) && BigInt(parts[1]!) > BigInt(Math.floor(this.nowMs() / 1000)) + 3600n;
  }

  async hasVault(key: PlayKey, wallet: PublicKey): Promise<boolean> {
    try {
      return (await (await this.keyRpcFor(key)).getAccount(vaultTokenOf(wallet), 'processed')) !== null;
    } catch {
      return false;
    }
  }

  /** The play key's rollup login (no wallet prompt). */
  async keyRpcFor(key: PlayKey): Promise<PerRpc> {
    if (this.keyRpc) return this.keyRpc;
    const token = await TeeAuth.login(this.http, this.teeUrl, new LocalSigner(key.key));
    return (this.keyRpc = new PerRpc(this.http, `${this.teeUrl}?token=${token}`));
  }

  /** Sends `ix` (with the play key's check right before) from the play key. */
  async sendAsKey(key: PlayKey, ix: TransactionInstruction): Promise<string> {
    let rpc = await this.keyRpcFor(key);
    try {
      return await rpc.send([key.check(), ix], new LocalSigner(key.key));
    } catch (e) {
      if (e instanceof PerUnauthorized) {
        this.keyRpc = null;
        rpc = await this.keyRpcFor(key);
        return rpc.send([key.check(), ix], new LocalSigner(key.key));
      }
      if (e instanceof PerTxException && isStaleAuthorization(e)) {
        this.forget(key.wallet);
        throw new Error("this browser's authorization ran out; try again and sign the new message");
      }
      throw e;
    }
  }

  forget(wallet: PublicKey): void {
    PlayerPrefs.deleteKey(PerGameWallet.pref(wallet));
    this.key = null;
    this.keyRpc = null;
  }

  /** The game balance in lamports, or null if the vault isn't open yet. */
  async balance(status?: Status): Promise<bigint | null> {
    if (!(await this.vaultOpen())) return null;
    const key = await this.playKey(status);
    let data: Uint8Array | null;
    try {
      data = await (await this.keyRpcFor(key)).simulateReturn([key.check(), PerVault.balance(key)], new LocalSigner(key.key));
    } catch (e) {
      if (e instanceof PerTxException && isStaleAuthorization(e)) {
        this.forget(key.wallet);
        throw new Error("this browser's authorization ran out; tap again and sign the new message");
      }
      throw e;
    }
    return data ? new DataView(data.buffer, data.byteOffset).getBigUint64(0, true) : 0n;
  }

  /** The vault is open and safe to fund: its rollup token account and permission are delegated to the TEE, public. */
  async vaultOpen(): Promise<boolean> {
    const wallet = this.requireAddress();
    await this.loadState(wallet);
    const eata = eataOf(vaultOf(wallet));
    const permission = permissionOf(eata);
    const e = await this.l1.getAccountWithOwner(eata);
    const p = await this.l1.getAccountWithOwner(permission);
    const dlp = PerIds.delegationProgram.toBase58();
    if (!(e?.owner === dlp && p?.owner === dlp && p.data.length > 34 && p.data[34] === 0)) return false;
    return (await this.delegatedToTee(eata)) && (await this.delegatedToTee(permission));
  }

  private async delegatedToTee(account: PublicKey): Promise<boolean> {
    const record = findPda(PerIds.delegationProgram, utf8('delegation'), account.toBytes());
    const r = await this.l1.getAccountWithOwner(record);
    if (!r || r.data.length < 40) return false;
    const v = PerIds.teeValidator.toBytes();
    for (let i = 0; i < 32; i++) if (r.data[8 + i] !== v[i]) return false;
    return true;
  }

  /** Opens the game vault if it isn't open yet (one wallet transaction). `whatNot`: what didn't happen otherwise. */
  async ensureVault(status: Status, whatNot: string): Promise<void> {
    if (await this.vaultOpen()) return;
    const wallet = this.requireAddress();
    const current = walletStateCached(wallet).seed;
    const b = PerVault.blockAccounts(wallet, current);
    if (PerVault.isBlocked(await this.l1.getAccount(b.eataRecord, 'confirmed'), await this.l1.getAccount(b.permission, 'confirmed'), await this.l1.getAccount(b.permissionRecord, 'confirmed'))) {
      status("Your game balance's account was blocked by someone else before its first use (nothing was lost). Approve opening a fresh game balance in your wallet…");
      const next = newVaultSeed();
      await this.l1.sendWithWallet([PerVault.openVaultBudget(), PerVault.newVault(wallet, current, next), PerVault.openVault(wallet, next)], this.signer);
    } else {
      status('Approve opening your game balance in your wallet (one time; about 0.013 SOL of account rent)…');
      await this.l1.sendWithWallet([PerVault.openVaultBudget(), PerVault.openVault(wallet)], this.signer);
    }
    if (!(await this.vaultOpen())) throw new Error("your game balance couldn't be opened safely; " + whatNot);
  }

  /** Opens the vault if needed (one wallet transaction), then deposits (another). */
  async deposit(lamports: bigint, status: Status): Promise<string> {
    const wallet = this.requireAddress();
    await this.ensureVault(status, 'nothing was deposited');
    status(`Approve the deposit of ${sol(lamports)} in your wallet…`);
    const sig = await this.l1.sendWithWallet(PerVault.deposit(wallet, lamports, PerVault.newShuttleId()), this.signer);
    status('Deposit sent. It reaches your game balance in a few seconds.');
    return sig;
  }

  /** What a withdrawal brought to Solana and is waiting to be paid out (vault PDA SOL + its wSOL account). */
  async landed(wallet: PublicKey): Promise<bigint> {
    const r = await this.l1.call('getBalance', vaultOf(wallet).toBase58(), { commitment: 'confirmed' });
    const solLamports = BigInt(r?.value ?? 0);
    const data = (await this.l1.getAccountWithOwner(vaultTokenOf(wallet)))?.data;
    return solLamports + (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n);
  }
}

/** The program refused the authorization (expired by the rollup's clock, or not matching). Code 2 at index 0 is
 * Solana's Ed25519 check refusing the stored signature itself. */
export const isStaleAuthorization = (e: PerTxException): boolean =>
  e.message.includes('PlayKeyExpired') || e.message.includes('BadPlayKeyProof') || (e.programError === 2 && e.instructionIndex === 0);
