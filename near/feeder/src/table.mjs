// Table contract client. The owner key opens sessions; any funded account may settle them.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";

/** Reads a key saved by near-cli ("legacy keychain"): <dir>/<account>.json with a `private_key` field. */
export async function loadKey(accountId, dir = process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", "testnet")) {
  const file = JSON.parse(await readFile(join(dir, `${accountId}.json`), "utf8"));
  if (!file.private_key?.startsWith("ed25519:")) throw new Error(`no ed25519 key for ${accountId} in ${dir}`);
  return file.private_key;
}

export class TableClient {
  constructor({ rpc = "https://rpc.testnet.near.org", contractId, owner, ownerKey, settler, settlerKey }) {
    this.contractId = contractId;
    this.provider = new JsonRpcProvider({ url: rpc });
    this.owner = new Account(owner, this.provider, ownerKey);
    this.settler = new Account(settler, this.provider, settlerKey);
  }

  /** Records a session as requested. Repeating the identical request is accepted, so this is safe to retry. */
  async openSession({ sessionId, stacks, profiles, button, sb, bb, hands }) {
    await this.owner.callFunction({
      contractId: this.contractId,
      methodName: "open_session",
      args: { session_id: sessionId, stacks: stacks.map(String), profiles, button, sb: String(sb), bb: String(bb), hands },
      gas: teraToGas("30"),
    });
  }

  /**
   * Opens a backed session: each seat is an agent bought in from its backer's position. Returns the dealer request
   * the contract recorded (stacks and the agents' profiles), which must be sent to the dealer unchanged.
   */
  async openBackedSession({ sessionId, seats, buyIn, button, sb, bb, hands }) {
    return this.owner.callFunction({
      contractId: this.contractId,
      methodName: "open_backed_session",
      args: { session_id: sessionId, seats, buy_in_chips: String(buyIn), button, sb: String(sb), bb: String(bb), hands },
      gas: teraToGas("100"),
    });
  }

  async getPosition(backer, agentId) {
    return this.provider.callFunction({ contractId: this.contractId, method: "get_position", args: { backer, agent_id: agentId } });
  }

  /** Settles a session with the dealer's answer. The contract re-deals and replays every hand before accepting. */
  async submitSession({ sessionId, alpha, signature_hex, actions }) {
    const out = await this.settler.callFunction({
      contractId: this.contractId,
      methodName: "submit_session",
      args: { session_id: sessionId, alpha, signature_hex, actions },
      gas: teraToGas("300"),
    });
    if (!out?.ok) throw new Error(`the table refused session ${sessionId}: ${out?.error ?? JSON.stringify(out)}`);
    return out;
  }

  async getSession(sessionId) {
    return this.provider.callFunction({ contractId: this.contractId, method: "get_session", args: { session_id: sessionId } });
  }
}
