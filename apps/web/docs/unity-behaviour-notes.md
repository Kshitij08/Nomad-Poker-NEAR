# Unity single-player table: behaviour spec for the web port

How the offline single-player table behaves at runtime in the Unity build (branch `web/unity-port`), written so the
web view layer can reproduce it. Everything here was read from the C# sources and the serialized scene/prefab values
listed. The game logic is already ported to `packages/engine/src/` (see "Using the port" at the end). The port is checked
bit-exact against the real C# code by `packages/engine/src/__tests__/parity.test.ts`.

**Which scene counts.** The table scene in the build is `Assets/Test/Test.unity`. Its `PokerGameController` runs the
single-player game whenever no Fusion `NetworkRunner` exists (`Net/PokerNetworkLauncher.cs`). In the shipped WebGL
build, players reach the table through networked Quick Play. The offline controller is effectively the editor and dev
path, but it is the behaviour this milestone copies. Where code defaults and scene values differ, the **scene value
wins**: Unity uses serialized values.

---

## 1. Table settings (`Game/TableSettings.cs` + `Test.unity`)

| Setting | Code default | **Test.unity (use this)** | Meaning |
|---|---|---|---|
| seatCount | 6 | **7** | engine seats. The TableView has 8 seat HUDs, so the 8th is never bound and stays hidden |
| botCount | 5 | **6** | bots fill seats 1..6 |
| startingStack | 5000 | 5000 | every seat, You included |
| smallBlind / bigBlind | 25 / 50 | 25 / 50 | fixed. Single player never uses the stakes ladder |
| playerName | "You" | "You" | |
| useFixedSeed / seed | false / 12345 | false / 12345 | true → `SeededRandom(seed)` deck, bots seeded `seed + seat*101` |
| botThinkMin / Max | 0.6 / 1.4 | 0.6 / 1.4 | s |
| dealDelay | 0.12 | 0.12 | s, after each blind and each hole-card deal |
| dealSettleDelay | 0.9 | **5** | s, after preflop opens and after each board deal |
| actionDelay | 0.4 | 0.4 | s, after each action |
| showdownDelay | 2.0 | 2.0 | s, after Showdown and after **each** pot award |
| betweenHands | 2.5 | 2.5 | s |
| turnTimer | 15 | 15 | s |

`TEST_SCENE_TABLE_SETTINGS` / `DEFAULT_TABLE_SETTINGS` in `core/orchestration/tableSettings.ts`.

(Networked Quick Play server, for later: `PokerServerGame` in the same scene uses seatCount 8, botCount 5,
dealSettleDelay 4, betweenHands 3, turnTimer 20.)

## 2. Seating and binding

- Seat 0 = human: id `human`, name `"You"`, not a bot. Bots go in seats 1..botCount in order: ids `bot{seat}`, names
  **`"Bot 1"` … `"Bot 6"`**, each a `HeuristicBot` with its own randomly drawn personality (classic brain).
  The Quick Play names list (`QuickPlayFreeBots.Names`) is **not** used offline.
- At build time every occupied seat gets `BindSeat(seat, name, stack, isBot)` and unoccupied seats are hidden. The
  TableView starts with every seat HUD hidden: placeholder art ("NAME", "CHECK", the BOT badge, the dealer token)
  must never show unbound.
- `BindSeat` sets the name text and the avatar. The avatar is `AvatarCatalog.None`, so every seat shows the default face
  for its name: `AvatarCatalog.fallbackFor(name)` = FNV-1a(name) % 19 + 1 → sprite
  `Assets/Test/UI/Common_UI/Pro_Pic/<Ids[n-1]>.png`. Verified faces: You → 18 (`pro_pic_025`), Bot 1 → 1, Bot 2 → 16,
  Bot 3 → 11, Bot 4 → 5, Bot 5 → 19, Bot 6 → 15. It also sets the stack text, resets the seat for a new hand, and
  shows the **bot badge** (`Bot_indcator`) for bots, hidden for You. The badge stays for the whole session.
- **Every hand** (`HandStarted`) re-binds every occupied seat the same way, then calls `ResetSeatForHand` (§4).
  Empty seats are hidden.
