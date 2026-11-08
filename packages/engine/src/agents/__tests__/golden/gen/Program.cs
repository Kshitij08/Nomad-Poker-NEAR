using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Poker.Bots;
using Poker.Core;
using Poker.Net;
using Poker.Net.NomadUi;
using UnityEngine;

// Golden vectors for packages/engine/src/agents/__tests__/agentsParity.test.ts, from the real Unity C# sources.
static class Program
{
    static string R(double d) => d.ToString("R", CultureInfo.InvariantCulture);
    static string R(float f) => ((double)f).ToString("R", CultureInfo.InvariantCulture);
    static string Card(string c) => "<" + c + ">";

    static string Frame(ReplayFrame f)
    {
        var seats = f.Seats.OrderBy(kv => kv.Key).Select(kv =>
        {
            var s = kv.Value;
            return $"{kv.Key}:{s.Stack},{s.Bet},{(s.Folded ? "F" : "")}{(s.AllIn ? "A" : "")},{(s.Cards == null ? "-" : string.Join(" ", s.Cards))},{s.Label},{s.HandDescription ?? "-"},{s.Won}";
        });
        return $"{f.Pot}|{f.Street}|{string.Join(" ", f.Board)}|{f.ActiveSeat}|{f.Caption}|{string.Join(";", seats)}";
    }

    static string Round(ReplayRound r) => $"{r.Name}|{r.Title}|{r.StreetStep}|{(r.IsEnd ? 1 : 0)}|{string.Join(",", r.Steps)}";

    sealed class Seat { public string Name; public long Stack; public bool Agent; public string Preset; public bool Custom; }

