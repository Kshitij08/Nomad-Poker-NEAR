using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Poker.Bots;
using Poker.Core;

// Golden vectors from the real Unity C# tournament core, for packages/engine/src/tournament/__tests__/parity.test.ts.
//   cd packages/engine/src/tournament/__tests__/golden/gen && dotnet run -c Release -p:UNITY_REPO=<Unity Poker checkout> -- ../tournament-golden.json
static class Program
{
    static string Q(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"";
    static string Arr(IEnumerable<string> items) => "[" + string.Join(",", items.Select(Q)) + "]";
    static List<string> Ids(int n) => Enumerable.Range(1, n).Select(i => $"p{i:00}").ToList();

    static string Describe(TournamentCommand c) => c switch
    {
        TableOpenedCommand o => $"open T{o.TableId} R{o.Round}{(o.IsFinal ? " final" : "")} @{o.DealAtMs}: " +
                                string.Join(",", o.Seats.Select(s => $"{s.EntrantId}@{s.Seat}")),
        BlindsUpCommand b => $"blinds T{b.TableId} {b.Blinds}",
        SpeedUpStartedCommand s => $"fast T{s.TableId}",
        HighCardDrawCommand h => $"draw T{h.TableId} " + string.Join(",", h.Cards.Select(x => x.EntrantId + x.Card.Short)),
        PlayersEliminatedCommand e => $"out T{e.TableId} R{e.Round} " + string.Join(",", e.EntrantIds),
        TableClosedCommand t => $"close T{t.TableId} " + string.Join(",", t.Survivors),
        TournamentFinishedCommand f => "won " + f.ChampionId + " " + string.Join(",", f.Standings.Select(s => $"{s.Place}:{s.EntrantId}:{s.RoundReached}{(s.IsChampion ? "*" : "")}")),
        TournamentCancelledCommand x => "cancelled " + x.Reason,
        _ => c.GetType().Name
    };

    // ---- Scripted director (TournamentDirectorTests.Script) ---------------------------------
    sealed class Script
    {
        public readonly TournamentDirector D;
        public readonly Dictionary<string, long> Stack = new Dictionary<string, long>();
        public readonly List<string> Log = new List<string>();
        public long Now;
        public Script(int players, int seed, TournamentSpeed speed = TournamentSpeed.Regular)
        {
            D = new TournamentDirector(Ids(players), speed, new SeededRandom(seed));
        }
        public void Apply(IReadOnlyList<TournamentCommand> commands)
        {
            foreach (var c in commands)
            {
                Log.Add(Describe(c));
                if (c is TableOpenedCommand o) foreach (var s in o.Seats) Stack[s.EntrantId] = o.StartingStack;
            }
        }
        public long DealAt(int table) => D.Snapshot(Now).Tables[table].DealAtMs;
        public void Bust(int table, string loser, string winner)
        {
            Now = Math.Max(Now, DealAt(table));
            Log.Add("bl " + D.BlindsForNextHand(table, Now));
            var results = D.PlayersAt(table).Select(id =>
                id == loser ? new SeatResult(id, Stack[id], 0)
                : id == winner ? new SeatResult(id, Stack[id], Stack[id] + Stack[loser])
                : new SeatResult(id, Stack[id], Stack[id])).ToList();
            Stack[winner] += Stack[loser];
            Stack[loser] = 0;
            Apply(D.ReportHand(table, results, Now));
        }
        public void PlayDown(int table, int left)
        {
            while (D.PlayersAt(table).Count > left)
            {
                Now += 30_000;
                Apply(D.Tick(Now));
                var players = D.PlayersAt(table);
                Bust(table, players[players.Count - 1], players[0]);
            }
        }
        /// <summary>Two (or three) players with equal stacks bust on one hand: exercises the high-card draw.</summary>
        public void MultiBust(int table, int count)
        {
            Now = Math.Max(Now + 30_000, DealAt(table));
            D.BlindsForNextHand(table, Now);
            var players = D.PlayersAt(table).ToList();
            string winner = players[0];
            var losers = players.Skip(players.Count - count).ToList();
            var results = new List<SeatResult>();
            long pot = 0;
            foreach (var l in losers) pot += Stack[l];
            foreach (var id in players)
            {
                long start = Stack[id];
                long end = losers.Contains(id) ? 0 : id == winner ? start + pot : start;
                results.Add(new SeatResult(id, start, end));
            }
            foreach (var l in losers) Stack[l] = 0;
            Stack[winner] += pot;
            Apply(D.ReportHand(table, results, Now));
        }
    }

    static string Scripted(int players, int seed, int[] order)
    {
        var s = new Script(players, seed);
        s.Apply(s.D.Start(s.Now));
        foreach (int t in order) s.PlayDown(t, s.D.Snapshot(s.Now).Tables[t].IsFinal ? 1 : 2);
        var snap = s.D.Snapshot(s.Now);
        s.Log.Add($"snap {snap.Entrants} {snap.PlayersRemaining} {(snap.IsFinished ? 1 : 0)} " +
                  string.Join(";", snap.Tables.Select(t => $"{t.TableId}:{t.Round}:{(t.IsFinal ? 1 : 0)}{(t.IsClosed ? 1 : 0)}{(t.IsDealing ? 1 : 0)}{(t.IsSpedUp ? 1 : 0)}:{t.PlayersLeft}:{t.DealAtMs}:{t.Blinds}:{t.MsToNextLevel}")));
        return string.Join("\n", s.Log);
    }

    // ---- Whole tournaments on engines with bots (TournamentSimulationTests) ------------------
    sealed class SimTable
    {
        public int Id;
        public PokerEngine Engine;
        public readonly Dictionary<string, int> SeatOf = new Dictionary<string, int>();
    }

    static string Simulate(int players, int seed)
    {
        var log = new List<string>();
        var ids = Ids(players);
        var director = new TournamentDirector(ids, TournamentSpeed.Regular, new SeededRandom(seed));
        var bots = new Dictionary<string, IPokerBot>();
        for (int i = 0; i < ids.Count; i++) bots[ids[i]] = new HeuristicBot(seed * 1000 + i);
        var tables = new Dictionary<int, SimTable>();
        var order = new List<int>();
        long now = 0;
        int hands = 0;

        void Apply(IReadOnlyList<TournamentCommand> commands)
        {
            foreach (var c in commands)
            {
                log.Add(Describe(c));
                switch (c)
                {
                    case TableOpenedCommand o:
                        var t = new SimTable
                        {
                            Id = o.TableId,
                            Engine = new PokerEngine(new TableConfig { SeatCount = TournamentRules.SeatsPerTable }, new SeededRandom(seed * 31 + o.TableId))
                        };
                        foreach (var s in o.Seats)
                        {
                            t.Engine.SeatPlayer(s.Seat, s.EntrantId, s.EntrantId, true, o.StartingStack);
                            t.SeatOf[s.EntrantId] = s.Seat;
                        }
                        tables.Add(o.TableId, t);
                        order.Add(o.TableId);
                        break;
                    case PlayersEliminatedCommand e:
                        var at = tables[e.TableId];
                        foreach (var id in e.EntrantIds)
                        {
                            at.Engine.VacateSeat(at.SeatOf[id]);
                            at.SeatOf.Remove(id);
                        }
                        break;
                    case TableClosedCommand closed:
                        tables.Remove(closed.TableId);
                        order.Remove(closed.TableId);
                        break;
                }
            }
        }

        Apply(director.Start(now));
        while (!director.IsFinished)
        {
            now += 20_000;
            Apply(director.Tick(now));
            foreach (int id in order.ToList())
            {
                if (director.IsFinished) break;
                if (!tables.TryGetValue(id, out var t) || !director.CanDeal(t.Id, now)) continue;
                var blinds = director.BlindsForNextHand(t.Id, now);
                t.Engine.SetBlinds(blinds.SmallBlind, blinds.BigBlind);
                var dealtIn = director.PlayersAt(t.Id).ToList();
                var start = dealtIn.ToDictionary(x => x, x => t.Engine.Table.Seats[t.SeatOf[x]].Stack);
                PlayHand(t.Engine, bots);
                var results = dealtIn.Select(x => new SeatResult(x, start[x], t.Engine.Table.Seats[t.SeatOf[x]].Stack)).ToList();
                hands++;
                Apply(director.ReportHand(t.Id, results, now));
            }
        }
        log.Add($"hands {hands} now {now}");
        return string.Join("\n", log);
    }

    static void PlayHand(PokerEngine engine, Dictionary<string, IPokerBot> bots)
    {
        engine.StartHand();
        while (engine.HandInProgress)
        {
            int seat = engine.AwaitingActionSeat;
            var p = engine.Table.Seats[seat];
            var context = new BotContext
            {
                SeatIndex = seat, HoleCards = p.HoleCards, Community = engine.Table.Community, Round = engine.Table.Round,
                Pot = engine.Table.Pot, MyStack = p.Stack, MyCurrentBet = p.CurrentBet, BigBlind = engine.Table.BigBlind,
                OpponentsInHand = engine.CountInHand() - 1,
                Position = BotContext.PositionOf(engine.Table.ButtonSeat, seat, engine.Table.SeatCount),
                Legal = engine.CurrentLegalActions
            };
            engine.SubmitAction(seat, bots[p.Id].Decide(context));
        }
    }

    // ---- .NET's unstable List.Sort ---------------------------------------------------------
    static string SortCase(int n, int keys, int seed)
    {
        var rng = new SeededRandom(seed);
        var list = new List<(int key, int idx)>();
        for (int i = 0; i < n; i++) list.Add((rng.Next(keys), i));
        list.Sort((a, b) => a.key.CompareTo(b.key));
        return string.Join(",", list.Select(x => $"{x.key}.{x.idx}"));
    }

    static void Main(string[] args)
    {
        var sb = new StringBuilder();
        sb.Append("{\n");

        // List.Sort order with ties (lengths around the 2/3/16 thresholds and past the heapsort depth).
        var sorts = new List<string>();
        foreach (int n in new[] { 2, 3, 4, 7, 8, 16, 17, 30, 33, 64, 200 })
            foreach (int keys in new[] { 2, 3, 5, 1000 })
                foreach (int seed in new[] { 1, 2, 3 })
                    sorts.Add($"{{\"n\":{n},\"keys\":{keys},\"seed\":{seed},\"out\":{Q(SortCase(n, keys, seed))}}}");
        sb.Append("\"sort\": [" + string.Join(",\n", sorts) + "],\n");

        // High-card draws.
        var draws = new List<string>();
        for (int seed = 0; seed < 40; seed++)
        {
            var ids = new[] { "a", "b", "c", "d", "e" }.Take(2 + seed % 4).ToArray();
            var d = HighCardDraw.Draw(ids, new SeededRandom(seed));
            draws.Add($"{{\"seed\":{seed},\"n\":{ids.Length},\"out\":{Q(string.Join(",", d.Select(x => x.EntrantId + x.Card.Short)))}}}");
        }
        sb.Append("\"highCard\": [" + string.Join(",\n", draws) + "],\n");

        // First-round and next-round draws.
        var first = new List<string>();
        foreach (int n in new[] { 2, 7, 8, 15, 16, 20, 30 })
            foreach (int seed in new[] { 5, 9, 10 })
            {
                int tables = RoundPlanner.TablesPerRound(RoundPlanner.FormatFor(n))[0];
                var t = RoundPlanner.DrawFirstRound(Ids(n), tables, new SeededRandom(seed));
                first.Add($"{{\"n\":{n},\"seed\":{seed},\"tables\":{tables},\"out\":{Q(string.Join("|", t.Select(x => string.Join(",", x.Select(s => $"{s.EntrantId}@{s.Seat}")))))}}}");
            }
        sb.Append("\"firstRound\": [" + string.Join(",\n", first) + "],\n");

        var next = new List<string>();
        for (int seed = 0; seed < 20; seed++)
        {
            var groups = seed % 2 == 0
                ? new IReadOnlyList<string>[] { new[] { "a1", "a2" }, new[] { "b1", "b2" } }
                : new IReadOnlyList<string>[] { new[] { "a1", "a2" }, new[] { "b1", "b2", "b3" } };
            var seats = RoundPlanner.DrawNextRound(groups, new SeededRandom(seed));
            next.Add($"{{\"seed\":{seed},\"out\":{Q(string.Join(",", seats.Select(s => $"{s.EntrantId}@{s.Seat}")))}}}");
        }
        sb.Append("\"nextRound\": [" + string.Join(",\n", next) + "],\n");

        // Referee with tied busts.
        var referee = new List<string>();
        for (int seed = 0; seed < 30; seed++)
        {
            var results = new[]
            {
                new SeatResult("a", 2000, 0), new SeatResult("b", 2000, 0), new SeatResult("c", 1000, 0),
                new SeatResult("d", 2000, 0), new SeatResult("e", 1000, 0), new SeatResult("f", 5000, 13000),
                new SeatResult("g", 4000, 4000),
            };
            foreach (var stage in new[] { TableStage.Qualifier, TableStage.Final })
            {
                var o = TableReferee.Resolve(stage, results, new SeededRandom(seed));
                referee.Add($"{{\"seed\":{seed},\"stage\":{(int)stage},\"out\":{Arr(o.EliminatedWorstFirst)},\"rem\":{Arr(o.Remaining)},\"closed\":{(o.TableClosed ? "true" : "false")},\"champ\":{(o.Champion == null ? "null" : Q(o.Champion))},\"draws\":{Q(string.Join(",", o.Draws.Select(x => x.EntrantId + x.Card.Short)))}}}");
            }
        }
        sb.Append("\"referee\": [" + string.Join(",\n", referee) + "],\n");

        // Payouts.
        var pay = new List<string>();
        var prng = new SeededRandom(3);
        for (int i = 0; i < 300; i++)
        {
            long prize = prng.Next(1_000_000), fee = prng.Next(10_000);
            int players = prng.Next(31), bps = prng.Next(10_001);
            var p = PayoutCalculator.Compute(prize, fee, players, bps);
            pay.Add($"[{prize},{fee},{players},{bps},{p.Pool},{p.Fee},{p.First},{p.Second}]");
        }
        sb.Append("\"payout\": [" + string.Join(",", pay) + "],\n");

        // Clocks: a speed-up at an arbitrary time, sampled.
        var clocks = new List<string>();
        var crng = new SeededRandom(11);
        for (int i = 0; i < 40; i++)
        {
            long levelMs = 60_000 * (1 + crng.Next(12)) + crng.Next(1000);
            long start = crng.Next(1_000_000);
            long speedAt = i % 4 == 0 ? -1 : start + crng.Next(10_000_000) - (i % 7 == 0 ? 2_000_000 : 0);
            var c = new TableClock(levelMs);
            bool startedBefore = i % 5 != 0;
            if (startedBefore) c.Start(start);
            if (speedAt >= 0) c.EnableSpeedUp(speedAt);
            if (!startedBefore) c.Start(start);
            var samples = new List<string>();
            for (int k = 0; k < 12; k++)
            {
                long t = start + crng.Next(20_000_000);
                samples.Add($"{t}:{c.LevelAt(t)}:{c.MsToNextLevel(t)}");
            }
            clocks.Add($"{{\"levelMs\":{levelMs},\"start\":{start},\"speedAt\":{speedAt},\"startedBefore\":{(startedBefore ? "true" : "false")},\"out\":{Q(string.Join(",", samples))}}}");
        }
        sb.Append("\"clock\": [" + string.Join(",\n", clocks) + "],\n");

        // Scripted directors.
        var scripted = new List<string>
        {
            $"{{\"players\":5,\"seed\":2,\"order\":[0],\"log\":{Q(Scripted(5, 2, new[] { 0 }))}}}",
            $"{{\"players\":12,\"seed\":3,\"order\":[0,1,2],\"log\":{Q(Scripted(12, 3, new[] { 0, 1, 2 }))}}}",
            $"{{\"players\":30,\"seed\":8,\"order\":[1,3,0,2,4,5,6],\"log\":{Q(Scripted(30, 8, new[] { 1, 3, 0, 2, 4, 5, 6 }))}}}",
            $"{{\"players\":30,\"seed\":9,\"order\":[1,3,0,2,4,5,6],\"log\":{Q(Scripted(30, 9, new[] { 1, 3, 0, 2, 4, 5, 6 }))}}}",
            $"{{\"players\":30,\"seed\":4,\"order\":[2,0,1,4,3,5,6],\"log\":{Q(Scripted(30, 4, new[] { 2, 0, 1, 4, 3, 5, 6 }))}}}",
            $"{{\"players\":16,\"seed\":21,\"order\":[3,2,1,0,4,5,6],\"log\":{Q(Scripted(16, 21, new[] { 3, 2, 1, 0, 4, 5, 6 }))}}}",
        };
        sb.Append("\"scripted\": [" + string.Join(",\n", scripted) + "],\n");

        // Multi-bust (high-card draws through the director).
        var multi = new List<string>();
        foreach (int seed in new[] { 1, 2, 3, 4, 5 })
        {
            var s = new Script(8, seed);
            s.Apply(s.D.Start(0));
            s.MultiBust(0, 2);       // 4 → 2: table closes, no top-up
            s.MultiBust(1, 3);       // 4 → 1: two equal busts... one goes through
            multi.Add($"{{\"seed\":{seed},\"log\":{Q(string.Join("\n", s.Log))}}}");
        }
        sb.Append("\"multiBust\": [" + string.Join(",\n", multi) + "],\n");

        // Whole tournaments with bots on engines.
        var sims = new List<string>();
        foreach (var (players, seed) in new[] { (2, 1), (7, 2), (8, 3), (15, 4), (16, 5), (30, 6) })
            sims.Add($"{{\"players\":{players},\"seed\":{seed},\"log\":{Q(Simulate(players, seed))}}}");
        sb.Append("\"simulation\": [" + string.Join(",\n", sims) + "]\n");

        sb.Append("}\n");
        File.WriteAllText(args[0], sb.ToString());
        Console.WriteLine("wrote " + args[0]);
    }
}