- The seat order is the identity in single player: engine seat N = HUD slot N, with no rotation.

## 3. Money formatting (`Game/Views/TableMoney.cs`)

- **Coins (single player): plain grouped integers, no currency mark.** `N0`: `1250` → `"1,250"`. This applies to
  stacks, the pot readout, the bet-amount label and every "Call/Bet/Raise N" string. `TableMoney.chips` / `TableMoney.pot`.
- SOL (private PER tables only, network): `TableMoney.custom` = lamports → `"$" + N0` if ≥ 100 or a whole number, else
  `N2` (e.g. `$1.25`, `$250`). Not needed offline. `formatSolDollars` is ported.
- Table select / buy-in screens use N0 too (`"Minimum buy-in: 1,000"`, `"JOIN – 1,000"`).

## 4. What each event draws (presenter → view)

`TableEventPresenter` (ported 1:1) turns each engine event into view calls plus sounds. Seat HUD facts come from the
Test.unity wiring (`Name_Canvas.prefab`):

- **Wired:** `nameText`, `stackText` (format `{0:N0}`), `statusText` (the Bottom_bar chip), `dealerBadge` (`D_Token`)
  + label, `botIndicator`, `winnerBadge` (`Win_Medal`), `turnHighlight` (glow VFX), `turnTimer` (radial Image), and
  the "Hand" strength panel (found by name).
- **Not wired:** `betText` (no "Bet N" label on seats), `cardsText` (no text cards; the 3D dealer draws the cards) and
  `turnTimerText` (no numeric countdown, only the radial).
- **PotView (`Pot_UI.prefab`):** `potText` and `potValue` (hover) are wired. **`messageText` is NOT wired**, so none of
  the centre messages ("Hand #N", "Flop", "Showdown", "X wins …", game over) are visible in the Unity table. The
  presenter still generates them. Showing them on the web would be a visible change from Unity; keep them hidden or
  debug-only.

| Event | View effect | Sound |
|---|---|---|
| HandStarted | `BeginHand(n)`: clear the felt (board, every dealt 3D card, hole cards), pot readout = 0, pot tokens cleared, message `"Hand #n"` (hidden). Per occupied seat: bind (§2), then `ResetSeatForHand`: bet = empty, **status = empty**, turn highlight off, radial stopped, hole cards and hand meter hidden, role token cleared, winner medal off, fold tint removed, reaction bubble hidden. Then stack = snapshot stack, then role token, then status **`"Busted"`** if busted | — |
| BlindPosted | seat stack = stackAfter; pot readout = potAfter, plus pot tokens for the blind. **No status text, no bet label** | — |
| HoleCardsDealt | 3D deal of 2 cards from the deck to the seat along its two splines. **Your cards land face up**, bots' face down. For You, the "Hand" meter turns on (§8) | first seat only: `HoleCardsDealt` (one clip covers the whole deal) |
| BettingRoundChanged | Preflop: nothing. Flop/Turn/River: message `"Flop"`/`"Turn"`/`"River"` (hidden) | Flop/Turn/River: `ChipsToPot` |
| CommunityDealt | board slots for the new cards activate and play their Animator reveal; the river triggers the "river slam" feel (camera shake, bounce, rattle on dealt cards); your hand meter updates | Flop `FlopDealt`, Turn `TurnDealt`, River `RiverDealt` |
| ActionRequested | see §6 | You only: `YourTurn` + turn-timer bed |
| PlayerActed | pot readout = potAfter; seat stack = stackAfter; **status = action text (§5)**. On fold: hide text cards and **your hand meter**, grey the whole seat, and grey that seat's 3D hole cards. **Folded cards stay on the felt, greyed** | §9 |
| Showdown | each in-hand seat's 3D cards flip face up (0.25 s flip); status = hand description, e.g. `"Full House, Kings full of Twos"`; message `"Showdown"` (hidden) | — |
| PotAwarded | seat stack = stackAfter; **winner medal on** (until next hand; split pots light every winner); **pot tokens fly to the winner** (§7); message `"{name} wins {N} ({reason})"` (hidden); then pot readout = potAfter and the remaining pot restacks | `ChipsToWinner`; plus `HandWon` if seat 0 |
| HandEnded | `EndHand()`: the cards-return animation (§10) | `CardsReturned` |
| GameOver | betting panel hidden; message `"{name} wins the game!"` (or `"Game over"`). **Never presented offline** (§11) | — |

