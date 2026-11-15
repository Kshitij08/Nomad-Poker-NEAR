// OutLayer HTTPS client: submits a dealer call asynchronously, then polls for its answer.
// Async calls avoid the gateway timeout (HTTP 524) that a waiting connection hits when the testnet queue is long.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OutlayerClient {
  /**
   * @param secretsRef { profile, account_id } of the project secrets to attach to each run (the dealer reads
   *                   NEAR_AI_API_KEY from them); the payment key's owner must be on the secret's access list.
   */
  constructor({ api = "https://testnet-api.outlayer.ai", project, paymentKey, secretsRef = null, pollMs = 2000, timeoutMs = 20 * 60_000, fetchImpl = fetch }) {
    if (!project) throw new Error("project is required (owner/name)");
    if (!paymentKey) throw new Error("paymentKey is required");
    Object.assign(this, { api, project, secretsRef, pollMs, timeoutMs, fetch: fetchImpl });
    // Kept off `this` so it never ends up in a log of the client.
    this.#key = paymentKey;
  }
  #key;

  async #request(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(this.api + path, { ...init, headers: { "X-Payment-Key": this.#key, "Content-Type": "application/json", ...init.headers } });
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        if (attempt >= 4) throw new Error(`OutLayer ${path}: HTTP ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`OutLayer ${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
      return body;
    }
  }

  /** Starts a dealer run and returns its call id. */
  async submit(input) {
    const body = await this.#request(`/call/${this.project}`, { method: "POST", body: JSON.stringify({ input, async: true, ...(this.secretsRef ? { secrets_ref: this.secretsRef } : {}) }) });
    if (!body.call_id) throw new Error(`OutLayer did not accept the call: ${JSON.stringify(body)}`);
    return body.call_id;
  }

  /** Waits for a call's answer and returns the dealer's output with OutLayer's run time and cost. */
  async wait(callId) {
    const started = Date.now();
    for (;;) {
      const r = await this.#request(`/calls/${callId}`);
      if (r.status === "completed") {
        const output = typeof r.output === "string" ? JSON.parse(r.output) : r.output;
        return { output, runMs: r.time_ms, cost: r.compute_cost, callId };
      }
      if (r.status !== "pending") throw new Error(`dealer call ${callId} ${r.status}: ${JSON.stringify(r).slice(0, 300)}`);
      if (Date.now() - started > this.timeoutMs) throw new Error(`dealer call ${callId} still pending after ${this.timeoutMs} ms`);
      await sleep(this.pollMs);
    }
  }

  async run(input) {
    return this.wait(await this.submit(input));
  }
}
