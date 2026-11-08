# @nomad/engine

The poker rules shared by everything that runs a table: cards and the seeded deck, the hand evaluator, `PokerEngine`
(betting, side pots, showdown), bots, `PokerGameController`, events and the binary event codec, stakes, retention
rules, tournaments and Agents. A port of the Unity C# core, checked bit-exact against it.

No DOM, no three.js, no I/O: it runs unchanged in the browser, in Node (the local table server) and in Cloudflare
Workers / Durable Objects (the API and table rooms).

```ts
import { PokerEngine } from '@nomad/engine';
import { RewardGrant } from '@nomad/engine/economy/rewards';
```

Every file under `src/` is importable by path (`@nomad/engine/<folder>/<file>`); `agents`, `retention` and
`tournament` also have an index.

## Tests

`npm test` (vitest). The parity tests compare against golden JSON produced by the real C# sources. The golden files are
committed; regenerate them only when the Unity rules change, from a checkout of the Unity repo:

```bash
cd packages/engine/src/__tests__/golden/gen
dotnet run -c Release -p:UNITY_REPO=<path to the Unity Poker checkout> -- ../unity-golden.json
```

(Same for `agents/`, `events/` and `tournament/` — see the header of each parity test.)