## 5. Status text strings (exact)

From `TableEventPresenter.DescribeAction`. N = the seat's **resulting total bet this street** (`PlayerActed.amount`),
formatted N0. It is not the delta.

| Action | Status |
|---|---|
| Fold | `Fold` |
| Check | `Check` |
| Call | `Call 150` (the total now in front of the seat, so a BB of 50 calling a raise to 150 shows "Call 150") |
| Bet | `Bet 100` |
| Raise | `Raise 300` |
| AllIn | `All-In` (a call or raise that empties the stack keeps its "Call N"/"Raise N" text; only the sound changes) |

Other seat statuses: `Busted` (set at hand start for a seat with 0 chips) and the showdown hand description. The
status persists until the seat acts again or the next hand resets it. Blinds leave it empty.

Hand descriptions (`HandValue.describe`): `Royal Flush`, `Straight Flush, Nine high`, `Four of a Kind, Sixs`,
`Full House, Threes full of Nines`, `Flush, Ace high`, `Straight, Five high`, `Three of a Kind, Twos`,
`Two Pair, Tens and Fours`, `Pair of Aces`, `High Card, Ace`. Plurals add a bare "s" (**"Sixs"** is Unity's actual
output; kept faithfully).

## 6. Turns, think time, timer and timeout (`PokerGameController.OnActionRequested`)

1. `SetTurn(seat, 15)`: that seat's turn highlight (glow) on and all others off. Its **radial timer** drains 1 → 0 over
   15 s. This happens for bots too, though bots act in about a second.
2. If seat 0: play `YourTurn`, then start the countdown bed `timer.mp3` (27.41 s long, volume 0.5). Because it is longer
   than the turn, it starts **12.41 s in**, so its last tick lands on the timeout. Then `BettingPanel.Show(legal,
   myCurrentBet)`.
3. Bot: wait `Random.Range(0.6, 1.4)` s (uniform), then `HeuristicBot.Decide`. The bot does not think again after that.
4. **Timeout at 15 s** (the first response wins): the panel is hidden, then **Check if legal, otherwise Fold**.
5. After the action: if seat 0, stop the timer bed. `ClearTurn(seat)` turns the highlight off and stops the radial.
6. The `PlayerActed` event then shows the status, plays the action sound and waits 0.4 s before the next turn opens.

Order of play: preflop starts left of the big blind. **Heads-up, the button posts the SB and acts first preflop**,
and the BB acts first postflop. Postflop always starts left of the button. Once every opponent is all-in or folded,
the covering player only gets a call/fold decision if they are short of the shove. Otherwise the board runs out with
no more turns.

## 7. Pot readout and token piles (`PotView`, `Pot_UI.prefab`)

- The readout (`potText` + hover `potValue`) shows `TableMoney.pot(pot)`, e.g. `"1,325"`. It updates on every blind,
  action and award.
- Token piles use denominations 1000, 500, 100, 50, 10, 5 (one prefab colour and pile each), with **max 12 tokens
  total**. Each pile rises 0.09 units per token with a ±0.025 depth wobble.
  - Pot **increase**: only the delta is broken down greedily, largest denomination first, capped at 12 total. A leftover
    remainder adds one smallest-denomination token if there is room. Each contribution keeps its own chips.
  - Pot **decrease** (remaining side pots after an award): rebuild from the new total. Pot **0**: clear.
- **Award fly** (`AwardTokensTo`): every visible token flies to the winner seat's transform, moving and shrinking to
  0.4× over **0.6 s with InQuad easing**, staggered **0.05 s** per token, then returns to the pool. It is called
  *before* the pot is set to potAfter, so the remaining pot respawns fresh while these fly. Each `PotAwarded` flies its
  own share, so split pots fly once per winner.
