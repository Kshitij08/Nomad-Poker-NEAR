# NEAR-AI proofs: ailive-1

From `get_session_record("ailive-1")` on `table.nomad-poker.testnet`, checked with `near/scripts/verify-near-ai.ts`.

### nomad-b (table position 1): verified

Model `Qwen/Qwen3.6-35B-A3B-FP8`, chat `31faa954b03f419c993d417c73589493`, signer `0xfdbd7952498b333206f360d71d97a1e0961e8ddf`.

| Check | Result | Detail |
| --- | --- | --- |
| signed text names this model | ok | Qwen/Qwen3.6-35B-A3B-FP8 |
| signed text names this reply | ok | sha256(reply) 5b96969f23093b7a58d9154c72472a7d429ca53391d1c3fba0443e8e0a0ec10f |
| signed text has a request hash | ok | the request (with the private strategy) stays private; only its hash is signed |
| signature recovers to the model's signing address | ok | 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| signing address is attested on this table | ok | 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| reply says exactly the profile played | ok | {"fold_below":20,"raise_above":45,"aggression":85,"bluff_chance":5,"raise_size":110,"position_weight":70} |
| chat id is this reply's | ok | 31faa954b03f419c993d417c73589493 |

Attestation (fresh nonce, 2026-11-15T02:33:50.096Z):

| Check | Result | Detail |
| --- | --- | --- |
| a model attestation names this signing address | ok | 1 reports: 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| the report echoes our nonce | ok | b291e13bb32d1c2089a1342fbf00f574423e6f356de8660aa7fec8a3edbb9ed0 |
| the TDX quote's report data binds the address and nonce | ok | fdbd7952498b333206f360d71d97a1e0961e8ddf000000000000000000000000b291e13bb32d1c2089a1342fbf00f574423e6f356de8660aa7fec8a3edbb9ed0 |
| GPU evidence is included | ok | nvidia_payload present (verify at cloud.near.ai/verify) |

### nomad-d (table position 0): verified

Model `Qwen/Qwen3.6-35B-A3B-FP8`, chat `58540bbf646a47a8a67c58de7070cde9`, signer `0xfdbd7952498b333206f360d71d97a1e0961e8ddf`.

| Check | Result | Detail |
| --- | --- | --- |
| signed text names this model | ok | Qwen/Qwen3.6-35B-A3B-FP8 |
| signed text names this reply | ok | sha256(reply) c8ea6d644a93cbab70d2e8dd725a840aa5131060c5fc3785d256415951591bfb |
| signed text has a request hash | ok | the request (with the private strategy) stays private; only its hash is signed |
| signature recovers to the model's signing address | ok | 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| signing address is attested on this table | ok | 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| reply says exactly the profile played | ok | {"fold_below":50,"raise_above":75,"aggression":15,"bluff_chance":0,"raise_size":100,"position_weight":40} |
| chat id is this reply's | ok | 58540bbf646a47a8a67c58de7070cde9 |

Attestation (fresh nonce, 2026-11-15T02:33:50.541Z):

| Check | Result | Detail |
| --- | --- | --- |
| a model attestation names this signing address | ok | 1 reports: 0xfdbd7952498b333206f360d71d97a1e0961e8ddf |
| the report echoes our nonce | ok | 68112e0982ab4de951ca32597b44c0486666c083b6fb792b6d2f03b00ac7e2c4 |
| the TDX quote's report data binds the address and nonce | ok | fdbd7952498b333206f360d71d97a1e0961e8ddf00000000000000000000000068112e0982ab4de951ca32597b44c0486666c083b6fb792b6d2f03b00ac7e2c4 |
| GPU evidence is included | ok | nvidia_payload present (verify at cloud.near.ai/verify) |

The TDX quote's signature chain and the GPU evidence: https://cloud.near.ai/verify.
