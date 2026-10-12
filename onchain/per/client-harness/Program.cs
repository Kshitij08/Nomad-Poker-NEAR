// M8 harness: the Unity client's private-table core, run headless against devnet.
//   dotnet run -- vector                      verifier port vs the program's fixed vector
//   dotnet run -- play <table> [hands]        two players (p1 seat 0, p2 seat 3) play real hands
//   dotnet run -- vault <table>               M9: the game vault and play key, with the C# builders the game uses
//   dotnet run -- host                        M9b: host an invite-only table, an invited player joins and leaves, host closes and reclaims
//   dotnet run -- sitout                      M10: sit_out takes back a committed seed; the next hand deals without the seat
//   dotnet run -- tourney                     M11: a 7-player on-chain tournament end to end (create, register, tables, VRF draw, two rounds, payout) and a cancelled one
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
            case "host": await Host(); break;
            case "exit": await Exit(); break;
            case "sitout": await SitOutSuite(); break;
            case "agent": await AgentSuite(); break;
            case "tourney": await TourneySuite(args.Length > 1 ? int.Parse(args[1]) : 9); break;
            case "soak": await Soak(int.Parse(args[1]), int.Parse(args[2]), args.Length > 3 ? int.Parse(args[3]) : 3); break;
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
        Check("open_vault (C# builder) lands on Solana", await Try(() => l1.Send(new[] { PerVault.OpenVaultBudget(), PerVault.OpenVault(wallet.PublicKey) }, walletSigner)));
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

    // ---- M9b: hosting with the C# builders (PerHost)
    static async Task<(Account wallet, PerVault.PlayKey key, PerRpc er)> FundedPlayer(Http http, PerRpc l1, Account deployer, ulong lamports, ulong deposit)
    {
        var wallet = new Account();
        var fund = new Solana.Unity.Rpc.Models.TransactionInstruction
        {
            ProgramId = PerVault.SystemProgram.KeyBytes,
            Keys = new List<Solana.Unity.Rpc.Models.AccountMeta> { Solana.Unity.Rpc.Models.AccountMeta.Writable(deployer.PublicKey, true), Solana.Unity.Rpc.Models.AccountMeta.Writable(wallet.PublicKey, false) },
            Data = new byte[] { 2, 0, 0, 0 }.Concat(BitConverter.GetBytes(lamports)).ToArray(),
        };
        await l1.Send(new[] { fund }, new LocalSigner(deployer));
        if (deposit > 0)
        {
            await l1.Send(new[] { PerVault.OpenVaultBudget(), PerVault.OpenVault(wallet.PublicKey) }, new WalletLike(wallet));
            await l1.Send(PerVault.Deposit(wallet.PublicKey, deposit, PerVault.NewShuttleId()), new WalletLike(wallet));
        }
        var key = new Account();
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 86400L;
        var pk = new PerVault.PlayKey { Key = key, Wallet = wallet.PublicKey, Expires = expires, Signature = wallet.Sign(PerVault.PlayKeyMessage(key.PublicKey, expires)) };
        return (wallet, pk, await Login(http, key));
    }

    static async Task Host()
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var host = await FundedPlayer(http, l1, deployer, 80_000_000, 5_000_000);
        var guest = await FundedPlayer(http, l1, deployer, 40_000_000, 5_000_000);
        var stranger = await FundedPlayer(http, l1, deployer, 40_000_000, 5_000_000);
        var linked = await FundedPlayer(http, l1, deployer, 40_000_000, 5_000_000);
        var id = PerHost.NewTableId();
        var tableKey = PerHost.TableAddress(host.wallet.PublicKey, id);
        var t = new PerTableAddresses(tableKey);
        var stake = PerHost.Stakes[0];
        var p = new TableParams { SmallBlind = stake.Small, BigBlind = stake.Big, MinBuyIn = 10 * stake.Big, MaxBuyIn = 100 * stake.Big, MaxSeats = 6, InviteOnly = true };
        Console.WriteLine($"host {host.wallet.PublicKey.Key}, table {tableKey.Key}");

        Check("host creates and hands over an invite-only table (one wallet transaction)", await Try(() => l1.Send(PerHost.CreateAndDelegate(host.wallet.PublicKey, id, p), new WalletLike(host.wallet))));
        await Task.Delay(5000);
        Check("host's play key opens the table (no wallet)", await Try(() => host.er.Send(new[] { PerHost.Open(t, host.key.Key.PublicKey) }, new LocalSigner(host.key.Key))));
        // M9c: the private list (host + guest) and an invite link, by the play key; nothing on Solana.
        var code = PerHost.NewInviteCode();
        var steps = PerHost.SetInvitesKeyedSteps(t, host.key, new[] { host.wallet.PublicKey, guest.wallet.PublicKey }, PerHost.InviteCodeHash(tableKey, code));
        Check("a first call that already carries the list is refused", !await Try(() => host.er.Send(new[] { host.key.Check(), steps[1] }, new LocalSigner(host.key.Key))));
        Check("host's play key creates the private list, then sets it and the link (no wallet)", await Try(() => host.er.Send(new[] { host.key.Check(), steps[0] }, new LocalSigner(host.key.Key))) && await Try(() => host.er.Send(new[] { host.key.Check(), steps[1] }, new LocalSigner(host.key.Key))));
        Check("no invite list on Solana", await l1.GetAccount(PerHost.InvitesAddress(tableKey), "confirmed") == null && await l1.GetAccount(PerHost.PrivateInvitesAddress(tableKey), "confirmed") == null);
        await Task.Delay(3000);

        var invites = PerHost.PrivateInvitesAddress(tableKey);
        var sReader = new Account();
        Check("the stranger can't buy in (not invited)", !await Try(() => stranger.er.Send(new[] { stranger.key.Check(), PerVault.BuyIn(t, stranger.key, 1, 2_000_000, sReader.PublicKey, invites) }, new LocalSigner(stranger.key.Key))));
        Check("the stranger can't buy in with a made-up code", !await Try(() => stranger.er.Send(new[] { stranger.key.Check(), PerVault.BuyIn(t, stranger.key, 1, 2_000_000, sReader.PublicKey, invites, PerHost.NewInviteCode()) }, new LocalSigner(stranger.key.Key))));
        var gReader = new Account();
        Check("the guest buys in from the game balance (private list)", await Try(() => guest.er.Send(new[] { guest.key.Check(), PerVault.BuyIn(t, guest.key, 0, 2_000_000, gReader.PublicKey, invites) }, new LocalSigner(guest.key.Key))));
        var lReader = new Account();
        Check("a player with the invite link's code buys in", await Try(() => linked.er.Send(new[] { linked.key.Check(), PerVault.BuyIn(t, linked.key, 1, 2_000_000, lReader.PublicKey, invites, code) }, new LocalSigner(linked.key.Key))));
        var lRpc = await Login(http, lReader);
        Check("the link player leaves (table key)", await Try(() => lRpc.Send(new[] { PerVault.CashOut(t, lReader.PublicKey, linked.wallet.PublicKey, 1, 0) }, new LocalSigner(lReader))));

        // A pre-M9c L1 list (set here for an unused id: the instruction only derives the table's address) and
        // its rent back with close_invites.
        var oldId = PerHost.NewTableId();
        Check("legacy: an L1 invite list (wallet transaction)", await Try(() => l1.Send(new[] { PerHost.SetInvites(host.wallet.PublicKey, oldId, new[] { guest.wallet.PublicKey }) }, new WalletLike(host.wallet))));
        await Task.Delay(4000); // a confirmed read can lag the send by a node
        var oldInv = Invites.Decode(await l1.GetAccount(PerHost.InvitesAddress(PerHost.TableAddress(host.wallet.PublicKey, oldId)), "confirmed"));
        Check("legacy: it holds the guest and not the stranger", PerHost.IsInvited(oldInv, PerHost.TableAddress(host.wallet.PublicKey, oldId), guest.wallet.PublicKey) && !PerHost.IsInvited(oldInv, PerHost.TableAddress(host.wallet.PublicKey, oldId), stranger.wallet.PublicKey));
        var b0 = await SolBalance(l1, host.wallet.PublicKey);
        Check("legacy: close_invites (C# builder) lands", await Try(() => l1.Send(new[] { PerHost.CloseInvites(host.wallet.PublicKey, oldId) }, new WalletLike(host.wallet))));
        await Task.Delay(4000);
        var back0 = (long)(await SolBalance(l1, host.wallet.PublicKey)) - (long)b0;
        Check("legacy: its rent (less the fee) came back", back0 > 3_000_000, back0);

        var config = Config.Decode(await l1.GetAccount(t.Config, "confirmed"));
        var devWallet = new PublicKey(config.DevWallet);
        Check("host can't close while the guest is seated", !await Try(() => host.er.Send(new[] { host.key.Check(), PerHost.CloseKeyed(t, host.key, devWallet) }, new LocalSigner(host.key.Key))));
        var readerRpc = await Login(http, gReader);
        Check("the guest leaves (table key)", await Try(() => readerRpc.Send(new[] { PerVault.CashOut(t, gReader.PublicKey, guest.wallet.PublicKey, 0, 0) }, new LocalSigner(gReader))));
        Check("host's play key closes the empty table (no wallet)", await Try(() => host.er.Send(new[] { host.key.Check(), PerHost.CloseKeyed(t, host.key, devWallet) }, new LocalSigner(host.key.Key))));

        bool back = false;
        for (int i = 0; i < 18 && !back; i++)
        {
            await Task.Delay(5000);
            var info = await l1.Call("getAccountInfo", tableKey.Key, new JObject { ["encoding"] = "base64", ["commitment"] = "confirmed" });
            back = info?["value"]?.Type == JTokenType.Object && (string)info["value"]["owner"] == PerIds.Program.Key;
        }
        Check("the closed table is back on Solana", back);
        var before = await SolBalance(l1, host.wallet.PublicKey);
        Check("host reclaims the rent (wallet transaction)", await Try(() => l1.Send(new[] { PerHost.Reclaim(host.wallet.PublicKey, id) }, new WalletLike(host.wallet))));
        await Task.Delay(4000);
        var got = (long)(await SolBalance(l1, host.wallet.PublicKey)) - (long)before;
        Check("rent came back", got > 10_000_000, got);
        Outcomes.Add(new { host = host.wallet.PublicKey.Key, table = tableKey.Key, reclaimedLamports = got });
    }

    // ---- M10 soak: hosted tables played in parallel through the client core, then a token reconciliation
    sealed class SoakSeat
    {
        public string Name; public Account Wallet; public PerVault.PlayKey Key; public PerRpc KeyRpc; public Account Reader; public PerRpc ReaderRpc;
        public PerTableSession Session; public int Seat; public ulong VaultBefore, VaultAfter, BoughtIn, Rake;
        public readonly List<PokerEvent> Events = new List<PokerEvent>();
        public readonly List<string> Leaks = new List<string>();
    }

    static readonly object SoakLock = new object();
    static void SoakLog(string s) { lock (SoakLock) Console.WriteLine($"{DateTime.UtcNow:HH:mm:ss} {s}"); }

    static async Task<ulong> VaultBalanceOf(PerVault.PlayKey k, PerRpc rpc)
    {
        var data = await rpc.SimulateReturn(new[] { k.Check(), PerVault.Balance(k) }, new LocalSigner(k.Key));
        return data == null ? 0UL : BitConverter.ToUInt64(data, 0);
    }

    static ulong RakeOf(ulong amount) => (amount * 500 + 9_999) / 10_000; // 5%, rounded up (table.rs rake_for)

    static async Task Soak(int tables, int handsPerTable, int playersPerTable)
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var config = Config.Decode(await l1.GetAccount(PerTableAddresses.Find(PerIds.Program, Encoding.UTF8.GetBytes("config")), "confirmed"));
        var devWallet = new PublicKey(config.DevWallet);
        var started = DateTime.UtcNow;
        var results = await Task.WhenAll(Enumerable.Range(0, tables).Select(i => SoakTable(http, l1, deployer, devWallet, i, handsPerTable, playersPerTable)));
        int hands = results.Sum(r => r.hands), verified = results.Sum(r => r.verified);
        long delta = results.Sum(r => r.delta), rake = results.Sum(r => (long)r.rake);
        Check($"{tables} tables played {hands} hands in all (asked {tables * handsPerTable})", hands >= tables * handsPerTable, results.Select(r => r.hands));
        Check("every finished hand verified by every seat (deck, button, own seed and cards, action log)", verified == results.Sum(r => r.checks), new { verified, checks = results.Sum(r => r.checks) });
        Check("token reconciliation: the players' game balances changed by exactly minus the rake on every buy-in", delta == -rake, new { delta, rake });
        Check("no player saw another seat's cards during a hand", results.All(r => r.leaks == 0), results.Select(r => r.leaks));
        Outcomes.Add(new { tables, handsPerTable, playersPerTable, hands, minutes = Math.Round((DateTime.UtcNow - started).TotalMinutes, 1), perTable = results });
    }

    static async Task<SoakResult> SoakTable(Http http, PerRpc l1, Account deployer, PublicKey devWallet, int n, int hands, int playersPerTable)
    {
        var r = new SoakResult { table = "" };
        try
        {
            // Tables start 40 s apart and every setup step retries: devnet's public RPC answers bursts with 429.
            await Task.Delay(n * 40_000);
            var seats = new List<SoakSeat>();
            for (int i = 0; i < playersPerTable; i++)
            {
                var lamports = i == 0 ? 100_000_000UL : 55_000_000UL;
                var (w, k, rpc) = await Retry(() => FundedPlayer(http, l1, deployer, lamports, 30_000_000), $"table {n} fund p{i}");
                seats.Add(new SoakSeat { Name = $"t{n}p{i}", Wallet = w, Key = k, KeyRpc = rpc, Seat = i, Reader = new Account() });
                await Task.Delay(1500); // devnet's public RPC limits bursts
            }
            var host = seats[0];
            var id = PerHost.NewTableId();
            var tableKey = PerHost.TableAddress(host.Wallet.PublicKey, id);
            r.table = tableKey.Key;
            var t = new PerTableAddresses(tableKey);
            var stake = PerHost.Stakes[0];
            var p = new TableParams { SmallBlind = stake.Small, BigBlind = stake.Big, MinBuyIn = 10 * stake.Big, MaxBuyIn = 100 * stake.Big, MaxSeats = (byte)playersPerTable, InviteOnly = false };
            await Retry(() => l1.Send(PerHost.CreateAndDelegate(host.Wallet.PublicKey, id, p), new WalletLike(host.Wallet)), $"table {n} create");
            await Task.Delay(12_000); // deposits settle, the rollup picks up the table
            for (int i = 0; ; i++)
            {
                try { await host.KeyRpc.Send(new[] { PerHost.Open(t, host.Key.Key.PublicKey) }, new LocalSigner(host.Key.Key)); break; }
                catch (Exception) when (i < 8) { await Task.Delay(3000); }
            }
            var publicRpc = new PerRpc(http, Tee);
            foreach (var s in seats)
            {
                s.VaultBefore = await VaultBalanceOf(s.Key, s.KeyRpc);
                await SoakBuyIn(s, t, 10_000_000, r);
                s.ReaderRpc = await Login(http, s.Reader);
                s.Session = new PerTableSession(tableKey, publicRpc, s.ReaderRpc, new LocalSigner(s.Reader), s.Wallet.PublicKey);
                var me = s;
                s.Session.Events += e => { me.Events.Add(e); if (e is HoleCardsDealtEvent h && h.Seat != me.Seat && h.Card0.Rank != 0) me.Leaks.Add($"saw seat {h.Seat}'s cards live"); };
            }
            SoakLog($"table {n} {tableKey.Key}: {seats.Count} seated, playing {hands} hands");
            var rng = new Random(n * 7919 + 17);
            int lastEnded = 0;
            var begin = DateTime.UtcNow;
            while (DateTime.UtcNow - begin < TimeSpan.FromMinutes(hands * 1.5 + 10))
            {
                bool wantMore = lastEnded < hands;
                if (!wantMore && seats.All(s => s.Session.Table?.HandState == PerGame.HandIdle)) break;
                foreach (var s in seats)
                {
                    try
                    {
                        await s.Session.Poll();
                        await s.Session.KeepMoving();
                        var tb = s.Session.Table;
                        var mySeat = s.Session.Ledger?.Seats[s.Seat];
                        // Busted (or nearly): rebuy from the game balance between hands.
                        if (tb.HandState == PerGame.HandIdle && wantMore && mySeat != null && mySeat.Stack < stake.Big * 2)
                            await SoakBuyIn(s, t, 6_000_000, r);
                        // M10: the host (seat 0, the creator) presses Start round; every seat commits once it's pressed.
                        if (tb.HandState == PerGame.HandIdle && wantMore && !s.Session.StartRequested && s.Session.MayStartRound && s.Session.SeatedWithChips >= 2) await s.Session.RequestStart();
                        if (tb.HandState == PerGame.HandIdle && wantMore) await s.Session.PrepareNextHand();
                        var game = s.Session.Ledger?.Game;
                        var turn = s.Events.OfType<TurnStartedEvent>().LastOrDefault();
                        // Disconnect drill: on every 25th hand seat 1 goes silent; the hand must still finish (the keeper,
                        // or another player's client, times it out).
                        bool silent = s.Seat == 1 && tb.HandNo % 25 == 0;
                        if (silent && tb.HandState == PerGame.HandPlaying && game != null && game.ToAct == s.Seat) r.silentTurns++;
                        if (!silent && tb.HandState == PerGame.HandPlaying && game != null && game.ToAct == s.Seat && turn != null && turn.ForYou && turn.Seat == s.Seat)
                        {
                            var legal = PerGame.Legal(game);
                            int roll = rng.Next(100);
                            if (legal.CanCheck) { if ((legal.CanBet || legal.CanRaise) && roll < 25) await s.Session.Act(legal.CanBet ? ActionType.Bet : ActionType.Raise, legal.MinRaiseTo); else await s.Session.Act(ActionType.Check, 0); }
                            else if (roll < 12) await s.Session.Act(ActionType.Fold, 0);
                            else if (legal.CanRaise && roll < 22) await s.Session.Act(ActionType.Raise, legal.MinRaiseTo);
                            else if (legal.CanCall) await s.Session.Act(ActionType.Call, 0);
                            else if (legal.CanAllIn) await s.Session.Act(ActionType.AllIn, 0);
                            else await s.Session.Act(ActionType.Fold, 0);
                        }
                    }
                    catch (PerTxException e) when (e.ErrorName == "NotYourTurn" || e.ErrorName == "HandNotPlaying" || e.ErrorName == "HandInProgress") { }
                    catch (Exception e) { r.errors++; if (r.errors < 20) SoakLog($"table {n} {s.Name}: {e.Message}"); await Task.Delay(1000); }
                }
                var ended = seats.Min(s => s.Events.OfType<HandEndedEvent>().Count());
                if (ended > lastEnded)
                {
                    lastEnded = ended;
                    foreach (var s in seats)
                    {
                        var ss = s.Session;
                        if (ss.LastRecord == null) continue;
                        r.checks++;
                        var v = PerVerifier.Verify(ss.LastRecord, ss.LastPrevButton, s.Seat, ss.LastMySeed, ss.LastMyCards);
                        var vl = ss.LastLog != null ? PerVerifier.VerifyLog(ss.LastRecord, ss.LastLog) : null;
                        if (v.Ok && vl != null && vl.Ok) r.verified++;
                        else if (r.problems.Count < 10) r.problems.Add(new { hand = ss.LastRecord.HandNo, seat = s.Seat, v.Problems, log = vl?.Problems });
                    }
                    if (lastEnded % 10 == 0) SoakLog($"table {n}: {lastEnded}/{hands} hands");
                }
                await Task.Delay(300);
            }
            r.hands = lastEnded;
            r.leaks = seats.Sum(s => s.Leaks.Count);
            // A hand someone's seed already started may still be running: play it out (check, else fold) before
            // anyone leaves; a seat can't leave mid-hand.
            var drain = DateTime.UtcNow;
            while (DateTime.UtcNow - drain < TimeSpan.FromMinutes(4))
            {
                foreach (var s in seats)
                {
                    try
                    {
                        await s.Session.Poll();
                        await s.Session.KeepMoving();
                        var g = s.Session.Ledger?.Game;
                        if (s.Session.Table.HandState == PerGame.HandPlaying && g != null && g.ToAct == s.Seat)
                            await s.Session.Act(PerGame.Legal(g).CanCheck ? ActionType.Check : ActionType.Fold, 0);
                    }
                    catch (Exception) { }
                }
                if (seats.All(s => s.Session.Table?.HandState == PerGame.HandIdle)) break;
                await Task.Delay(1000);
            }
            // Everyone leaves (table key), the host closes (rake collected first) and reclaims.
            foreach (var s in seats)
            {
                for (int i = 0; ; i++)
                {
                    try { await s.ReaderRpc.Send(new[] { PerVault.CashOut(t, s.Reader.PublicKey, s.Wallet.PublicKey, s.Seat, 0) }, new LocalSigner(s.Reader)); break; }
                    catch (Exception) when (i < 40) { await Task.Delay(3000); }
                }
            }
            await host.KeyRpc.Send(new[] { host.Key.Check(), PerHost.CloseKeyed(t, host.Key, devWallet) }, new LocalSigner(host.Key.Key));
            await Task.Delay(8000);
            foreach (var s in seats) { s.VaultAfter = await VaultBalanceOf(s.Key, s.KeyRpc); r.delta += (long)s.VaultAfter - (long)s.VaultBefore; }
            r.rake = (ulong)seats.Sum(s => (long)s.Rake);
            r.boughtIn = (ulong)seats.Sum(s => (long)s.BoughtIn);
            for (int i = 0; i < 24; i++)
            {
                await Task.Delay(5000);
                var info = await l1.Call("getAccountInfo", tableKey.Key, new JObject { ["encoding"] = "base64", ["commitment"] = "confirmed" });
                if (info?["value"]?.Type == JTokenType.Object && (string)info["value"]["owner"] == PerIds.Program.Key)
                {
                    await l1.Send(new[] { PerHost.Reclaim(host.Wallet.PublicKey, id) }, new WalletLike(host.Wallet));
                    r.reclaimed = true;
                    break;
                }
            }
            r.minutes = Math.Round((DateTime.UtcNow - begin).TotalMinutes, 1);
            SoakLog($"table {n}: done, {r.hands} hands, {r.verified}/{r.checks} verified, balances {r.delta}, rake {r.rake}, errors {r.errors}");
        }
        catch (Exception e) { r.fatal = e.Message; SoakLog($"table {n} FAILED: {e}"); }
        return r;
    }

    /// <summary>Retries a setup step through devnet's rate limits (a step that failed with 429 never landed). Not for
    /// steps that may have landed and can't run twice.</summary>
    static async Task<T> Retry<T>(Func<Task<T>> f, string what)
    {
        for (int i = 0; ; i++)
        {
            try { return await f(); }
            catch (Exception e) when (i < 6 && (e.Message.Contains("429") || e.Message.Contains("Too Many"))) { SoakLog($"{what}: rate-limited, retrying"); await Task.Delay(15_000 * (i + 1)); }
        }
    }

    static async Task SoakBuyIn(SoakSeat s, PerTableAddresses t, ulong amount, SoakResult r)
    {
        await s.KeyRpc.Send(new[] { s.Key.Check(), PerVault.BuyIn(t, s.Key, s.Seat, amount, s.Reader.PublicKey) }, new LocalSigner(s.Key.Key));
        s.BoughtIn += amount;
        s.Rake += RakeOf(amount);
        r.buyIns++;
    }

    sealed class SoakResult
    {
        public string table; public int hands, checks, verified, leaks, errors, buyIns, silentTurns; public long delta; public ulong rake, boughtIn;
        public bool reclaimed; public double minutes; public string fatal; public List<object> problems = new List<object>();
    }

    // ---- M10: Sit out (the playtest found a seat dealt in after Sit out: its seed for the next hand was already in)
    static async Task SitOutSuite()
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var config = Config.Decode(await l1.GetAccount(PerTableAddresses.Find(PerIds.Program, Encoding.UTF8.GetBytes("config")), "confirmed"));
        var devWallet = new PublicKey(config.DevWallet);
        var seats = new List<SoakSeat>();
        for (int i = 0; i < 3; i++)
        {
            var (w, k, rpc) = await Retry(() => FundedPlayer(http, l1, deployer, i == 0 ? 100_000_000UL : 55_000_000UL, 30_000_000), $"fund p{i}");
            seats.Add(new SoakSeat { Name = $"p{i}", Wallet = w, Key = k, KeyRpc = rpc, Seat = i, Reader = new Account() });
            await Task.Delay(1500);
        }
        var host = seats[0];
        var id = PerHost.NewTableId();
        var tableKey = PerHost.TableAddress(host.Wallet.PublicKey, id);
        var t = new PerTableAddresses(tableKey);
        var stake = PerHost.Stakes[0];
        var p = new TableParams { SmallBlind = stake.Small, BigBlind = stake.Big, MinBuyIn = 10 * stake.Big, MaxBuyIn = 100 * stake.Big, MaxSeats = 3, InviteOnly = false };
        await Retry(() => l1.Send(PerHost.CreateAndDelegate(host.Wallet.PublicKey, id, p), new WalletLike(host.Wallet)), "create");
        await Task.Delay(12_000);
        for (int i = 0; ; i++)
        {
            try { await host.KeyRpc.Send(new[] { PerHost.Open(t, host.Key.Key.PublicKey) }, new LocalSigner(host.Key.Key)); break; }
            catch (Exception) when (i < 8) { await Task.Delay(3000); }
        }
        var publicRpc = new PerRpc(http, Tee);
        var dummy = new SoakResult();
        foreach (var s in seats)
        {
            await SoakBuyIn(s, t, 10_000_000, dummy);
            s.ReaderRpc = await Login(http, s.Reader);
            s.Session = new PerTableSession(tableKey, publicRpc, s.ReaderRpc, new LocalSigner(s.Reader), s.Wallet.PublicKey);
            var me = s;
            s.Session.Events += e => me.Events.Add(e);
        }
        Console.WriteLine($"table {tableKey.Key}: 3 seated");
        async Task PollAll() { foreach (var s in seats) { await s.Session.Poll(); await s.Session.KeepMoving(); } }
        // Plays the running hand out (check, else fold) until the table is idle again.
        async Task PlayOut()
        {
            var start = DateTime.UtcNow;
            while (DateTime.UtcNow - start < TimeSpan.FromMinutes(3))
            {
                await PollAll();
                if (seats.All(s => s.Session.Table.HandState == PerGame.HandIdle)) return;
                foreach (var s in seats)
                {
                    var g = s.Session.Ledger?.Game;
                    if (s.Session.Table.HandState == PerGame.HandPlaying && g != null && g.ToAct == s.Seat)
                        try { await s.Session.Act(PerGame.Legal(g).CanCheck ? ActionType.Check : ActionType.Fold, 0); } catch (PerTxException) { }
                }
                await Task.Delay(800);
            }
            throw new Exception("hand didn't finish in 3 min");
        }
        // M10: the host's Start round alone (its seat key signs; no seed committed with it).
        async Task HostAsks() { await host.ReaderRpc.Send(new[] { PerIx.RequestStart(t, host.Reader.PublicKey) }, new LocalSigner(host.Reader)); await PollAll(); }
        // Commits for `who` (each also tries start_hand), then waits until a hand is under way. Returns how long it took.
        async Task<double> DealWith(IEnumerable<SoakSeat> who, ulong afterHand)
        {
            var start = DateTime.UtcNow;
            while (DateTime.UtcNow - start < TimeSpan.FromSeconds(90))
            {
                await PollAll();
                if (seats[0].Session.Table.HandNo > afterHand) return (DateTime.UtcNow - start).TotalSeconds;
                if (!seats[0].Session.StartRequested) await HostAsks();
                foreach (var s in who) await s.Session.PrepareNextHand();
                await Task.Delay(1000);
            }
            throw new Exception("no hand started in 90 s");
        }

        await PollAll();
        bool notHost;
        try { await seats[1].ReaderRpc.Send(new[] { PerIx.RequestStart(t, seats[1].Reader.PublicKey) }, new LocalSigner(seats[1].Reader)); notHost = false; }
        catch (PerTxException e) { notHost = e.ErrorName == "NotHost"; Console.WriteLine("   " + e.Message); }
        Check("M10: with the host seated, another player can't press Start round (NotHost)", notHost);
        await seats[1].Session.PrepareNextHand();
        Check("M10: before Start round, a player's game commits no seed", seats[1].Session.MySeed == null);
        await DealWith(seats, 0);
        var t1 = seats[0].Session.Table;
        Check("hand 1 deals all three seats", t1.DealtMask == 0b111, t1.DealtMask);
        await PlayOut();

        // The bug: p2's seed for the next hand is already in when it sits out.
        var p2 = seats[2];
        await HostAsks();
        await p2.Session.PrepareNextHand();
        // The deck can't be read by anyone (seeds are secret), so what proves the withdrawal is hand 2 below: a
        // committed seed deals its seat in even when the seat is marked sitting out.
        Check("p2 committed its seed for hand 2", p2.Session.MySeed != null);
        // An outsider (p1's key) can't sit p2 out.
        bool outsiderRefused;
        try { await seats[1].ReaderRpc.Send(new[] { PerIx.SitOut(t, seats[1].Reader.PublicKey, 2) }, new LocalSigner(seats[1].Reader)); outsiderRefused = false; }
        catch (PerTxException e) { outsiderRefused = e.ErrorName == "NotSeated"; Console.WriteLine("   " + e.Message); }
        Check("another seat's key can't sit p2 out (NotSeated)", outsiderRefused);
        Check("p2 sits out (sit_out, its table key)", await Try(() => p2.Session.SitOut()));
        await PollAll();
        Check("p2's seat is marked sitting out", seats[0].Session.Ledger.Seats[2].SittingOut);
        Check("p2's chips stay on the seat", seats[0].Session.Ledger.Seats[2].Stack > 0, seats[0].Session.Ledger.Seats[2].Stack);
        Check("sit_out again is harmless", await Try(() => p2.Session.SitOut()));

        var secs = await DealWith(seats.Take(2), 1);
        var t2 = seats[0].Session.Table;
        Check("hand 2 deals p0 and p1 only (p2's committed seed was withdrawn)", t2.DealtMask == 0b011, t2.DealtMask);
        Check("hand 2 didn't wait the 20 s seed window for p2", secs < 15, Math.Round(secs, 1));
        bool midHandRefused;
        try { await p2.ReaderRpc.Send(new[] { PerIx.SitOut(t, p2.Reader.PublicKey, 2) }, new LocalSigner(p2.Reader)); midHandRefused = false; }
        catch (PerTxException e) { midHandRefused = e.ErrorName == "HandInProgress"; Console.WriteLine("   " + e.Message); }
        Check("sit_out during a hand is refused (HandInProgress)", midHandRefused);
        // Sitting back in mid-hand (sit_in), so hand 3 waits for p2's seed. Without it the playtest-style race wins:
        // p0 and p1 commit first and, p2 not being waited for, hand 3 starts without it (the first run of this suite).
        Check("p2 sits back in during hand 2 (sit_in)", await Try(() => p2.Session.SitIn()));
        await PollAll();
        Check("p2's seat is no longer marked sitting out", !seats[0].Session.Ledger.Seats[2].SittingOut);
        await PlayOut();
        bool outsiderSitIn;
        try { await seats[1].ReaderRpc.Send(new[] { PerIx.SitIn(t, seats[1].Reader.PublicKey, 2) }, new LocalSigner(seats[1].Reader)); outsiderSitIn = false; }
        catch (PerTxException e) { outsiderSitIn = e.ErrorName == "NotSeated"; }
        Check("another seat's key can't sit p2 in (NotSeated)", outsiderSitIn);

        // p0 and p1 commit before p2 (the order that lost the race).
        await DealWith(seats, 2);
        var t3 = seats[0].Session.Table;
        Check("hand 3 deals p2 again after it commits a seed", t3.DealtMask == 0b111, t3.DealtMask);
        await PollAll();
        Check("p2's seat is still in after hand 3 starts", !seats[0].Session.Ledger.Seats[2].SittingOut);
        await PlayOut();

        // Heads-up (the playtest's case): p1 sits out with its seed in; p0 alone can't start a hand.
        await HostAsks();
        await seats[1].Session.PrepareNextHand();
        Check("p2 sits out again", await Try(() => p2.Session.SitOut()));
        Check("p1 sits out with its seed in", await Try(() => seats[1].Session.SitOut()));
        bool alone = false;
        try { await host.ReaderRpc.Send(new[] { PerIx.CommitSeed(t, host.Reader.PublicKey, 0, new byte[32].Select((_, i) => (byte)(i + 1)).ToArray()) }, new LocalSigner(host.Reader)); } catch (PerTxException) { }
        try { await host.ReaderRpc.Send(new[] { PerIx.StartHand(t, host.Reader.PublicKey) }, new LocalSigner(host.Reader)); }
        catch (PerTxException e) { alone = e.ErrorName == "NotEnoughPlayers"; Console.WriteLine("   " + e.Message); }
        Check("with the others sitting out, no hand starts (NotEnoughPlayers)", alone);

        // Everyone leaves, the host closes and reclaims.
        foreach (var s in seats)
            for (int i = 0; ; i++)
            {
                try { await s.ReaderRpc.Send(new[] { PerVault.CashOut(t, s.Reader.PublicKey, s.Wallet.PublicKey, s.Seat, 0) }, new LocalSigner(s.Reader)); break; }
                catch (Exception) when (i < 20) { await Task.Delay(3000); }
            }
        await host.KeyRpc.Send(new[] { host.Key.Check(), PerHost.CloseKeyed(t, host.Key, devWallet) }, new LocalSigner(host.Key.Key));
        bool reclaimed = false;
        for (int i = 0; i < 24 && !reclaimed; i++)
        {
            await Task.Delay(5000);
            var info = await l1.Call("getAccountInfo", tableKey.Key, new JObject { ["encoding"] = "base64", ["commitment"] = "confirmed" });
            if (info?["value"]?.Type == JTokenType.Object && (string)info["value"]["owner"] == PerIds.Program.Key)
                reclaimed = await Try(() => l1.Send(new[] { PerHost.Reclaim(host.Wallet.PublicKey, id) }, new WalletLike(host.Wallet)));
        }
        Check("everyone cashed out, the host closed and reclaimed", reclaimed);
        Outcomes.Add(new { table = tableKey.Key });
    }

    // ---- M12a: the Agent key. The player's play key sets it on the wallet's private Agent record; it may only
    // buy in (as the wallet, within the stake, one seat at a time), play that seat with its table key, and cash out
    // into the game balance.
    static async Task AgentSuite()
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var config = Config.Decode(await l1.GetAccount(PerTableAddresses.Find(PerIds.Program, Encoding.UTF8.GetBytes("config")), "confirmed"));
        var publicRpc = new PerRpc(http, Tee);

        // ---- the sponsor (once per program)
        if (await l1.GetAccount(PerAgent.Sponsor, "confirmed") == null)
        {
            Check("the admin creates the Agent sponsor (0.05 SOL for records' rent) and hands it to the rollup",
                new PublicKey(config.Admin).Equals(deployer.PublicKey) && await Try(() => l1.Send(PerAgent.CreateSponsor(deployer.PublicKey, 50_000_000), new WalletLike(deployer))));
            await Task.Delay(12_000);
        }
        else Console.WriteLine("   the Agent sponsor exists");

        // ---- a table: host, opponent; `owner` is the player whose Agent plays
        var seats = new List<SoakSeat>();
        for (int i = 0; i < 3; i++)
        {
            var (fw, fk, frpc) = await Retry(() => FundedPlayer(http, l1, deployer, i == 0 ? 100_000_000UL : 60_000_000UL, 40_000_000), $"fund a{i}");
            seats.Add(new SoakSeat { Name = $"a{i}", Wallet = fw, Key = fk, KeyRpc = frpc, Seat = i, Reader = new Account() });
            await Task.Delay(1500);
        }
        var (host, opp, owner) = (seats[0], seats[1], seats[2]);
        var tid = PerHost.NewTableId();
        var t = new PerTableAddresses(PerHost.TableAddress(host.Wallet.PublicKey, tid));
        var st = PerHost.Stakes[0];
        var prm = new TableParams { SmallBlind = st.Small, BigBlind = st.Big, MinBuyIn = 10 * st.Big, MaxBuyIn = 100 * st.Big, MaxSeats = 8, InviteOnly = false };
        await Retry(() => l1.Send(PerHost.CreateAndDelegate(host.Wallet.PublicKey, tid, prm), new WalletLike(host.Wallet)), "create");
        await Task.Delay(12_000);
        for (int i = 0; ; i++)
        {
            try { await host.KeyRpc.Send(new[] { PerHost.Open(t, host.Key.Key.PublicKey) }, new LocalSigner(host.Key.Key)); break; }
            catch (Exception) when (i < 8) { await Task.Delay(3000); }
        }
        Console.WriteLine($"   table {t.Table.Key}");
        var dummy = new SoakResult();
        foreach (var x in new[] { host, opp })
        {
            await SoakBuyIn(x, t, 10_000_000, dummy);
            x.ReaderRpc = await Login(http, x.Reader);
            x.Session = new PerTableSession(t.Table, publicRpc, x.ReaderRpc, new LocalSigner(x.Reader), x.Wallet.PublicKey);
        }

        var agentKey = new Account();
        var agentRpc = await Login(http, agentKey);
        var w = owner.Wallet.PublicKey;
        const ulong Stake = 16_000_000;
        long Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        async Task<PerAgent.State> ReadAs(PerRpc rpc) { try { return PerAgent.State.Decode(await rpc.GetAccount(PerAgent.StateAddress(w))); } catch { return null; } }
        Task<string> AgentBuy(int seat, ulong amount, PublicKey reader) =>
            agentRpc.Send(new[] { PerAgent.BuyIn(t, agentKey.PublicKey, w, seat, amount, reader) }, new LocalSigner(agentKey));

        Check("before any Agent is set, an Agent key can't buy in (NotAgent)", await Refused(() => AgentBuy(2, 10_000_000, new Account().PublicKey), "NotAgent"));
        Check("the player's play key sets an Agent: this key, 1 hour, 0.016 SOL stake (no wallet prompt)",
            await Try(() => owner.KeyRpc.Send(PerAgent.Set(owner.Key, agentKey.PublicKey, Now() + 3600, Stake), new LocalSigner(owner.Key.Key))));
        var st0 = await ReadAs(agentRpc);
        Check("the Agent key reads its record: the wallet, the stake, nothing committed", st0 != null && st0.Wallet.Equals(w) && st0.Stake == Stake && st0.Committed == 0 && !st0.HasSeat, new { st0?.Stake, st0?.Committed });
        var stranger = new Account();
        var strangerRpc = await Login(http, stranger);
        Check("the record is private: another logged-in key can't read it", await ReadAs(strangerRpc) == null);
        Check("a key that isn't the Agent can't buy in for the player (NotAgent)", await Refused(() => opp.ReaderRpc.Send(new[] { PerAgent.BuyIn(t, opp.Reader.PublicKey, w, 2, 10_000_000, new Account().PublicKey) }, new LocalSigner(opp.Reader)), "NotAgent"));
        Check("buying in for more than the stake is refused (AgentStakeExceeded)", await Refused(() => AgentBuy(2, 20_000_000, new Account().PublicKey), "AgentStakeExceeded"));

        var before = await VaultBalanceOf(owner.Key, owner.KeyRpc);
        var r1 = new Account();
        Check("the Agent buys in 0.01 SOL from the player's game balance", await Try(() => AgentBuy(2, 10_000_000, r1.PublicKey)));
        var mid = await VaultBalanceOf(owner.Key, owner.KeyRpc);
        Check("...exactly 0.01 SOL left the game balance", before - mid == 10_000_000, new { before, mid });
        var agentSeat = new SoakSeat { Name = "agent", Wallet = owner.Wallet, Key = owner.Key, KeyRpc = owner.KeyRpc, Seat = 2, Reader = r1, ReaderRpc = await Login(http, r1) };
        agentSeat.Session = new PerTableSession(t.Table, publicRpc, agentSeat.ReaderRpc, new LocalSigner(r1), w);
        await agentSeat.Session.Poll();
        Check("its seat is the player's own seat (the wallet, not labelled), found by its table key", agentSeat.Session.MySeat == 2 && agentSeat.Session.Ledger.Seats[2].Player.SequenceEqual(w.KeyBytes), agentSeat.Session.MySeat);
        var st1 = await ReadAs(agentRpc);
        Check("the record holds that seat and 0.01 SOL committed", st1 != null && st1.HasSeat && st1.Table.Equals(t.Table) && st1.Seat == 2 && st1.Committed == 10_000_000, new { st1?.Seat, st1?.Committed });
        Check("a second seat while it holds one is refused (AgentBusy)", await Refused(() => AgentBuy(3, 10_000_000, new Account().PublicKey), "AgentBusy"));
        Check("the player can't take a second seat at that table themselves (one seat per wallet)", await Refused(() => owner.KeyRpc.Send(new[] { owner.Key.Check(), PerVault.BuyIn(t, owner.Key, 5, 10_000_000, new Account().PublicKey) }, new LocalSigner(owner.Key.Key)), "InvalidSeat"));
        Check("a rebuy past the stake is refused (0.01 + 0.007 > 0.016)", await Refused(() => AgentBuy(2, 7_000_000, r1.PublicKey), "AgentStakeExceeded"));
        Check("a rebuy within it is fine (0.01 + 0.006)", await Try(() => AgentBuy(2, 6_000_000, r1.PublicKey)));

        // ---- one hand: the Agent's seat plays with its table key like any player's
        var players = new List<SoakSeat> { host, opp, agentSeat };
        async Task PollAll() { foreach (var x in players) { await x.Session.Poll(); await x.Session.KeepMoving(); } }
        await PollAll();
        await host.ReaderRpc.Send(new[] { PerIx.RequestStart(t, host.Reader.PublicKey) }, new LocalSigner(host.Reader));
        var handStart = DateTime.UtcNow;
        bool agentActed = false;
        ulong startHand = host.Session.Table?.HandNo ?? 0;
        while (DateTime.UtcNow - handStart < TimeSpan.FromMinutes(3))
        {
            await PollAll();
            var tb = host.Session.Table;
            if (tb.HandNo > startHand && tb.HandState == PerGame.HandIdle) break;
            foreach (var x in players)
            {
                if (x.Session.Table.HandState == PerGame.HandIdle) { if (tb.HandNo == startHand) await x.Session.PrepareNextHand(); continue; }
                var g = x.Session.Ledger?.Game;
                if (x.Session.Table.HandState == PerGame.HandPlaying && g != null && g.ToAct == x.Seat)
                    try { var lg = PerGame.Legal(g); await x.Session.Act(lg.CanCheck ? ActionType.Check : lg.CanCall ? ActionType.Call : ActionType.Fold, 0); if (x == agentSeat) agentActed = true; } catch (PerTxException) { }
            }
            await Task.Delay(800);
        }
        Check("a hand was played with the Agent's seat in it, and it acted with its table key", host.Session.Table.HandNo > startHand && host.Session.Table.HandState == PerGame.HandIdle && agentActed,
            new { startHand, hand = host.Session.Table.HandNo, state = host.Session.Table.HandState, agentActed, dealt = host.Session.Table.DealtMask });
        await agentSeat.Session.Poll();
        ulong stack = agentSeat.Session.Ledger.Seats[2].Stack;

        // ---- leaving
        var preOut = await VaultBalanceOf(owner.Key, owner.KeyRpc);
        Check("another seat's key can't cash out the Agent's seat (NotAgent)", await Refused(() => opp.ReaderRpc.Send(new[] { PerAgent.CashOut(t, opp.Reader.PublicKey, w, 2) }, new LocalSigner(opp.Reader)), "NotAgent"));
        Check("the Agent cashes out its seat", await Try(() => agentRpc.Send(new[] { PerAgent.CashOut(t, agentKey.PublicKey, w, 2) }, new LocalSigner(agentKey))));
        var postOut = await VaultBalanceOf(owner.Key, owner.KeyRpc);
        Check("...its whole stack went to the player's game balance", postOut - preOut == stack, new { stack, got = postOut - preOut });
        var st2 = await ReadAs(agentRpc);
        Check("...and came off what it had committed; the seat is free", st2 != null && !st2.HasSeat && st2.Committed == (16_000_000 > stack ? 16_000_000 - stack : 0), new { st2?.Committed, stack });

        // ---- the player's own seat is never the Agent's
        var mine = new Account();
        Check("the player sits down themselves (play key)", await Try(() => owner.KeyRpc.Send(new[] { owner.Key.Check(), PerVault.BuyIn(t, owner.Key, 5, 10_000_000, mine.PublicKey) }, new LocalSigner(owner.Key.Key))));
        Check("the Agent can't rebuy into the player's own seat (AgentBusy)", await Refused(() => AgentBuy(5, 1_000_000, mine.PublicKey), "AgentBusy"));
        Check("the Agent can't cash out the player's own seat (NotAgentSeat)", await Refused(() => agentRpc.Send(new[] { PerAgent.CashOut(t, agentKey.PublicKey, w, 5) }, new LocalSigner(agentKey)), "NotAgentSeat"));
        Check("the player leaves", await Try(() => owner.KeyRpc.Send(new[] { owner.Key.Check(), PerVault.CashOut(t, owner.Key.Key.PublicKey, w, 5, owner.Key.Expires) }, new LocalSigner(owner.Key.Key))));

        // ---- the player takes the Agent's seat back with their play key; anyone frees the record
        Check("the player sets the Agent again (the count starts anew)", await Try(() => owner.KeyRpc.Send(PerAgent.Set(owner.Key, agentKey.PublicKey, Now() + 3600, Stake), new LocalSigner(owner.Key.Key))));
        var r2 = new Account();
        Check("the Agent sits down again", await Try(() => AgentBuy(3, 10_000_000, r2.PublicKey)));
        Check("releasing a seat that's still there is refused (AgentBusy)", await Refused(() => strangerRpc.Send(new[] { PerAgent.Release(t, w) }, new LocalSigner(stranger)), "AgentBusy"));
        Check("the player cashes the Agent's seat out with their play key", await Try(() => owner.KeyRpc.Send(new[] { owner.Key.Check(), PerVault.CashOut(t, owner.Key.Key.PublicKey, w, 3, owner.Key.Expires) }, new LocalSigner(owner.Key.Key))));
        Check("the record still holds the old seat: a new seat is refused (AgentBusy)", await Refused(() => AgentBuy(4, 1_000_000, new Account().PublicKey), "AgentBusy"));
        Check("anyone frees it once the seat is gone (agent_release)", await Try(() => strangerRpc.Send(new[] { PerAgent.Release(t, w) }, new LocalSigner(stranger))));
        var st3 = await ReadAs(agentRpc);
        Check("...without lowering what it had committed (0.01 SOL still counts)", st3 != null && !st3.HasSeat && st3.Committed == 10_000_000, st3?.Committed);

        // ---- stopping, replacing, expiry, cancelled play keys
        Check("the player stops the Agent", await Try(() => owner.KeyRpc.Send(PerAgent.Stop(owner.Key), new LocalSigner(owner.Key.Key))));
        Check("a stopped Agent can't buy in (NotAgent)", await Refused(() => AgentBuy(4, 1_000_000, new Account().PublicKey), "NotAgent"));
        Check("...nor read the record any more", await ReadAs(agentRpc) == null);
        var agent2 = new Account();
        var agent2Rpc = await Login(http, agent2);
        Check("a new Agent key for 20 s replaces the old one (one Agent per wallet)", await Try(() => owner.KeyRpc.Send(PerAgent.Set(owner.Key, agent2.PublicKey, Now() + 20, Stake), new LocalSigner(owner.Key.Key))));
        Check("the old key can't buy in (NotAgent)", await Refused(() => AgentBuy(4, 1_000_000, new Account().PublicKey), "NotAgent"));
        await Task.Delay(25_000);
        Check("after its time is up the Agent can't buy in (AgentExpired)", await Refused(() => agent2Rpc.Send(new[] { PerAgent.BuyIn(t, agent2.PublicKey, w, 4, 1_000_000, new Account().PublicKey) }, new LocalSigner(agent2)), "AgentExpired"));
        Check("an Agent for longer than 7 days is refused", await Refused(() => owner.KeyRpc.Send(PerAgent.Set(owner.Key, agent2.PublicKey, Now() + PerAgent.MaxSeconds + 600, Stake), new LocalSigner(owner.Key.Key)), "AgentExpired"));
        Check("the player sets it for an hour", await Try(() => owner.KeyRpc.Send(PerAgent.Set(owner.Key, agent2.PublicKey, Now() + 3600, Stake), new LocalSigner(owner.Key.Key))));
        Check("the player cancels their play keys (wallet, on Solana)", await Try(() => l1.Send(new List<Solana.Unity.Rpc.Models.TransactionInstruction> { PerVault.RevokePlayKeys(w) }, new WalletLike(owner.Wallet))));
        bool stopped = false;
        for (int i = 0; i < 20 && !stopped; i++)
        {
            await Task.Delay(3000);
            try { await agent2Rpc.Send(new[] { PerAgent.BuyIn(t, agent2.PublicKey, w, 4, 1_000_000, new Account().PublicKey) }, new LocalSigner(agent2)); Console.WriteLine("   accepted (bought in before the rollup saw the cancel)"); break; }
            catch (PerTxException e) { stopped = e.ErrorName == "AgentExpired"; if (!stopped) Console.WriteLine("   " + e.Message); }
        }
        Check("cancelling the play keys stops the Agent too (AgentExpired)", stopped);
        Outcomes.Add(new { table = t.Table.Key, agent = agentKey.PublicKey.Key });
    }

    // ---- M11: an on-chain tournament, end to end, with the game's builders (PerTourney) and session code
    sealed class TPlayer
    {
        public string Name; public Account Wallet; public PerVault.PlayKey Key; public PerRpc KeyRpc;
        public Account Reader; public PerRpc ReaderRpc; public PerTableSession Session; public int SessionTable = -1;
        public bool Absent;
    }

    static readonly PublicKey KeeperKey = new PublicKey("BNb3zGjZ59bcukW3qVnVo8VoEsDjqij2RpshsvCEahZx");

    static async Task<Poker.Per.Generated.Tournament> ReadTourney(PerRpc rpc, PublicKey t) => PerTourney.Decode(await rpc.GetAccount(t));

    static async Task TourneySuite(int n = 9)
    {
        if (n < 2 || n > 30) throw new ArgumentOutOfRangeException(nameof(n), "a tournament has 2 to 30 players");
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var config = Config.Decode(await l1.GetAccount(PerTableAddresses.Find(PerIds.Program, Encoding.UTF8.GetBytes("config")), "confirmed"));
        var devWallet = new PublicKey(config.DevWallet);
        var publicRpc = new PerRpc(http, Tee);
        const ulong Fee = 5_000_000, Prize = 3_000_000;

        var players = new List<TPlayer>();
        for (int i = 0; i <= n; i++)
        {
            var (w, k, rpc) = await Retry(() => FundedPlayer(http, l1, deployer, i == 0 ? 120_000_000UL : 40_000_000UL, 20_000_000), $"fund t{i}");
            var p = new TPlayer { Name = $"t{i}", Wallet = w, Key = k, KeyRpc = rpc, Reader = new Account() };
            p.ReaderRpc = await Login(http, p.Reader);
            players.Add(p);
            await Task.Delay(1500);
        }
        var host = players[0];
        var outsider = players[n];
        var entrants = players.Take(n).ToList();
        // Absent at first: sends no seeds and never acts. It must still be dealt in, with 3 s turns; once both
        // are seen it comes back (else the final would crawl: an absent player only ever folds its blinds).
        entrants[5].Absent = true;
        bool absentDealt = false, absentShortTurn = false;
        await Task.Delay(10_000); // deposits settle in the rollup

        // ---- create, fund, register
        var id = PerHost.NewTableId();
        var tk = PerTourney.Address(host.Wallet.PublicKey, id);
        long startTs = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 150;
        var prm = new TourneyParams { Name = PerTourney.NameBytes("M11 devnet test"), Speed = PerTourney.Turbo, MaxPlayers = (byte)n, EntryFee = Fee, StartTs = startTs, CodeHash = new byte[32] };
        Check("the host creates the tournament and hands it to the rollup (one wallet transaction)", await Try(() => l1.Send(PerTourney.CreateAndDelegate(host.Wallet.PublicKey, id, prm), new WalletLike(host.Wallet))));
        Console.WriteLine($"   tournament {tk.Key}");
        await Task.Delay(12_000);
        var before = new Dictionary<string, ulong>();
        foreach (var p in players) before[p.Name] = await VaultBalanceOf(p.Key, p.KeyRpc);
        Check("the host funds a 0.003 SOL prize from the game balance (play key)", await Try(() => host.KeyRpc.Send(PerTourney.Fund(tk, host.Key, Prize), new LocalSigner(host.Key.Key))));
        foreach (var p in entrants)
        {
            var me = p;
            Check($"{p.Name} registers (0.005 SOL from the game balance)", await Try(() => me.KeyRpc.Send(PerTourney.Register(tk, me.Key, me.Reader.PublicKey), new LocalSigner(me.Key.Key))));
            if (p == entrants[1])
                Check("registering twice is refused (AlreadyRegistered)", await Refused(() => entrants[1].KeyRpc.Send(PerTourney.Register(tk, entrants[1].Key, new Account().PublicKey), new LocalSigner(entrants[1].Key.Key)), "AlreadyRegistered"));
        }
        Check("a tenth player is refused: the tournament is full (TourneyFull)", await Refused(() => outsider.KeyRpc.Send(PerTourney.Register(tk, outsider.Key, outsider.Reader.PublicKey), new LocalSigner(outsider.Key.Key)), "TourneyFull"));
        var leaver = entrants[6];
        var midLeave = await VaultBalanceOf(leaver.Key, leaver.KeyRpc);
        Check("a player leaves before the start: the fee comes back", await Try(() => leaver.KeyRpc.Send(PerTourney.Leave(tk, leaver.Key), new LocalSigner(leaver.Key.Key))));
        Check("...exactly 0.005 SOL back in the game balance", await VaultBalanceOf(leaver.Key, leaver.KeyRpc) == midLeave + Fee);
        Check("...and registers again", await Try(() => leaver.KeyRpc.Send(PerTourney.Register(tk, leaver.Key, leaver.Reader.PublicKey), new LocalSigner(leaver.Key.Key))));
        Check("a non-host can't fund the prize (NotCreator)", await Refused(() => entrants[1].KeyRpc.Send(PerTourney.Fund(tk, entrants[1].Key, 1), new LocalSigner(entrants[1].Key.Key)), "NotCreator"));
        var t0 = await ReadTourney(publicRpc, tk);
        Check($"anyone can read the tournament (public): {n} registered, the prize and every fee owed", t0 != null && t0.Count == n && t0.HostPrize == Prize && t0.Owed == Prize + (ulong)n * Fee, new { t0?.Count, t0?.HostPrize, t0?.Owed });

        // ---- tables: the keeper's job (it pays their rent, and gets it back when they close)
        int tables = PerTourney.TablesFor(n);
        var keeperBefore = await SolBalance(l1, KeeperKey);
        Poker.Per.Generated.Tournament tl = null;
        for (int w = 0; w < 60 && (tl == null || tl.Linked < tables); w++) { await Task.Delay(5000); tl = await ReadTourney(publicRpc, tk); }
        Check($"the keeper created, opened and linked the {tables} tables a minute before the start", tl != null && tl.Linked >= tables, new { tl?.Linked, tables });
        var tbl0 = Poker.Per.Generated.Table.Decode(await l1.GetAccount(PerTourney.TableAddress(tk, 0), "confirmed") ?? await publicRpc.GetAccount(PerTourney.TableAddress(tk, 0)));
        Check("its tables have 8 seats and name the keeper as their rent payer", tbl0 != null && tbl0.MaxSeats == 8 && new PublicKey(tbl0.Mint).Equals(KeeperKey), new { tbl0?.MaxSeats, mint = tbl0 == null ? null : new PublicKey(tbl0.Mint).Key });
        var t0a = new PerTableAddresses(PerTourney.TableAddress(tk, 0));
        // Refused before the handler (a chip table has no escrow: Anchor's AccountNotInitialized) or by its
        // TourneyTable guard; either way no money moves.
        bool buyInRefused;
        try { await outsider.KeyRpc.Send(new[] { outsider.Key.Check(), PerVault.BuyIn(t0a, outsider.Key, 0, 2_000_000, outsider.Reader.PublicKey) }, new LocalSigner(outsider.Key.Key)); buyInRefused = false; }
        catch (PerTxException e) { buyInRefused = e.ErrorName == "TourneyTable" || e.Message.Contains("3012"); Console.WriteLine("   " + e.Message); }
        Check("a tournament table refuses a buy-in (it holds chips, never money)", buyInRefused);
        Check("starting before the start time is refused (TourneyTooEarly)", await Refused(() => host.KeyRpc.Send(new[] { PerTourney.Start(tk, host.Key.Key.PublicKey) }, new LocalSigner(host.Key.Key)), "TourneyTooEarly"));

        // ---- start: the VRF draws the seats
        while (DateTimeOffset.UtcNow.ToUnixTimeSeconds() <= startTs + 1) await Task.Delay(2000);
        Check("registering after the start time is refused (TourneyClosed)", await Refused(() => outsider.KeyRpc.Send(PerTourney.Register(tk, outsider.Key, new Account().PublicKey), new LocalSigner(outsider.Key.Key)), "TourneyClosed"));
        // The test backend's keeper (M11) starts tournaments on time too; whoever's first, the other is refused.
        bool started;
        try { await host.KeyRpc.Send(new[] { PerTourney.Start(tk, host.Key.Key.PublicKey) }, new LocalSigner(host.Key.Key)); started = true; }
        catch (PerTxException e) { started = (e.ErrorName == "TourneyWrongStage" || e.ErrorName == "VrfPending") && (await ReadTourney(publicRpc, tk)).Status >= PerTourney.Drawing; Console.WriteLine("   " + e.Message + (started ? " (the keeper started it first)" : "")); }
        Check("at the start time anyone (this test, or the keeper first) starts it: the VRF is asked for the seat draw", started);
        Poker.Per.Generated.Tournament tr = null;
        for (int i = 0; i < 30 && (tr == null || tr.Status != PerTourney.Running); i++) { await Task.Delay(1000); tr = await ReadTourney(publicRpc, tk); }
        var placesOk = tr != null && Enumerable.Range(0, n).All(e => tr.Entrants[e].State == PerTourney.EntrantPlaying && tr.Entrants[e].Table < tables && tr.Entrants[e].Seat < 8)
            && Enumerable.Range(0, n).Select(e => tr.Entrants[e].Table * 10 + tr.Entrants[e].Seat).Distinct().Count() == n;
        Check($"the VRF callback drew the seats: {n} players over {tables} eight-seat table(s), every seat distinct", tr?.Status == PerTourney.Running && placesOk && tr.RoundTables == tables,
            tr == null ? null : (object)Enumerable.Range(0, n).Select(e => $"{tr.Entrants[e].Table}/{tr.Entrants[e].Seat}"));

        // Review H1: before the round is seated a table can't be synced (an empty table would look finished).
        Check("syncing a table before its round is seated is refused (review H1)", await Refused(() => outsider.KeyRpc.Send(new[] { PerIx.ComputeLimit(PerIx.PlayCu), PerTourney.Sync(tk, 0) }, new LocalSigner(outsider.Key.Key)), "TourneyTablesNotReady"));
        // Review M1: a tournament that's moving can't be abandoned.
        Check("a tournament that's moving can't be abandoned (review M1)", await Refused(() => outsider.KeyRpc.Send(new[] { new Solana.Unity.Rpc.Models.TransactionInstruction { ProgramId = PerIds.Program.KeyBytes, Keys = new List<Solana.Unity.Rpc.Models.AccountMeta> { Solana.Unity.Rpc.Models.AccountMeta.Writable(tk, false) }, Data = Ix.TourneyAbandon() } }, new LocalSigner(outsider.Key.Key)), "TourneyNotAbandoned"));
        bool sitOutChecked = false;
        // Your playtest: the players' browsers were the only ones starting hands, so a table whose players were away
        // never dealt. For the first 2 minutes of play nobody here starts a hand: the keeper has to.
        DateTime? firstSeated = null;
        var keeperOnlyHands = new Dictionary<int, ulong>(); // table -> hand number when the window opened
        bool keeperDealt = false;
        // ...and a player whose browser lost its table key moves the seat to a new one (tourney_set_reader).
        var rotator = entrants[2];
        bool rotated = false;

        // ---- play: everyone all-in every hand, so the rounds go quickly; one player never shows up
        var start = DateTime.UtcNow;
        int lastRound = 0, seatings = 0, syncs = 0, hands = 0, errors = 0;
        var seenTables = new HashSet<string>();
        while (DateTime.UtcNow - start < TimeSpan.FromMinutes(25))
        {
            tr = await ReadTourney(publicRpc, tk);
            if (tr.Status == PerTourney.Finished || tr.Status == PerTourney.Paid) break;
            if (tr.Round != lastRound) { SoakLog($"round {tr.Round}: {tr.RoundTables} table(s), {Enumerable.Range(0, tr.Count).Count(e => tr.Entrants[e].State == PerTourney.EntrantPlaying)} players"); lastRound = tr.Round; }
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            // Seat each table of the round once its round may start (anyone may; the host's key here).
            for (int i = 0; i < tr.RoundTables; i++)
            {
                if ((tr.DoneMask & (1 << i)) != 0 || now < tr.RoundStartsTs) continue;
                var ta = new PerTableAddresses(PerTourney.TableAddress(tk, i));
                var tab = Poker.Per.Generated.Table.Decode(await publicRpc.GetAccount(ta.Table));
                var want = PerTourney.SeatsToTake(tr, i, null).Where(s => (tab.SeatMask & (1 << s)) == 0).ToList();
                if (want.Count > 0 && tab.HandState == PerGame.HandIdle)
                    try { await host.KeyRpc.Send(new[] { PerIx.ComputeLimit(PerIx.PlayCu), PerTourney.SeatTable(tk, i, want) }, new LocalSigner(host.Key.Key)); seatings++; }
                    catch (Exception e) { if (errors++ < 10) SoakLog("seat: " + e.Message); }
            }
            if (firstSeated == null && tr.SeatedMask != 0) firstSeated = DateTime.UtcNow;
            bool keeperWindow = firstSeated != null && DateTime.UtcNow - firstSeated.Value < TimeSpan.FromMinutes(2);
            if (firstSeated != null && tr.Round == 1)
                for (int i = 0; i < tr.RoundTables; i++)
                {
                    var tab = Poker.Per.Generated.Table.Decode(await publicRpc.GetAccount(PerTourney.TableAddress(tk, i)));
                    if (tab == null) continue;
                    if (keeperWindow && !keeperOnlyHands.ContainsKey(i)) keeperOnlyHands[i] = tab.HandNo;
                    else if (keeperWindow && tab.HandNo > keeperOnlyHands[i]) keeperDealt = true;
                }
            // The absent player: dealt in without a seed? A short turn when it's to act?
            if (entrants[5].Absent)
            {
                int ae = Enumerable.Range(0, tr.Count).First(k => new PublicKey(tr.Entrants[k].Wallet).Equals(entrants[5].Wallet.PublicKey));
                var aen = tr.Entrants[ae];
                if (aen.State == PerTourney.EntrantPlaying && aen.Table < tr.RoundTables)
                {
                    var atab = Poker.Per.Generated.Table.Decode(await publicRpc.GetAccount(PerTourney.TableAddress(tk, aen.Table)));
                    if (atab.HandState >= PerGame.HandDealt && (atab.DealtMask & (1 << aen.Seat)) != 0) absentDealt = true;
                    var mate = entrants.FirstOrDefault(x => !x.Absent && x.SessionTable == aen.Table && x.Session?.Ledger != null);
                    var mg = mate?.Session.Ledger.Game;
                    if (atab.HandState == PerGame.HandPlaying && mg != null && mg.ToAct == aen.Seat)
                    {
                        long left = atab.TurnDeadline - DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                        if (left <= 4) absentShortTurn = true;
                    }
                }
                if ((absentDealt && absentShortTurn) || DateTime.UtcNow - start > TimeSpan.FromMinutes(6)) { entrants[5].Absent = false; SoakLog($"absent player returns (dealt without a seed: {absentDealt}, 3 s turn: {absentShortTurn})"); }
            }
            foreach (var p in entrants.Where(x => !x.Absent))
            {
                int e = Enumerable.Range(0, tr.Count).FirstOrDefault(k => new PublicKey(tr.Entrants[k].Wallet).Equals(p.Wallet.PublicKey));
                var en = tr.Entrants[e];
                if (en.State != PerTourney.EntrantPlaying || en.Table >= tr.RoundTables) continue;
                if (p.SessionTable != en.Table)
                {
                    var tbl = PerTourney.TableAddress(tk, en.Table);
                    p.Session = new PerTableSession(tbl, publicRpc, p.ReaderRpc, new LocalSigner(p.Reader), p.Wallet.PublicKey);
                    p.SessionTable = en.Table;
                    seenTables.Add($"{p.Name}->{en.Table}");
                }
                try
                {
                    await p.Session.Poll();
                    await p.Session.KeepMoving();
                    var tb = p.Session.Table;
                    if (tb == null || p.Session.MySeat < 0) continue;
                    if (!sitOutChecked && tb.HandState == PerGame.HandIdle)
                    {
                        sitOutChecked = true;
                        Check("Sit out is refused at a tournament table (review H2)", await Refused(() => p.ReaderRpc.Send(new[] { PerIx.SitOut(p.Session.Addresses, p.Reader.PublicKey, p.Session.MySeat) }, new LocalSigner(p.Reader)), "TourneyTable"));
                    }
                    if (p == rotator && !rotated && firstSeated != null && tb.HandState == PerGame.HandIdle)
                    {
                        rotated = true;
                        int seat = p.Session.MySeat;
                        var fresh = new Account();
                        Check("a player's key can't take another entrant's table key (InvalidReader)", await Refused(() => p.KeyRpc.Send(new[] { p.Key.Check(), PerTourney.SetReader(tk, p.Key, entrants[3].Reader.PublicKey, -1, -1) }, new LocalSigner(p.Key.Key)), "InvalidReader"));
                        Check("an outsider's play key can't move anyone's registration (NotRegistered)", await Refused(() => outsider.KeyRpc.Send(new[] { outsider.Key.Check(), PerTourney.SetReader(tk, outsider.Key, new Account().PublicKey, -1, -1) }, new LocalSigner(outsider.Key.Key)), "NotRegistered"));
                        bool moved;
                        try { await p.KeyRpc.Send(new[] { p.Key.Check(), PerTourney.SetReader(tk, p.Key, fresh.PublicKey, en.Table, seat) }, new LocalSigner(p.Key.Key)); moved = true; }
                        catch (PerTxException ex) { moved = false; rotated = ex.ErrorName != "HandInProgress"; SoakLog("set reader: " + ex.Message); }
                        if (moved)
                        {
                            var oldReader = p.Reader;
                            p.Reader = fresh;
                            p.ReaderRpc = await Login(http, fresh);
                            p.Session = new PerTableSession(PerTourney.TableAddress(tk, en.Table), publicRpc, p.ReaderRpc, new LocalSigner(p.Reader), p.Wallet.PublicKey);
                            await p.Session.Poll();
                            var tm = await ReadTourney(publicRpc, tk);
                            var me2 = Enumerable.Range(0, tm.Count).Select(k => tm.Entrants[k]).First(x => new PublicKey(x.Wallet).Equals(p.Wallet.PublicKey));
                            Check("a lost table key is replaced by the play key: the registration and the seat move to the new key", new PublicKey(me2.Reader).Equals(fresh.PublicKey) && p.Session.MySeat == seat, new { seat, found = p.Session.MySeat });
                            var oldSession = new PerTableSession(PerTourney.TableAddress(tk, en.Table), publicRpc, await Login(http, oldReader), new LocalSigner(oldReader), p.Wallet.PublicKey);
                            await oldSession.Poll();
                            Check("...and the old key no longer finds the seat (it can't read the ledger or act)", oldSession.MySeat < 0, oldSession.MySeat);
                            tb = p.Session.Table;
                        }
                    }
                    if (tb.HandState == PerGame.HandIdle)
                    {
                        try { await p.ReaderRpc.Send(new[] { PerIx.ComputeLimit(PerIx.PlayCu), PerTourney.Sync(tk, en.Table) }, new LocalSigner(p.Reader)); syncs++; }
                        catch (PerTxException) { }
                        await p.Session.Poll();
                        if (!keeperWindow && p.Session.MySeat >= 0 && p.Session.Table.HandState == PerGame.HandIdle && await p.Session.PrepareNextHand() != null) hands++;
                    }
                    var g = p.Session.Ledger?.Game;
                    if (p.Session.Table.HandState == PerGame.HandPlaying && g != null && g.ToAct == p.Session.MySeat)
                    {
                        var legal = PerGame.Legal(g);
                        await p.Session.Act(legal.CanAllIn ? ActionType.AllIn : legal.CanCall ? ActionType.Call : ActionType.Check, 0);
                    }
                }
                catch (PerTxException ex) when (ex.ErrorName == "NotYourTurn" || ex.ErrorName == "HandNotPlaying" || ex.ErrorName == "HandInProgress" || ex.ErrorName == "MissingSeeds") { }
                catch (Exception ex) { if (errors++ < 20) SoakLog($"{p.Name}: {ex.Message}"); }
            }
            await Task.Delay(700);
        }
        tr = await ReadTourney(publicRpc, tk);
        var places = Enumerable.Range(0, tr.Count).Select(e => (int)tr.Entrants[e].Place).OrderBy(x => x).ToList();
        Check("the tournament finished: a champion and a runner-up", (tr.Status == PerTourney.Finished || tr.Status == PerTourney.Paid) && !new PublicKey(tr.Champion).Equals(new PublicKey(new byte[32])) && !new PublicKey(tr.RunnerUp).Equals(new PublicKey(new byte[32])),
            new { tr.Status, tr.Round, minutes = Math.Round((DateTime.UtcNow - start).TotalMinutes, 1), seatings, syncs, hands, errors });
        Check($"every player got a distinct finishing place 1..{n}", places.SequenceEqual(Enumerable.Range(1, n)), places);
        Check(tables > 1 ? "it took two rounds (the tables, then the final table)" : "one table: the final from the start", tr.Round == (tables > 1 ? 2 : 1), tr.Round);
        Check("the table-key swap ran (a seated player was found between hands)", rotated);
        Check("the keeper dealt hands while no player started one (tables with players away keep moving)", keeperDealt, keeperOnlyHands);
        Check("a player who sent no seed was still dealt in (absent players are blinded away, not skipped)", absentDealt);
        Check("...and its turns ran out after 3 s, not 15", absentShortTurn);

        // ---- payout
        var champ = new PublicKey(tr.Champion);
        var runner = new PublicKey(tr.RunnerUp);
        var (first, second, fee) = PerTourney.Payouts(Fee, n, Prize);
        var champP = players.First(p => p.Wallet.PublicKey.Equals(champ));
        var runP = players.First(p => p.Wallet.PublicKey.Equals(runner));
        // Measured from before the tournament (the keeper may pay out within seconds of the end, before this test
        // gets there): each paid its entry fee once (the leaver's came back), the host also the prize.
        ulong Paid(TPlayer p) => Fee + (p == host ? Prize : 0);
        var champBefore = before[champP.Name] - Paid(champP);
        var runBefore = before[runP.Name] - Paid(runP);
        bool paidOut;
        try { await outsider.KeyRpc.Send(new[] { PerTourney.Payout(tk, champ, runner, devWallet) }, new LocalSigner(outsider.Key.Key)); paidOut = true; }
        catch (PerTxException e) { paidOut = e.ErrorName == "TourneyWrongStage" && (await ReadTourney(publicRpc, tk)).Status == PerTourney.Paid; Console.WriteLine("   " + e.Message + (paidOut ? " (the keeper paid out first)" : "")); }
        Check("anyone (this test, or the keeper first) pays out: champion, runner-up and the 5% platform fee", paidOut);
        await Task.Delay(2000);
        var champAfter = await VaultBalanceOf(champP.Key, champP.KeyRpc);
        var runAfter = await VaultBalanceOf(runP.Key, runP.KeyRpc);
        Check($"the champion got {first} (60% of the pool after the fee)", champAfter - champBefore == first, new { got = champAfter - champBefore, first });
        Check($"the runner-up got {second} (40%)", runAfter - runBefore == second, new { got = runAfter - runBefore, second });
        Check("prizes + fee = host prize + entry fees, exactly", first + second + fee == Prize + (ulong)n * Fee);
        var tp = await ReadTourney(publicRpc, tk);
        Check("paid once: the tournament owes nothing; a second payout is refused", tp.Status == PerTourney.Paid && tp.Owed == 0
            && await Refused(() => outsider.KeyRpc.Send(new[] { PerTourney.Payout(tk, champ, runner, devWallet) }, new LocalSigner(outsider.Key.Key)), "TourneyWrongStage"));

        // ---- a cancelled tournament refunds everyone
        var id2 = PerHost.NewTableId();
        var t2 = PerTourney.Address(host.Wallet.PublicKey, id2);
        var prm2 = new TourneyParams { Name = PerTourney.NameBytes("M11 cancel test"), Speed = PerTourney.Turbo, MaxPlayers = 4, EntryFee = 1_000_000, StartTs = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 300, CodeHash = new byte[32] };
        await Retry(() => l1.Send(PerTourney.CreateAndDelegate(host.Wallet.PublicKey, id2, prm2), new WalletLike(host.Wallet)), "create t2");
        await Task.Delay(12_000);
        var hostB = await VaultBalanceOf(host.Key, host.KeyRpc);
        var pB = await VaultBalanceOf(outsider.Key, outsider.KeyRpc);
        await host.KeyRpc.Send(PerTourney.Fund(t2, host.Key, 2_000_000), new LocalSigner(host.Key.Key));
        await outsider.KeyRpc.Send(PerTourney.Register(t2, outsider.Key, outsider.Reader.PublicKey), new LocalSigner(outsider.Key.Key));
        Check("only the host can cancel (NotCreator)", await Refused(() => outsider.KeyRpc.Send(PerTourney.Cancel(t2, outsider.Key), new LocalSigner(outsider.Key.Key)), "NotCreator"));
        Check("the host cancels before the start", await Try(() => host.KeyRpc.Send(PerTourney.Cancel(t2, host.Key), new LocalSigner(host.Key.Key))));
        Check("registering in a cancelled tournament is refused", await Refused(() => entrants[1].KeyRpc.Send(PerTourney.Register(t2, entrants[1].Key, new Account().PublicKey), new LocalSigner(entrants[1].Key.Key)), "TourneyClosed"));
        Check("anyone refunds the player", await Try(() => entrants[1].KeyRpc.Send(new[] { PerTourney.Refund(t2, outsider.Wallet.PublicKey) }, new LocalSigner(entrants[1].Key.Key))));
        Check("anyone refunds the host's prize", await Try(() => entrants[1].KeyRpc.Send(new[] { PerTourney.Refund(t2, host.Wallet.PublicKey) }, new LocalSigner(entrants[1].Key.Key))));
        Check("a second refund is refused (NothingOwed)", await Refused(() => entrants[1].KeyRpc.Send(new[] { PerTourney.Refund(t2, outsider.Wallet.PublicKey) }, new LocalSigner(entrants[1].Key.Key)), "NothingOwed"));
        await Task.Delay(2000);
        Check("both game balances are back where they started", await VaultBalanceOf(host.Key, host.KeyRpc) == hostB && await VaultBalanceOf(outsider.Key, outsider.KeyRpc) == pB);
        // ---- after the end the keeper closes everything and gets the rent back
        bool tablesGone = false, tourneyGone = false;
        for (int w = 0; w < 60 && !(tablesGone && tourneyGone); w++)
        {
            await Task.Delay(10_000);
            tablesGone = true;
            for (int i = 0; i < tables; i++) if (await l1.GetAccount(PerTourney.TableAddress(tk, i), "confirmed") is byte[] d && d.Length > 0) tablesGone = false;
            tourneyGone = await l1.GetAccount(tk, "confirmed") is not byte[] td || td.Length == 0;
        }
        var keeperAfter = await SolBalance(l1, KeeperKey);
        Check("after the payout the keeper closed the tables and reclaimed their rent on Solana", tablesGone);
        Check("...then closed the tournament and returned its rent to the host", tourneyGone);
        Check("the keeper got its table rent back (net cost under 0.01 SOL per table, the locked permission rent aside)", (long)keeperBefore - (long)keeperAfter < 10_000_000L * tables, new { spent = (long)keeperBefore - (long)keeperAfter });
        Outcomes.Add(new { tournament = tk.Key, cancelled = t2.Key, tables, champion = champ.Key, first, second, fee, seenTables, keeperSpent = (long)keeperBefore - (long)keeperAfter });
    }

    static async Task<bool> Refused(Func<Task<string>> f, string error)
    {
        try { await f(); Console.WriteLine($"   accepted (expected {error})"); return false; }
        catch (PerTxException e) { Console.WriteLine("   " + e.Message); return e.ErrorName == error; }
        catch (Exception e) { Console.WriteLine("   " + e.Message); return false; }
    }

    // ---- M10 (review H1): the exit with the game's builders (PerVault.VaultExit / VaultPayout)
    static async Task Exit()
    {
        var http = new Http();
        var l1 = new PerRpc(http, Devnet);
        var deployer = LoadKey("deployer");
        var (w, k, rpc) = await FundedPlayer(http, l1, deployer, 40_000_000, 10_000_000);
        await Task.Delay(12_000);
        Check("the game balance holds the deposit", await VaultBalanceOf(k, rpc) == 10_000_000);
        Check("vault_exit (C# builder) takes 0.007 SOL out of the rollup (wallet signs on Solana)", await Try(() => l1.Send(new[] { PerVault.VaultExit(w.PublicKey, 7_000_000, PerVault.NewShuttleId()) }, new WalletLike(w))));
        ulong landed = 0;
        for (int i = 0; i < 30 && landed < 7_000_000; i++) { await Task.Delay(4000); landed = await SolBalance(l1, PerVault.Vault(w.PublicKey)); }
        Check("it lands on the vault on Solana as SOL", landed == 7_000_000, landed);
        var before = await SolBalance(l1, w.PublicKey);
        Check("vault_payout (C# builders: payout + unwrap) pays the wallet", await Try(() => l1.Send(PerVault.VaultPayout(w.PublicKey), new WalletLike(w))));
        await Task.Delay(4000);
        var gained = (long)await SolBalance(l1, w.PublicKey) - (long)before;
        Check("the wallet gained the 0.007 SOL (less fees)", gained >= 7_000_000 - 20_000, gained);
        Check("0.003 SOL is still the game balance", await VaultBalanceOf(k, rpc) == 3_000_000);
        Outcomes.Add(new { wallet = w.PublicKey.Key, gained });
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
                    if (t.HandState == PerGame.HandIdle && wantMore && !p.Session.StartRequested && p.Session.MayStartRound && p.Session.SeatedWithChips >= 2) await p.Session.RequestStart();
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