- **Multiple awards are common.** The side-pot layering splits by every distinct contribution level. Any showdown where
  somebody folded after putting in less (say, a folded small blind) gives `"Main pot"` + `"Side pot"` awards, all-in or
  not. Each award gets its own token fly, its own sounds and its **own 2 s pause**. Reasons: `Pot` (single layer),
  `Main pot`, `Side pot`, `Uncontested` (everyone else folded).
- Odd chips go to the first winner left of the button. Awards are emitted in that order.

## 8. Hand-strength meter (local seat only, `SeatView.ShowHandStrength`)

- Shown only while your cards are face up and you have not folded. It is hidden on fold and at every hand reset. It is
  never shown for bots.
- **Percent** = `round_half_even(HandStrength.estimate(hole, board) * 100)`, clamped to 0..100. The board counts only
  once it has 3 or more cards; preflop uses the two-card heuristic. Text: `"73%"`.
- **Category label:** preflop `PAIR` (pocket pair) or `HIGH CARD`. After the flop: `STRAIGHT FLUSH`, `FOUR OF A KIND`,
  `FULL HOUSE`, `FLUSH`, `STRAIGHT`, `THREE OF A KIND`, `TWO PAIR`, `PAIR` or `HIGH CARD`.
- **Bar fill** width = max(12, trackWidth × strength), growing from the left. The colour runs from red
  (0.86,0.16,0.16) at 0, to orange (1,0.58,0.10) at 0.5, to green (0.18,0.78,0.28) at 1, with linear interpolation.
- Recomputed on every `CommunityDealt`. It sits just under the nameplate, aligned with the status chip.

## 9. Sounds (`TableEventPresenter`, `PokerAudio*`, `Assets/Resources/PokerSfxLibrary.asset`)

Mapping (`SFX_LIBRARY` in `core/orchestration/pokerSound.ts`). Files are in `Assets/Sfx/`. "Guard" means the sound
will not restart within that many seconds (real time).

| Moment | Sound | File | Vol | Guard |
|---|---|---|---|---|
| hole cards (once per hand) | HoleCardsDealt | `cards flying dealt.mp3` (3.10 s) | 0.9 | 0.5 |
| street closes (Flop/Turn/River round change) | ChipsToPot | `bet money collect sfx (mp3cut.net).mp3` | 0.8 | 0.1 |
| flop / turn / river dealt | FlopDealt / TurnDealt / RiverDealt | `3 cards dealt (mp3cut.net).mp3` / `4th card dealt (mp3cut.net).mp3` / `final card dealt (mp3cut.net).mp3` | 0.9 | 0.3 |
| fold | Fold | `fold.mp3` | 0.9 | 0.05 |
| check | Check | `check sfx (mp3cut.net).mp3` | 0.9 | 0.05 |
| call | Call | `call sfx (mp3cut.net).mp3` | 0.9 | 0.05 |
| bet or raise | Raise | `raise bet sfx (mp3cut.net).mp3` | 0.9 | 0.05 |
| all-in, **or any action leaving stack 0** | AllIn | `All in complete sfx (mp3cut.net).mp3` | 1.0 | 0.2 |
| every pot award | ChipsToWinner | `winner coins collect sfx (mp3cut.net).mp3` | 0.9 | 0.1 |
| award to seat 0 | HandWon | `win sfx (mp3cut.net).mp3` (2.55 s) | 1.0 | 0.3 |
| your turn | YourTurn | `your turn sfx (mp3cut.net).mp3` | 1.0 | 0.3 |
| your turn countdown | TurnTimer | `timer.mp3` (27.41 s; see §6) | 0.5 | 0 |
| hand ended | CardsReturned | `cards fly back.mp3` (3.03 s) | 0.8 | 0.5 |
| any Button/Toggle click (interactable, left click) | ButtonGeneric | `generic button (mp3cut.net).mp3` | 0.6 | 0.04 |
| join / start buttons | ButtonStart | `join table and start match button (mp3cut.net).mp3` | 0.9 | 0.1 |
| music | MusicIntro, then MusicLoop | `Nomad Poker game BGM.mp3`, then `Nomad Poker game BGM looped.mp3` | 1.0 | — |

