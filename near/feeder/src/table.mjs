// Table contract client. The operator (the feeder's own account, named by the owner with `set_operator`) opens
// sessions; any funded account may settle them. The operator cannot call any owner-only method, and its key can be a
// function-call key limited to the session methods, so the feeder never holds the owner's full-access key.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, getTransactionLastResult, teraToGas } from "near-api-js";

/** Reads a key saved by near-cli ("legacy keychain"): <dir>/<account>.json with a `private_key` field. */
export async function loadKey(accountId, dir = process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", "testnet")) {
  const file = JSON.parse(await readFile(join(dir, `${accountId}.json`), "utf8"));
  if (!file.private_key?.startsWith("ed25519:")) throw new Error(`no ed25519 key for ${accountId} in ${dir}`);
  return file.private_key;
}

export class TableClient {
  constructor({ rpc = "https://test.rpc.fastnear.com", contractId, operator, operatorKey, owner, ownerKey, settler, settlerKey }) {
    this.contractId = contractId;
    this.provider = new JsonRpcProvider({ url: rpc });
    // `owner`/`ownerKey` are the old names for the account that opens sessions.
    this.operator = new Account(operator ?? owner, this.provider, operatorKey ?? ownerKey);
    this.settler = settler ? new Account(settler, this.provider, settlerKey) : this.operator;
  }

  /** Records a session as requested. Repeating the identical request is accepted, so this is safe to retry. */
  async openSession({ sessionId, stacks, profiles, button, sb, bb, hands }) {
    await this.operator.callFunction({
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
    const res = await this.operator.callFunctionRaw({
      contractId: this.contractId,
      methodName: "open_backed_session",
      args: { session_id: sessionId, seats, buy_in_chips: String(buyIn), button, sb: String(sb), bb: String(bb), hands },
      gas: teraToGas("100"),
    });
    // The recorded request (what the dealer must get), plus the transaction for reports. `tx` is not sent on.
    return Object.defineProperty(getTransactionLastResult(res), "tx", { value: res.transaction?.hash, enumerable: false });
  }

  async getPosition(backer, agentId) {
    return this.provider.callFunction({ contractId: this.contractId, method: "get_position", args: { backer, agent_id: agentId } });
  }

  /** Settles a session with the dealer's answer. The contract re-deals and replays every hand before accepting. */
  async submitSession({ sessionId, alpha, signature_hex, actions, attest_alpha = null, attest_signature_hex = null }) {
    const res = await this.settler.callFunctionRaw({
      contractId: this.contractId,
      methodName: "submit_session",
      args: { session_id: sessionId, alpha, signature_hex, actions, attest_alpha, attest_signature_hex },
      gas: teraToGas("300"),
    });
    const out = getTransactionLastResult(res);
    if (out && typeof out === "object") out.tx = res.transaction?.hash;
    if (!out?.ok) throw new Error(`the table refused session ${sessionId}: ${out?.error ?? JSON.stringify(out)}`);
    return out;
  }

  async getSession(sessionId) {
    return this.provider.callFunction({ contractId: this.contractId, method: "get_session", args: { session_id: sessionId } });
  }
}
