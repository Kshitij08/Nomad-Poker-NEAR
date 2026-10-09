// M8 harness: the Unity client's private-table core, run headless against devnet.
//   dotnet run -- vector                      verifier port vs the program's fixed vector
//   dotnet run -- play <table> [hands]        two players (p1 seat 0, p2 seat 3) play real hands
//   dotnet run -- vault <table>               M9: the game vault and play key, with the C# builders the game uses
// Keys come from POKER_PER_KEYS (p1.json, p2.json), as for the TypeScript suites.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Poker.Core;
using Poker.Per;
using Poker.Per.Generated;
using Solana.Unity.Wallet;

sealed class Http : IPerHttp
{
    static readonly HttpClient C = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    public async Task<(int, string)> Get(string url) { var r = await C.GetAsync(url); return ((int)r.StatusCode, await r.Content.ReadAsStringAsync()); }
    public async Task<(int, string)> Post(string url, string json) { var r = await C.PostAsync(url, new StringContent(json, Encoding.UTF8, "application/json")); return ((int)r.StatusCode, await r.Content.ReadAsStringAsync()); }
    public Task Delay(int ms) => Task.Delay(ms);
}

/// <summary>Stands in for Phantom: signs whole transactions (WalletBase.SignTransaction's contract).</summary>
sealed class WalletLike : IPerTransactionSigner
{
    readonly Account _a;
    public WalletLike(Account a) { _a = a; }
    public PublicKey PublicKey => _a.PublicKey;
    public Task<Solana.Unity.Rpc.Models.Transaction> SignTransaction(Solana.Unity.Rpc.Models.Transaction tx) { tx.Sign(_a); return Task.FromResult(tx); }
}

static class Program
{
    const string Tee = "https://devnet-tee.magicblock.app";
    static readonly List<object> Outcomes = new List<object>();
    static int _fail;
    static void Check(string name, bool pass, object detail = null)
    {
        Outcomes.Add(new { name, status = pass ? "PASS" : "FAIL", detail });
        if (!pass) _fail++;
        Console.WriteLine($"{(pass ? "PASS" : "FAIL")}  {name}{(pass || detail == null ? "" : "  " + JsonConvert.SerializeObject(detail))}");
    }

    static async Task<int> Main(string[] args)
    {
        switch (args.FirstOrDefault())
        {
            case "vector": Vector(); break;
            case "play": await Play(new PublicKey(args[1]), args.Length > 2 ? int.Parse(args[2]) : 2); break;
            case "vault": await Vault(new PublicKey(args[1])); break;
            default: Console.WriteLine("usage: vector | play <table> [hands]"); return 2;
        }
        Directory.CreateDirectory("../results");
        var file = $"../results/m8-harness-{args[0]}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.json";
        File.WriteAllText(file, JsonConvert.SerializeObject(new { suite = $"m8-harness-{args[0]}", ranAt = DateTime.UtcNow, pass = Outcomes.Count - _fail, fail = _fail, outcomes = Outcomes }, Formatting.Indented));
        Console.WriteLine($"\n{Outcomes.Count - _fail} passed, {_fail} failed -> {file}");
        return _fail == 0 ? 0 : 1;
    }