- Blinds, Showdown and HandStarted are silent. Only You gets the turn sound and the countdown bed.
- Mix: one-shots play at `master(1.0) × trim(1.0) × sfx(0.6) × entry volume`. Music plays at
  `master × music(0.6)`, intro first, then the loop scheduled seamlessly. Music starts at app start.
- Several awards to You, 2 s apart, replay `HandWon` each time (the guard is only 0.3 s).
- Network-only sounds: PlayerJoined, BotRemoved, ChatMessage, VoiceChat on/off. Reaction has no clip mapped.

## 10. Hand timeline with every pause

All pauses come from the paced event pump (`ProcessEventsUntilHandEnds`). The engine emits synchronously; the pump
plays events back one at a time.

```
StartHand
  HandStarted ............ draw (§4)                                  +0
  BlindPosted SB ......... +0.12 s
  BlindPosted BB ......... +0.12 s
  HoleCardsDealt × N ..... +0.12 s each (seat order 0,1,2…; deal sound on the first)
  RoundChanged(Preflop) .. +dealSettleDelay (5 s scene / 0.9 code) — cards finish flying in
  ActionRequested ........ turn (§6): bot 0.6–1.4 s · You ≤15 s
  PlayerActed ............ +0.4 s
  … more turns …
  RoundChanged(Flop) ..... ChipsToPot, message hidden                 +0
  CommunityDealt(Flop) ... reveal + FlopDealt                         +dealSettleDelay
  … turns … Turn, River likewise (river slam on the 5th slot) …
  Showdown ............... flip cards, statuses = hand names          +2 s
  PotAwarded × k ......... medal, token fly, sounds                   +2 s each
  HandEnded .............. EndHand() → cards fly back + CardsReturned
wait betweenHands (2.5 s) → next StartHand → BeginHand clears anything still in flight
```

- **Uncontested hand:** last fold → +0.4 s → `PotAwarded (Uncontested)` → +2 s → HandEnded. No showdown, the winner's
  cards stay face down, and the closing street plays no ChipsToPot.
- **All-in runout:** after the closing call (+0.4 s), the remaining streets deal back to back, each Round-change and
  Community pair followed by the 5 s settle. **Hole cards are not revealed until the Showdown event**, after the river.
- **EndHand (card return) fires after the last award's 2 s pause.** Then it runs during the 2.5 s between-hands pause:
  1. Every dealt hole card (folded greyed ones included) flips face down (0.25 s), then flies back to the deck along
     its deal spline in reverse (duration = spline length / 20 units/s, InOutQuad). All cards go at once, since
     holeStagger is 0 in the scene.
  2. Each dealt community slot plays its `Slot_0N_Withdrawal` clip (0.667 s).
  3. `BeginHand` of the next hand destroys anything still moving.
- **Deal visuals:** hole cards fly from the deck along per-seat splines with SplineAnimate (Speed mode, 20 units/s,
  EaseInOut). They start face down and settle-flip at the end: face up for You, face down for bots. Both cards of a
  seat fly together; seats are 0.12 s apart. Board slot reveal clips last flop 1.0 s, turn 1.9 s, river 1.33 s.
- **Role tokens** (`D_Token`, dark ink): `D` on the button, `S` on the small blind, `B` on the big blind. Heads-up, the
  button and SB seat shows `D` (code: `DealerAndSmallBlind → "D"`). The token is hidden on other seats and refreshed
  every hand. The button moves to the next funded seat each hand. The first hand's button is seat 0, then 1, 2, …
  Busted seats are skipped.

## 11. Bust, game over, rebuy

- **A bot busts:** its seat stays bound with `"Busted"` status, gets no cards and no role, and is skipped by the button
  and turn order.
- **You bust:** the same applies, and the game **keeps running among the bots** while you watch. The betting panel
  never shows again. There is no rebuy, no "play again" and no prompt offline.
