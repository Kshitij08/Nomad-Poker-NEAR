# Nomad menu (`src/menu`)

Port of `Assets/Scripts/Net/NomadUi/NomadUiHost*.cs` + `NomadDialogs.cs`: the art team's screens in
`Assets/Scenes/PokerUI.unity`, built from `src/data/menu-ui.json` (`node web/tools/extract-unity-menu.mjs`), with the
scene's own SetActive navigation (Button persistent calls) kept and every control bound by NAME.

- Router screen: `'menu'` (the menu scene). It starts on Login when `ctx.services.account.signedIn` is false, else MainMenu.
- Service: `ctx.services.nomad` (`NomadHost`), also `window.__nomad` for debugging.
- Table chrome (via `addTableChrome`): the Setting button → Nomad Settings (with Leave table) and the LEAVE button.
- Dev harness (menu alone, no other modules): http://localhost:5180/assets/menu/dev/preview.html`?screen=Friends`.

## Second wave: adding a partial

The other `NomadUiHost` partials (`.Agents` / `.Strategy` → agents, `.Onchain` → web3, `.Social` → economy,
`.Tournaments` → tournaments) plug in from your module's `install()`:

```ts
import { registerNomadPartial } from '../menu/host';

registerNomadPartial((host, ctx) => {
  const root = host.screen('Friends');               // a screen's root UNode (names: SCREEN_NAMES in host.ts)
  host.bind(root, 'Frame/Tabs/Tab_Requests', () => …); // Bind(root, path, action, replaceNavigation?)
  host.onScreenShown('Friends', () => refresh());      // NomadUiHost.OnScreenShown switch
  host.onRefresh(() => { if (host.isShowing('Friends')) paint(); }); // RefreshAll, once a second
});
```