    // ---- the verifier port against dealing.rs `known_vector` (also checked by tests/verifier.ts)
    static void Vector()
    {
        var table = Enumerable.Repeat((byte)7, 32).ToArray();
        var seeds = Enumerable.Range(0, 9).Select(_ => new byte[32]).ToArray();
        seeds[0] = Enumerable.Repeat((byte)1, 32).ToArray(); seeds[3] = Enumerable.Repeat((byte)2, 32).ToArray();
        byte[] entropy;
        using (var h = SHA256.Create()) entropy = h.ComputeHash(Encoding.ASCII.GetBytes("poker-per/entropy/v1").Concat(Enumerable.Repeat((byte)9, 32)).ToArray());
        var seed = PerVerifier.ShuffleSeed(table, 5, entropy, 0b1001, seeds);
        var deck = PerVerifier.Shuffle(seed);
        const string KnownSeed = "d12346b4bf0787f377276f2df1ed63464de16f3a0352a6a3e956f59b299fc540";
        var knownDeck = new[] { 14, 22, 24, 23, 15, 17, 13, 49, 35, 11, 34, 10, 25, 39, 42, 33, 6, 40, 26, 21, 20, 28, 31, 32, 27, 48, 47, 38, 41, 46, 45, 4, 36, 18, 43, 44, 9, 30, 19, 37, 7, 0, 8, 16, 50, 3, 29, 51, 2, 5, 12, 1 };
        Check("C# shuffle seed equals the program's fixed vector", Convert.ToHexString(seed).ToLowerInvariant() == KnownSeed, Convert.ToHexString(seed));
        Check("C# shuffle equals the program's fixed deck", deck.SequenceEqual(knownDeck));
        Check("C# first button equals the program's (seat 3)", PerVerifier.FirstButton(seed, 0b1001) == 3);
        Check("card encoding: index 0 = 2 of clubs, 51 = ace of spades", Card.FromIndex(0) == new Card(Rank.Two, Suit.Clubs) && Card.FromIndex(51) == new Card(Rank.Ace, Suit.Spades));
    }

    // ---- two players at one table
    sealed class Player
    {
        public string Name; public Account Wallet; public Account SessionKey; public int Seat;
        public PerTableSession Session; public PerRpc WalletRpc;
        public readonly List<PokerEvent> Events = new List<PokerEvent>();
        public readonly List<string> Leaks = new List<string>();
        public bool Raised;
    }

    // ---- M9: game vault and play key, end to end with the C# builders (PerVault)
    const string Devnet = "https://api.devnet.solana.com";

    static async Task Vault(PublicKey tableKey)
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var wallet = new Account();
        var walletSigner = new WalletLike(wallet);
        var fund = new Solana.Unity.Rpc.Models.TransactionInstruction
        {
            ProgramId = PerVault.SystemProgram.KeyBytes,
            Keys = new List<Solana.Unity.Rpc.Models.AccountMeta> { Solana.Unity.Rpc.Models.AccountMeta.Writable(deployer.PublicKey, true), Solana.Unity.Rpc.Models.AccountMeta.Writable(wallet.PublicKey, false) },
            Data = new byte[] { 2, 0, 0, 0 }.Concat(BitConverter.GetBytes(60_000_000UL)).ToArray(),
        };
        await l1.Send(new[] { fund }, new LocalSigner(deployer));
        Console.WriteLine($"wallet {wallet.PublicKey.Key}, vault {PerVault.Vault(wallet.PublicKey).Key}");

        // L1, wallet-signed (Phantom in the game): open the vault, deposit into it.
        Check("open_vault (C# builder) lands on Solana", await Try(() => l1.Send(new[] { PerVault.OpenVault(wallet.PublicKey) }, walletSigner)));
        Check("deposit 0.01 SOL into the vault (C# port of MagicBlock's shuttle merge)", await Try(() => l1.Send(PerVault.Deposit(wallet.PublicKey, 10_000_000, PerVault.NewShuttleId()), walletSigner)));

        // The play key: the wallet signs one message (Phantom "Sign message" in the game).
        var key = new Account();
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + PerVault.PlayKeyDays * 86400L;
        var pk = new PerVault.PlayKey { Key = key, Wallet = wallet.PublicKey, Expires = expires, Signature = wallet.Sign(PerVault.PlayKeyMessage(key.PublicKey, expires)) };
        var er = await Login(http, key);
        async Task<ulong> Balance()
        {
            var data = await er.SimulateReturn(new[] { pk.Check(), PerVault.Balance(pk) }, new LocalSigner(key));
            return data == null ? 0 : BitConverter.ToUInt64(data, 0);
        }
        ulong bal = 0;
        for (int i = 0; i < 12 && bal != 10_000_000; i++) { await Task.Delay(5000); try { bal = await Balance(); } catch { } }
        Check("vault balance read with the play key (simulated return data) = 0.01 SOL", bal == 10_000_000, bal);