- **Game over** (fewer than 2 funded seats): the engine emits `HandEnded` then `GameOver`. The Unity pump stops at
  `HandEnded`, waits betweenHands and exits, so **`GameOver` is never presented**: the table just sits idle after the
  cards return. (Even if it were presented, the message text is unwired.) The port copies this by default;
  `PokerGameController({…}, view, audio, { presentGameOver: true })` presents it if you want a visible ending.
- Offline single player does not touch the wallet. Stacks are 5,000 play chips per session.

## 12. Betting panel (`Game/UI/BettingPanel.cs`, Test.unity + `Confirm_Panel.prefab`)

Layout: **designed two-step**. `root` is unset, so the three main buttons are **always visible** and only disabled
between turns. `amountPanel` = Confirm_Panel is hidden until you press Bet/Raise.

Main row (labels set in code, `bettingPanelState()` in `core/orchestration/bettingPanelModel.ts`):

| Button | Label | Enabled when | Action |
|---|---|---|---|
| Fold | `Fold` | always on your turn | Fold |
| Check/Call | `Check`, or `Call {callAmount N0}`. This is the **delta to call**, unlike the seat status | canCheck or canCall | Check if canCheck, else Call |
| Bet/Raise | `Raise` if canRaise, else `Bet` | canBet or canRaise | opens the Confirm panel |

Confirm panel (labels authored in the prefab): presets **`MIN`**, **`1/4`**, **`1/2`**, **`3/4`**, **`ALL IN`**, a
slider, an amount label (N0, e.g. `400`; the prefab placeholder `$50` is overwritten), **`-`** and **`+`** step
buttons, **`CONFIRM`**, and a close (X) button.

- The slider holds whole numbers from minRaiseTo to max(minRaiseTo, maxRaiseTo), where both are bet/raise **TO**
  totals. It opens at **minRaiseTo** every turn.
- `MIN` = minRaiseTo. `1/4`, `1/2` and `3/4` = myCurrentBet + trunc((maxRaiseTo − myCurrentBet) × f), a share of the
  **stack behind, not the pot**, clamped to the slider. `ALL IN` = maxRaiseTo.
- `+`/`-` step = minRaiseTo − myCurrentBet − callAmount (the min-raise increment, usually the BB), at least 1, clamped.
  Holding a button repeats after 0.4 s, every 0.08 s. Each step button greys out at its end of the range.
- `CONFIRM` submits **Raise(amount)** if canRaise, else **Bet(amount)**. The panel never sends ActionType.AllIn; ALL IN
  becomes a raise or bet to the max. Close (X) hides the Confirm panel and keeps the turn open.
- When neither bet nor raise is legal (short stack facing a shove), Bet/Raise and ± are disabled and Call is
  `Call {stack}`.
- Keyboard (only on your turn, ignored while a text field has focus): **F** fold, **C** check/call, **R** open the
  amount panel; with the panel open, **Enter / NumpadEnter** confirm, **Esc** close, **↑ / = / Numpad+** step up and
  **↓ / - / Numpad−** step down (held keys repeat), **A** set all-in.
- On timeout the controller hides the panel (main buttons disabled, Confirm panel closed). A late click does nothing,
  because the callback is cleared.

## 13. Table select and buy-in (all network flows; reference only)

None of these feed the offline controller. They lead to networked Quick Play, which can wait.

- **`UI/TableSelectController.cs` ("Choose Your Table",** `Prefabs/UI/NomadScreens/Lobby/TableSelect_TownLobby.prefab`):
  five tables, default index 2 (Town):

  | Key | Name | Stakes | Blinds | Min buy-in | Max buy-in |
  |---|---|---|---|---|---|
  | Solana | Solana | Micro Stakes | 1 / 2 | 50 | 500 |
  | Forest | Forest | Low Stakes | 5 / 10 | 200 | 2,000 |
  | Town | Town | Mid Stakes | 10 / 25 | 500 | 5,000 |
  | Desert | Desert | High Stakes | 25 / 50 | 1,000 | 10,000 |
  | NeonCity | Neon City | Elite Stakes | 50 / 100 | 2,500 | 25,000 |

  - Selecting a card enlarges it (height 254 → 278, raised 21), moves the pedestal and glow, and fills the panel:
    TableName, Stakes, Blinds `"10 / 25"`, `"Minimum buy-in: 500"`, buy-in value N0.
  - Buy-in starts at the table minimum. `-`/`+` step by BB×10; `MIN`, `Double` (×2) and `MAX` set it directly; the
    value is clamped to [min, max].
  - This script launches nothing itself: nothing reads `Selected` or `BuyIn` yet.