    /// <summary>A Quick Play table with Agents, recorded the way PokerServerGame records them (one recorder per Agent).</summary>
    static JArray Scenario(int seed, Seat[] seats, int maxHands, long sb, long bb)
    {
        int n = seats.Length;
        var engine = new PokerEngine(new TableConfig { SeatCount = n, SmallBlind = sb, BigBlind = bb, StartingStack = 5000 }, new SeededRandom(seed));
        var bots = new Dictionary<int, IPokerBot>();
        var recorders = new Dictionary<int, AgentHandReplayRecorder>();
        for (int s = 0; s < n; s++)
        {
            var seat = seats[s];
            if (seat == null) continue;
            engine.SeatPlayer(s, seat.Agent ? $"agent-{s}" : $"bot{s}", seat.Name, true, seat.Stack, seat.Agent);
            if (seat.Agent)
            {
                var cfg = new AgentDeploymentConfig { AgentName = seat.Name, Bankroll = seat.Stack, StrategyPreset = seat.Preset };
                if (seat.Custom)
                    cfg.Profile = new BotProfileSnapshot
                    {
                        FoldBelow = 0.35f, RaiseAbove = 0.58f, Aggression = 0.45f, BluffChance = 0.03f, RaiseFractionOfPot = 0.6f,
                        HasCustom = true, Brain = 2,
                        Streets = new[]
                        {
                            new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.10f, RaiseAbove = 0.55f, Aggression = 0.60f, BluffChance = 0.05f, RaiseFractionOfPot = 0.60f },
                            new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.50f, RaiseAbove = 0.70f, Aggression = 0.45f, BluffChance = 0.00f, RaiseFractionOfPot = 0.50f },
                            new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.50f, RaiseAbove = 0.70f, Aggression = 0.45f, BluffChance = 0.00f, RaiseFractionOfPot = 0.50f },
                            new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.50f, RaiseAbove = 0.70f, Aggression = 0.45f, BluffChance = 0.00f, RaiseFractionOfPot = 0.50f },
                        },
                    };
                var session = new AgentSession(cfg);
                bots[s] = new HeuristicBot(session.ResolveProfile(), seed + s * 101);
                recorders[s] = new AgentHandReplayRecorder();
            }
            else bots[s] = new HeuristicBot(seed + s * 101);
        }
        engine.Events += e =>
        {
            foreach (var rec in recorders.Values) rec.Observe(e);
            if (e is HandStartedEvent)
                foreach (var rec in recorders.Values) rec.SetBlinds(engine.Table.SmallBlind, engine.Table.BigBlind);
        };

        var hands = new JArray();
        for (int h = 0; h < maxHands && engine.CountFundedPlayers() >= 2; h++)
        {
            foreach (var kv in recorders) { kv.Value.Clear(); kv.Value.Begin(kv.Key); }
            engine.StartHand();
            while (engine.HandInProgress)
            {
                int seat = engine.AwaitingActionSeat;
                var p = engine.Table.Seats[seat];
                var ctx = new BotContext
                {
                    SeatIndex = seat, HoleCards = p.HoleCards, Community = engine.Table.Community, Round = engine.Table.Round,
                    Pot = engine.Table.Pot, MyStack = p.Stack, MyCurrentBet = p.CurrentBet, BigBlind = engine.Table.BigBlind,
                    OpponentsInHand = engine.CountInHand() - 1,
                    Position = BotContext.PositionOf(engine.Table.ButtonSeat, seat, engine.Table.SeatCount),
                    Legal = engine.CurrentLegalActions
                };
                engine.SubmitAction(seat, bots[seat].Decide(ctx));
            }
            var hand = new JObject();
            foreach (var kv in recorders)
            {
                var replay = kv.Value.Finish();
                string json = replay?.ToJson();
                var o = new JObject { ["seat"] = kv.Key, ["json"] = json };
                if (replay != null)
                {
                    var frames = new JArray();
                    for (int i = 0; i <= replay.Steps.Count + 1; i++) frames.Add(Frame(AgentHandReplayText.FrameAt(replay, i, Card)));
                    o["frames"] = frames;
                    o["framesPlain"] = Frame(AgentHandReplayText.FrameAt(replay, replay.Steps.Count));
                    o["rounds"] = new JArray(AgentHandReplayText.Rounds(replay, Card).Select(Round));
                    o["summary"] = AgentHandReplayText.Summary(replay);
                    o["summaryFmt"] = AgentHandReplayText.Summary(replay, Card);
                    o["showdown"] = replay.WentToShowdown;
                    o["roundTrip"] = AgentHandReplay.FromJson(json)?.ToJson();
                    o["finishJson"] = kv.Value.FinishJson();
                    o["finishJsonTiny"] = kv.Value.FinishJson(200) ?? "null";
                }
                hand[kv.Key.ToString()] = o;
            }
            hands.Add(hand);
        }
        return hands;
    }

    static JObject Words(float[] v, float[][] streets)
    {
        var o = new JObject
        {
            ["summary"] = AgentStrategyWords.Summary(v, streets),
            ["short"] = AgentStrategyWords.ShortSummary(v, streets),
            ["tags"] = new JArray(Enumerable.Range(0, 5).Select(i => AgentStrategyWords.Tag(i, v))),
            ["explain"] = new JArray(Enumerable.Range(0, 5).Select(i => AgentStrategyWords.Explain(i, v))),
            ["hands"] = R(AgentStrategyWords.HandsPlayed(v)),
            ["raises"] = R(AgentStrategyWords.RaisesBeforeFlop(v)),
            ["pressure"] = R(AgentStrategyWords.Pressure(v)),
            ["swing"] = R(AgentStrategyWords.Swing(AgentStrategyWords.Before(v, streets), AgentStrategyWords.After(v, streets))),
            ["folds"] = R(AgentStrategyWords.FoldsToBets(v[0])),
            ["dialHands"] = R(AgentStrategyWords.DialForHands(v)),
            ["dialPressure"] = R(AgentStrategyWords.DialForPressure(v)),
        };
        return o;
    }

    static JObject ClampOut(AgentDeploymentConfig c) => new JObject
    {
        // A generated id is random: only its shape is compared (12 lowercase hex characters).
        ["DeploymentId"] = _generated ? (c.DeploymentId.Length == 12 && c.DeploymentId.All(ch => "0123456789abcdef".IndexOf(ch) >= 0) ? "GEN" : "BAD") : c.DeploymentId,
        ["AgentName"] = c.AgentName, ["StrategyPreset"] = c.StrategyPreset, ["StrategyVersion"] = c.StrategyVersion,
        ["Bankroll"] = c.Bankroll, ["MinBuyIn"] = c.MinBuyIn, ["MaxHands"] = c.MaxHands, ["MaxRuntimeSeconds"] = c.MaxRuntimeSeconds,
        ["StopLoss"] = c.StopLoss, ["ProfitTarget"] = c.ProfitTarget,
    };
    static bool _generated;

    static string Profile(BotProfile p)
    {
        string Nums(BotProfile x) => $"{R(x.FoldBelow)},{R(x.RaiseAbove)},{R(x.Aggression)},{R(x.BluffChance)},{R(x.RaiseFractionOfPot)}";
        var streets = new List<string>();
        for (int s = 0; s < 4; s++) streets.Add(Nums(p.Effective(s, 0f)));
        return $"{Nums(p)}|{R(p.PositionWeight)}|{p.Brain}|{string.Join("/", streets)}";
    }

    static void Main(string[] args)
    {
        var root = new JObject();

        // ---- AgentDeploymentConfig.Clamp
        var clampIn = new[]
        {
            "{}",
            "{\"DeploymentId\":\"abc\",\"AgentName\":\"  \",\"StrategyPreset\":\"\",\"StrategyVersion\":null,\"Bankroll\":10,\"MinBuyIn\":20,\"MaxHands\":0,\"MaxRuntimeSeconds\":0,\"StopLoss\":-5,\"ProfitTarget\":-1}",
            "{\"DeploymentId\":\"d1\",\"AgentName\":\"Bolt\",\"StrategyPreset\":\"aggressive\",\"StrategyVersion\":\"v1-nomad-daredevil\",\"Bankroll\":250000,\"MinBuyIn\":1000,\"MaxHands\":9000,\"MaxRuntimeSeconds\":100000,\"StopLoss\":2000,\"ProfitTarget\":3000}",
            "{\"DeploymentId\":\"d2\",\"Bankroll\":5000,\"MinBuyIn\":10000,\"MaxHands\":-3,\"MaxRuntimeSeconds\":30}",
            "{\"DeploymentId\":\"d3\",\"Bankroll\":0,\"MinBuyIn\":0,\"MaxHands\":1,\"MaxRuntimeSeconds\":86401}",
        };
        var clamps = new JArray();
        foreach (var s in clampIn)
        {
            var c = JsonConvert.DeserializeObject<AgentDeploymentConfig>(s);
            _generated = string.IsNullOrWhiteSpace(c.DeploymentId);
            clamps.Add(new JObject { ["in"] = s, ["out"] = ClampOut(AgentDeploymentConfig.Clamp(c)) });
        }
        root["clamp"] = clamps;

        // ---- AgentSession.ResolveProfile and the limits
        var profiles = new JArray();
        var profileCfgs = new (string name, AgentDeploymentConfig cfg)[]
        {
            ("preset-balanced", new AgentDeploymentConfig { StrategyPreset = "balanced" }),
            ("preset-tight", new AgentDeploymentConfig { StrategyPreset = "tight" }),
            ("preset-aggressive", new AgentDeploymentConfig { StrategyPreset = "aggressive" }),
            ("preset-unknown", new AgentDeploymentConfig { StrategyPreset = "weird" }),
            ("custom-out-of-range", new AgentDeploymentConfig { Profile = new BotProfileSnapshot { HasCustom = true, FoldBelow = 0.9f, RaiseAbove = 0.1f, Aggression = 2f, BluffChance = -1f, RaiseFractionOfPot = 5f, PositionWeight = 3f, Brain = 1 } }),
            ("custom-streets", new AgentDeploymentConfig { Profile = new BotProfileSnapshot
            {
                HasCustom = true, FoldBelow = 0.35f, RaiseAbove = 0.58f, Aggression = 0.45f, BluffChance = 0.03f, RaiseFractionOfPot = 0.6f, PositionWeight = 0.25f, Brain = 2,
                Streets = new[]
                {
                    new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.05f, RaiseAbove = 0.55f, Aggression = 0.6f, BluffChance = 0.05f, RaiseFractionOfPot = 0.6f },
                    default,
                    new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.5f, RaiseAbove = 0.99f, Aggression = 0.45f, BluffChance = 0.3f, RaiseFractionOfPot = 0.5f },
                    new StreetProfileSnapshot { HasValue = false, FoldBelow = 0.5f, RaiseAbove = 0.7f, Aggression = 0.45f, BluffChance = 0f, RaiseFractionOfPot = 0.5f },
                    new StreetProfileSnapshot { HasValue = true, FoldBelow = 0.2f, RaiseAbove = 0.7f, Aggression = 0.45f, BluffChance = 0f, RaiseFractionOfPot = 0.5f },
                },
            } }),
        };
        foreach (var (name, cfg) in profileCfgs) profiles.Add(new JObject { ["name"] = name, ["profile"] = Profile(new AgentSession(cfg).ResolveProfile()) });
        root["profiles"] = profiles;

        // EvaluateAfterHand: (time, stack) steps -> reason or null.
        var limits = new JArray();
        void Limits(string name, AgentDeploymentConfig cfg, (float t, long stack, bool stop)[] steps)
        {
            Time.realtimeSinceStartup = 100f;
            var s = new AgentSession(cfg);
            var outs = new JArray();
            foreach (var (t, stack, stop) in steps)
            {
                Time.realtimeSinceStartup = 100f + t;
                if (stop) s.RequestOwnerStop();
                outs.Add(s.EvaluateAfterHand(stack) ?? "null");
            }
            var sum = s.Stop(null, steps.Length > 0 ? steps[^1].stack : 0, "TABLE1");
            limits.Add(new JObject
            {
                ["name"] = name, ["reasons"] = outs,
                ["summary"] = $"{sum.StopReason}|{sum.HandsPlayed}|{sum.StartingBankroll}|{sum.EndingStack}|{sum.NetPnl}|{R(sum.RuntimeSeconds)}|{sum.SessionName}",
            });
        }
        Limits("hands", new AgentDeploymentConfig { Bankroll = 5000, MaxHands = 3 }, new[] { (1f, 5100L, false), (2f, 5200L, false), (3f, 4900L, false), (4f, 4800L, false) });
        Limits("stoploss", new AgentDeploymentConfig { Bankroll = 5000, StopLoss = 1000 }, new[] { (1f, 4500L, false), (2f, 4001L, false), (3f, 4000L, false) });
        Limits("profit", new AgentDeploymentConfig { Bankroll = 5000, ProfitTarget = 500 }, new[] { (1f, 5300L, false), (2f, 5500L, false) });
        Limits("bust", new AgentDeploymentConfig { Bankroll = 5000 }, new[] { (1f, 0L, false) });
        Limits("runtime", new AgentDeploymentConfig { Bankroll = 5000, MaxRuntimeSeconds = 60 }, new[] { (30f, 5000L, false), (59.5f, 5000L, false), (60f, 5000L, false) });
        Limits("owner", new AgentDeploymentConfig { Bankroll = 5000, MaxHands = 1, StopLoss = 1 }, new[] { (1f, 0L, true) });
        root["limits"] = limits;

        // ---- Replays from full seeded hands
        root["scenarios"] = new JObject
        {
            ["six"] = Scenario(4242, new[]
            {
                new Seat { Name = "Bot 0", Stack = 5000 }, new Seat { Name = "Bot 1", Stack = 5000 },
                new Seat { Name = "Silver", Stack = 5000, Agent = true, Preset = "aggressive" },
                new Seat { Name = "Bot 3", Stack = 5000 },
                new Seat { Name = "Rival Agent", Stack = 5000, Agent = true, Custom = true },
                new Seat { Name = "Bot 5", Stack = 5000 },
            }, 16, 25, 50),
            ["short"] = Scenario(77, new[]
            {
                new Seat { Name = "My Agent", Stack = 300, Agent = true, Custom = true }, new Seat { Name = "CerealKiller", Stack = 1200 },
                new Seat { Name = "PotatoAim", Stack = 150 }, new Seat { Name = "Jake_2004", Stack = 900 }, null,
                new Seat { Name = "", Stack = 2500 },
            }, 30, 10, 20),
            ["headsup"] = Scenario(5, new[]
            {
                new Seat { Name = "nova", Stack = 2000 }, new Seat { Name = "Bolt", Stack = 2000, Agent = true, Preset = "conservative" },
            }, 12, 25, 50),
        };

        // ---- FromJson edge cases
        var fromJson = new JArray();
        foreach (var s in new[]
        {
            "", "   ", "not json", "{\"v\":0}", "{\"v\":2,\"steps\":[]}", "{}", "{\"v\":1}",
            "{\"v\":1,\"hand\":\"7\",\"seats\":[null,{\"seat\":2,\"name\":\"A\",\"stack\":\"100\",\"agent\":true}],\"steps\":[null,{\"t\":\"act\",\"seat\":2,\"a\":\"Call\",\"amt\":50,\"pot\":null}]}",
            "{\"v\":1,\"hand\":12,\"sb\":25,\"bb\":50,\"button\":3,\"agentSeat\":1,\"agentCards\":[\"As\",\"Kh\"],\"extra\":5,\"seats\":[],\"steps\":[{\"t\":\"street\",\"street\":\"Preflop\",\"board\":[]}]}",
            "{\"v\":1,\"hand\":1.5}", "{\"v\":1,\"seats\":{}}", "[1,2]", "{\"v\":1,\"hand\":null,\"seats\":null,\"steps\":null}",
            "{\"v\":true}", "{\"v\":\"1\",\"seats\":[{\"seat\":1,\"name\":\"q\\\"\\\\\\u2028\\n\"}]}",
        })
        {
            string res;
            try { res = AgentHandReplay.FromJson(s)?.ToJson() ?? "null"; } catch (Exception e) { res = "THROW " + e.GetType().Name; }
            fromJson.Add(new JObject { ["in"] = s, ["out"] = res });
        }
        root["fromJson"] = fromJson;

        // ---- AgentStrategyWords
        var sets = new List<float[]>
        {
            new[] { 0.35f, 0.58f, 0.45f, 0.03f, 0.60f }, new[] { 0.40f, 0.60f, 0.25f, 0.02f, 0.45f },
            new[] { 0.30f, 0.52f, 0.15f, 0.00f, 0.60f }, new[] { 0.22f, 0.52f, 0.75f, 0.08f, 0.90f },
            new[] { 0.10f, 0.45f, 0.10f, 0.00f, 0.30f }, new[] { 0.55f, 0.90f, 0.95f, 0.25f, 1.20f },
            new[] { 0.00f, 0.30f, 0.00f, 0.004f, 0.10f }, new[] { 0.9f, 0.99f, 1.0f, 0.5f, 2.0f },
        };
        var rnd = new System.Random(9);
        for (int i = 0; i < 40; i++)
        {
            var v = new float[5];
            for (int k = 0; k < 5; k++) v[k] = (float)Math.Round(AgentStrategyWords.Min[k] + rnd.NextDouble() * (AgentStrategyWords.Max[k] - AgentStrategyWords.Min[k]), 2);
            sets.Add(v);
        }
        var words = new JArray();
        foreach (var v in sets) words.Add(new JObject { ["v"] = new JArray(v.Select(x => R(x))), ["out"] = Words(v, null) });
        var autoStreets = new[] { new[] { 0.10f, 0.55f, 0.60f, 0.05f, 0.60f }, new[] { 0.50f, 0.70f, 0.45f, 0.00f, 0.50f }, new[] { 0.50f, 0.70f, 0.45f, 0.00f, 0.50f }, new[] { 0.50f, 0.70f, 0.45f, 0.00f, 0.50f } };
        var streetCases = new JArray
        {
            new JObject { ["streets"] = "auto", ["out"] = Words(sets[0], autoStreets) },
            new JObject { ["streets"] = "pre-only", ["out"] = Words(sets[3], new[] { autoStreets[0], null, null, null }) },
            new JObject { ["streets"] = "river-only", ["out"] = Words(sets[1], new[] { null, null, null, autoStreets[1] }) },
        };
        var dials = new JArray();
        for (int i = 0; i <= 20; i++)
        {
            float d = i / 20f;
            dials.Add(string.Join(",", R(AgentStrategyWords.RaiseForDial(d)), R(AgentStrategyWords.FoldForDial(d)), R(AgentStrategyWords.AggrForDial(d)),
                R(AgentStrategyWords.SizeForDial(d)), R(AgentStrategyWords.BluffForDial(d)), AgentStrategyWords.PressureWord(d),
                AgentStrategyWords.OneIn(d), AgentStrategyWords.OneIn(d * 0.5f, "pot")));
        }
        root["words"] = new JObject { ["sets"] = words, ["streets"] = streetCases, ["dials"] = dials };

        File.WriteAllText(args[0], root.ToString(Formatting.Indented));
        Console.WriteLine("ok");
    }
}