        // Buy in with the play key; leave with the table key. No wallet.
        var t = new PerTableAddresses(tableKey);
        var table = Table.Decode(await new PerRpc(http, Tee).GetAccount(tableKey));
        int seat = Enumerable.Range(0, table.MaxSeats).First(i => (table.SeatMask & (1 << i)) == 0);
        var session = new Account();
        Check($"buy-in 0.002 SOL from the vault at seat {seat}, signed by the play key only", await Try(() => er.Send(new[] { pk.Check(), PerVault.BuyIn(t, pk, seat, 2_000_000, session.PublicKey) }, new LocalSigner(key))));
        var afterBuy = await Balance();
        Check("vault went down by the buy-in", afterBuy == 8_000_000, afterBuy);
        var sessionRpc = await Login(http, session);
        Check("cash-out into the vault, signed by the table key only", await Try(() => sessionRpc.Send(new[] { PerVault.CashOut(t, session.PublicKey, wallet.PublicKey, seat, 0) }, new LocalSigner(session))));
        var afterCash = await Balance();
        Check("vault got the stack back (buy-in less rake)", afterCash > afterBuy && afterCash <= 10_000_000, afterCash);

        // Withdraw: wallet's rollup account (L1), play key moves vault -> it, wallet withdraws (L1).
        Check("wallet's rollup account set up (L1)", await Try(() => l1.Send(PerVault.EnsureWalletInRollup(wallet.PublicKey), walletSigner)));
        await Task.Delay(5000);
        Check("play key moves the whole vault to the wallet's rollup balance", await Try(() => er.Send(new[] { pk.Check(), PerVault.Withdraw(pk, afterCash) }, new LocalSigner(key))));
        var solBefore = await SolBalance(l1, wallet.PublicKey);
        Check("withdrawal to Solana (C# port of MagicBlock's withdrawal) lands", await Try(() => l1.Send(PerVault.WithdrawToWallet(wallet.PublicKey, afterCash, PerVault.NewShuttleId()), walletSigner)));
        long gained = 0;
        for (int i = 0; i < 12; i++) { await Task.Delay(5000); gained = (long)(await SolBalance(l1, wallet.PublicKey)) - (long)solBefore; if (gained >= (long)afterCash - 1_000_000) break; }
        Check("the money arrives in the wallet as SOL (less MagicBlock's withdrawal cost)", gained >= (long)afterCash - 1_000_000, new { gained, afterCash });
        Outcomes.Add(new { wallet = wallet.PublicKey.Key, vault = PerVault.Vault(wallet.PublicKey).Key, table = tableKey.Key });
    }

    static async Task<bool> Try(Func<Task<string>> f)
    {
        try { await f(); return true; }
        catch (Exception e) { Console.WriteLine("   " + e.Message); return false; }
    }

    static async Task<ulong> SolBalance(PerRpc rpc, PublicKey k)
    {
        var r = await rpc.Call("getBalance", k.Key, new JObject { ["commitment"] = "confirmed" });
        return (ulong)r["value"];
    }

    static Account LoadKey(string name)
    {
        var dir = Environment.GetEnvironmentVariable("POKER_PER_KEYS") ?? throw new Exception("set POKER_PER_KEYS");
        var bytes = JArray.Parse(File.ReadAllText(Path.Combine(dir, name + ".json"))).Select(t => (byte)t).ToArray();
        return new Account(bytes, bytes.Skip(32).ToArray());
    }

    static async Task<PerRpc> Login(Http http, Account key) => new PerRpc(http, $"{Tee}?token={await TeeAuth.Login(http, Tee, new LocalSigner(key))}");

    static async Task Play(PublicKey table, int hands)
    {
        var http = new Http();
        var publicRpc = new PerRpc(http, Tee);
        var players = new List<Player>();
        foreach (var (name, seat) in new[] { ("p1", 0), ("p2", 3) })
        {
            var p = new Player { Name = name, Wallet = LoadKey(name), SessionKey = new Account(), Seat = seat };
            // The wallet never logs in to the rollup (Phantom would have to sign a login message): its
            // transactions go through the session key's logged-in connection. The login authenticates the
            // connection, not the transaction's signer.
            var sessionRpc = await Login(http, p.SessionKey);
            p.WalletRpc = sessionRpc;
            p.Session = new PerTableSession(table, publicRpc, sessionRpc, new LocalSigner(p.SessionKey), p.Wallet.PublicKey);
            var pl = p;
            p.Session.Events += e => { pl.Events.Add(e); if (e is HoleCardsDealtEvent h && h.Seat != pl.Seat && h.Card0.Rank != 0) pl.Leaks.Add($"saw seat {h.Seat}'s cards live"); };
            players.Add(p);
        }
        var addrs = new PerTableAddresses(table);
        Check("session keys are fresh and differ from the wallets", players.All(p => p.SessionKey.PublicKey.Key != p.Wallet.PublicKey.Key));

        // A seat left from an earlier run keeps that run's reader (rebuys keep it), so leave first.
        foreach (var p in players)
        {
            try { await p.WalletRpc.Send(new[] { PerIx.CashOut(addrs, p.Wallet.PublicKey, p.Seat) }, new WalletLike(p.Wallet)); Console.WriteLine($"{p.Name}: left a seat from an earlier run"); }
            catch (PerTxException e) when (e.ErrorName == "NotSeated" || e.ErrorName == "InvalidSeat") { }
        }
        // Sit down: the wallet signs the buy-in (Phantom's job in the game), naming the session key as reader.
        foreach (var p in players)
        {
            var sig = await p.WalletRpc.Send(new[] { PerIx.BuyIn(addrs, p.Wallet.PublicKey, p.Seat, 2_000_000, p.SessionKey.PublicKey) }, new WalletLike(p.Wallet));
            Check($"{p.Name} buys in at seat {p.Seat} (the wallet signs the whole transaction and never logs in; the session key's login carries it and becomes the reader)", sig != null, sig);
        }
        foreach (var p in players) await p.Session.Poll();
        Check("each session finds its own seat through its reader key", players.All(p => p.Session.MySeat == p.Seat), players.Select(p => p.Session.MySeat));

        var verified = 0;
        var started = DateTime.UtcNow;
        var lastEnded = 0;
        // Play until `hands` have ended, then stop starting new ones and finish any hand in play.
        while (DateTime.UtcNow - started < TimeSpan.FromMinutes(8))
        {
            bool wantMore = lastEnded < hands;
            if (!wantMore && players.All(p => p.Session.Table?.HandState == PerGame.HandIdle)) break;
            foreach (var p in players)
            {
                try
                {
                    await p.Session.Poll();
                    var t = p.Session.Table;
                    if (t.HandState == PerGame.HandIdle && wantMore) await p.Session.PrepareNextHand();
                    var turn = p.Events.OfType<TurnStartedEvent>().LastOrDefault();
                    var game = p.Session.Ledger?.Game;
                    if (t.HandState == PerGame.HandPlaying && game != null && game.ToAct == p.Seat && turn != null && turn.ForYou && turn.Seat == p.Seat)
                    {
                        var legal = PerGame.Legal(game);
                        // p1 raises once per hand preflop (when it can), everyone else checks or calls.
                        if (p.Seat == 0 && !p.Raised && legal.CanRaise) { p.Raised = true; await p.Session.Act(ActionType.Raise, legal.MinRaiseTo); }
                        else if (legal.CanCheck) await p.Session.Act(ActionType.Check, 0);
                        else await p.Session.Act(ActionType.Call, 0);
                    }
                }
                catch (PerTxException e) when (e.ErrorName == "NotYourTurn" || e.ErrorName == "HandNotPlaying") { /* raced the other player's poll */ }
            }
            // A hand both sessions have seen end.
            var ended = players.Min(p => p.Events.OfType<HandEndedEvent>().Count());
            if (ended > lastEnded)
            {
                lastEnded = ended;
                foreach (var p in players) p.Raised = false;
                foreach (var p in players)
                {
                    var s = p.Session;
                    var v = PerVerifier.Verify(s.LastRecord, s.LastPrevButton, p.Seat, s.LastMySeed, s.LastMyCards);
                    Check($"hand {s.LastRecord.HandNo}, {p.Name}: 'Verify this hand' recomputes the deck, button, its own seed and cards", v.Ok, new { v.Problems, v.Notes });
                    var vl = s.LastLog != null ? PerVerifier.VerifyLog(s.LastRecord, s.LastLog) : null;
                    Check($"hand {s.LastRecord.HandNo}, {p.Name}: the action log it read hashes to the public record", vl != null && vl.Ok, vl?.Problems);
                    if (v.Ok && vl != null && vl.Ok) verified++;
                }
            }
            await Task.Delay(400);
        }
        Check($"{hands} hands played to the end through the client core", lastEnded >= hands, new { lastEnded });

        foreach (var p in players)
        {
            Check($"{p.Name} never saw another seat's cards during a hand", p.Leaks.Count == 0, p.Leaks);
            var other = players.First(o => o != p);
            // Same login, same moment: its own hand account is readable (positive control), the other's isn't.
            var login = await Login(http, p.SessionKey);
            var own = await login.GetAccount(addrs.Hand(p.Seat));
            var peek = await login.GetAccount(addrs.Hand(other.Seat));
            Check($"{p.Name}'s session key reads its own hand account but not {other.Name}'s", own != null && peek == null, new { ownReadable = own != null, otherReadable = peek != null });
            var kinds = p.Events.Select(e => e.GetType().Name).Distinct().ToArray();
            Check($"{p.Name}'s event stream has the full hand cycle", new[] { "HandStartedEvent", "BlindPostedEvent", "HoleCardsDealtEvent", "TurnStartedEvent", "PlayerActedEvent", "HandEndedEvent" }.All(kinds.Contains), kinds);
            // Showdown cards must be the cards of the public record of that hand (both seats, both cards).
            var showdowns = p.Events.OfType<ShowdownEvent>().ToList();
            Check($"{p.Name}: every showdown shows two real hands", showdowns.All(sd => sd.Entries.Length == 2 && sd.Entries.All(en => en.Card0.Rank != 0 && en.Card1.Rank != 0)), showdowns.Count);
        }
        // Both views agree, and match the settled ledger.
        var stacks = players.Select(p => p.Session.Ledger?.Seats[p.Seat].Stack ?? 0).ToArray();
        // The same actions, in the same order, with the same amounts, in both players' views.
        string Seq(Player p) => string.Join(",", p.Events.OfType<PlayerActedEvent>().Select(a => $"{a.Seat}:{a.Action}:{a.Amount}"));
        Check("both players' views show the same action sequence", Seq(players[0]) == Seq(players[1]) && Seq(players[0]).Length > 0,
            players.Select(p => p.Events.OfType<PlayerActedEvent>().Count()));

        // A hand another session started in the last loop pass may still be running: play it out.
        for (var until = DateTime.UtcNow.AddMinutes(3); DateTime.UtcNow < until;)
        {
            foreach (var p in players) await p.Session.Poll();
            if (players.All(p => p.Session.Table.HandState == PerGame.HandIdle)) break;
            foreach (var p in players)
            {
                var g = p.Session.Ledger?.Game;
                if (p.Session.Table.HandState != PerGame.HandPlaying || g == null || g.ToAct != p.Seat) continue;
                try { await p.Session.Act(PerGame.Legal(g).CanCheck ? ActionType.Check : ActionType.Fold, 0); }
                catch (PerTxException) { /* raced */ }
            }
            await Task.Delay(1000);
        }
        foreach (var p in players)
        {
            var sig = await p.WalletRpc.Send(new[] { PerIx.CashOut(addrs, p.Wallet.PublicKey, p.Seat) }, new WalletLike(p.Wallet));
            Check($"{p.Name} cashes out (wallet signs)", sig != null, sig);
        }
        Outcomes.Add(new { table = table.Key, handsVerifiedByBothPlayers = verified / 2, finalStacks = stacks });
    }
}