- **`Stakes/TableBuyInPanel.cs`** (TABLES overlay): a slider plus a typed amount. The range is
  [tier.minBuyIn, min(tier.startingStack, coins)].
  - Caption: `"{Tier} - blinds {sb} /{bb}"` (sic, no space after the slash).
  - Join button: `"JOIN – {value N0}"` when enabled, else `"NOT ENOUGH BALANCE"`.
  - Join plays `ButtonStart` and calls `FreePlayJoin.Request()` (Quick Play).
- **`Retention/StakeSelectPanel.cs`:**
  - Row caption: `"{Name}   {minBuyIn N0}   ·   {sb N0} / {bb N0}"`. Rows you cannot afford are disabled.
  - Clicking a row you cannot afford shows `"Need {N} Coins to sit at {Name}."`.
  - Status: `"Quick Play → {Name}  ({min} min · {blinds})"` in auto mode, else
    `"{Name}  ·  {min} min buy-in  ·  blinds {blinds}"`.
  - The stake ladder is `StakeCatalog` (ported): Micro 50 (1/2, 200 stack), Low 100 (2/5, 500), Mid 500 (10/25,
    2,500), High 1,000 (25/50, 5,000, the default), Elite 5,000 (100/250, 25,000), High Roller 10,000 (250/500,
    50,000).
- **Wallet:**
  - `LocalVirtualWallet` starts at **10,000 Coins**, saved in PlayerPrefs.
  - Free-play buy-in: `VirtualEconomy.TryDebitFreePlay`. Cash-out returns the stack (`CreditFreePlay`).
  - Signed-in PlayFab accounts use the `FreePlayBank` per-account delta on top of the server balance instead.

## 14. Multiplayer / network-only, skip for now

TurnStarted (server turn with lag-compensated radial `elapsed`), LobbyState / TableRoster / TableEconomy events, the
lobby view (room code, add/remove bot, start, "add funds" rebuy), `(next hand)` pending seats and leaving seats, seat
perspective rotation (`SetLocalPerspective`), reactions and voice indicators, chat, the PER/SOL money tables and
`TableMoney.custom`, tournaments, AFK agents (brain 2 / position weight; ported anyway), the Quick Play bot pack
(`QuickPlayFreeBots`, ported), the disconnect button (offline it just loads the menu scene), and table themes/skins
(`StakeTableSkin`, `ThemeManager`).

---

## Using the port (`packages/engine/src`)

```ts
import { PokerGameController, TEST_SCENE_TABLE_SETTINGS, type TableViewPort, type AudioPort } from './core';

const view: TableViewPort = /* three.js table implementing the calls in §4 + setTurn/clearTurn + betting */;
const audio: AudioPort = /* play(sound) via SFX_LIBRARY, startTurnTimer(s), stopTurnTimer() */;
const game = new PokerGameController(TEST_SCENE_TABLE_SETTINGS, view, audio);
game.start();            // runs hands until fewer than 2 funded seats; game.stop() to leave
```

- `TableViewPort` mirrors `TableView`. `BettingPanelPort` mirrors `BettingPanel.show/hide`; use
  `bettingPanelState()`, `presetAmount()`, `checkCallAction()` and `wagerAction()` for its rules.
- Pauses go through an injectable `wait(seconds, signal)`. The tests drive a full table on a virtual clock this way.
- With `useFixedSeed: true` the deck, the bot personalities and every bot decision are **bit-identical to Unity** for
  the same seed: `DotNetRandom` is a port of `System.Random`, and the bot maths uses float32. Without a fixed seed the
  deck uses `CryptoRandom`; Unity uses a tick-count-seeded `System.Random`, so it is random either way.