Partials run after the menu's own binders and before HidePlaceholders / FitTexts (so your labels get the
shrink-to-fit + "…" pass); a partial registered after the menu installed runs at once. Controls of a screen whose
partial has not registered stay inert (they keep only the scene's SetActive navigation).

### NomadHost API (C# name → TS)

| C# | TS |
|---|---|
| `Screen(name)` / `IsShowing` / `Show` | `host.screen(name)` / `host.isShowing(name)` / `host.show(name)` |
| `OnScreenShown` switch | `host.onScreenShown(name, fn)` (returns an unsubscribe) |
| `RefreshSoon` / per-second `RefreshAll` | `host.refreshSoon()` / `host.onRefresh(fn)` |
| `Find(root, "A/B")` (also under Frame169) / bare name = deep search | `host.find(root \| screenName, path)` → `UNode \| null` |
| `Bind(root, path, action, replaceNavigation)` | `host.bind(root, path, action, replace?)` → `MButton` (`.addListener`, `.reset()`, `.disablePersistent()`, `.setInteractable`) |
| `SetText` / `SetActive` / `SetFill` / `SetAvatar` | `host.setText` / `host.setActive` / `host.setFill` / `host.setAvatar(root, path, name, avatar?)` |
| `EnsureClickable` / `GetComponent<Button>() ?? Add…` | `host.ensureClickable(n)` / `host.ensureButton(n)` |
| `RowList(container, prefix)` + `Fill(n, paint)` | `host.rowList(container, prefix).fill(n, (row, i) => …)` (re-runs the list's layout group) |
| `EmptyNote` / `EvenSizes` / `FitTexts` | `host.emptyNote` / `host.evenSizes` / `host.fitTexts(root)` |
| `Run(op, onOk)` (error → message box) | `host.run(async () => errorOrNull, onOk)` |
| `Message` / `Busy` / `CloseMessage` | `host.message(title, body, ok?, onOk?, cancel?, onCancel?, inputPlaceholder?, onInput?, inputValue?)` / `host.busy` / `host.closeMessage` |
| `ShowConnecting` / `CloseConnecting` | `host.showConnecting(onDisconnect)` / `host.closeConnecting()` |
| `Onchain` / `_solShort` | `host.onchain` / `host.solShort` (the web3 partial sets them; DEMO by default) |
| `Short` / `Duration` / `Until` | `NomadHost.short` / `NomadHost.duration` / `NomadHost.until` |
| `NomadDialogs.*` | `host.dialogs`: `message`, `form`, `busy`, `close`, `closeBusy`, `settings(leave?, account)`, `panel(title, [w,h])`, `scrollList(window, [x,y,w,h], spacing)`, `row(content, h)`, `line(parent, text, size, pos, box, color, align)` (TMP rich text), `button(parent, label, yellow, pos, onClick, width)`, `newSlider`, `window`, `addBacking`, `round` |
| `StakeSelection` | `host.stakes` (delegates to `ctx.services.retention.stakes` when installed) |

Widgets on any node: `widgetsOf(n)` from `ui/tree.ts` → `button`, `toggle` (`isOn`, `set`, `setIsOnWithoutNotify`,
`listeners`), `slider` (`value`, `set`, `setValueWithoutNotify`, `listeners`), `input` (`text`, `onValueChanged`,
`onSubmit`: a real `<input>` over the TMP text area), `scroll` (`scrollBy`, `toTop`, `clamp`), `selectable`
(NomadSelectable `setSelected`), `rowFilter` (NomadRowFilter `select`). `instantiate(template, nodeData(template)!, parent)`
from `ui/canvas.ts` clones authored data (runtime edits are not copied); `make(parent, synth(name, {...}))` builds nodes.

Hooks for things that live in other partials in Unity:
- `host.actions.openDailySpin / openWeeklyRewards / openMissions` — default: `Show("LuckySlot_Win")`, retention
  `openWeeklyRewards()` or router `'weekly-reward'`.
- `quickPlayOverrides`, `solTablesHandlers`, `settingsAccountExtras` (screens/mainMenu.ts), `tableSelectOnchain`
  (screens/tableSelect.ts): ONCHAIN Quick Play, "MY SOL TABLES", "Disconnect wallet", SOL stakes in table select.
- `host.afterGuest` (OfferWalletAfterGuest), `host.handlePersistent(method, fn)` (persistent onClick methods other than
  SetActive).
- `tableLeaveHooks.isTournament` (table/nomadTableHud.ts), `PokerLobbyView` (table/pokerLobbyView.ts) for the net module.

## Services the menu calls (all optional; fallbacks in brackets)

`account.signInAsGuest / signInWithGoogle / signInWithEmail / addRecoveryLogin / rename / isGuest / busy / lastError /
keepSignedIn / setKeepSignedIn` [guest-only, "needs the online account service" messages] · `wallet.coins / canAfford`
[10,000 Coins, LocalVirtualWallet's default] · `retention.progression.level / levelProgress01` [LV 1, empty bar] ·
`retention.engagement.canSpin() / previewLogin().canClaim` [no dots, no weekly prompt] · `retention.stakes` [own
StakeSelection on the same PlayerPrefs keys] · `retention.openWeeklyRewards` [router 'weekly-reward'] ·
`net.quickPlay / freePlayJoin({tier, buyIn}) / cancelSearch` [offline single-player table at that stake; on a net error
the menu offers it too] · `theme.setTheme(theme)` [none] · `friends.openAvatarPicker` [message] ·
`backendApi.call(method, path, json, auth)` [marketplace dialogs say the service is offline] · `agentStrategy`
(`values`, `streets`, `applyAll`, `onChanged`, `tag`) [Use / Copy only show the message] · `audio.setVolumes(master,
music, sfx)` [volumes saved but not applied].

## Not here

- `NomadUiHost.Replay.cs`: ported by the agents module (`src/agents/ui/replayDialogs.ts`).
- `TableBuyInPanel.cs`: part of the old ThemePicker TABLES overlay the Nomad flow hides.
- `FusionMenuUsernameSync.cs`, `FusionGameplayOverlayHider.cs`: Fusion menu chrome that does not exist on the web; the
  name shows from `account.displayName`. `MenuRenameBridge.cs` → Rename uses `account.rename` / `setDisplayName`.
- `SafeAreaFitter.cs`: no Nomad screen uses it (the screens fit with NomadCanvasFit's Expand scaler).
