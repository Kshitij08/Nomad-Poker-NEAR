use super::*;
use near_sdk::json_types::U64;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const CHIP: u128 = DEFAULT_CHIP_YOCTO;
const T0: u64 = 1_000_000_000;
const OP: &str = "server.near";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn call(who: &str, deposit: u128, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct("escrow.near"))
        .predecessor_account_id(acct(who))
        .signer_account_id(acct(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts)
        .build());
}

fn setup() -> Escrow {
    call("owner.near", 0, T0);
    Escrow::new(acct(OP))
}

/// Blinds 1/2, buy-in 40 to 200 chips, 6 seats.
fn cfg() -> TableConfig {
    TableConfig { small_blind: 1, big_blind: 2, min_buy_in: 40, max_buy_in: 200, seats: 6 }
}

fn deposit(e: &mut Escrow, who: &str, amount: u128) {
    call(who, amount, T0);
    e.deposit();
}

fn bal(e: &Escrow, who: &str) -> u128 {
    e.get_balance(acct(who)).0
}

fn house_table(e: &mut Escrow, id: &str) {
    call(OP, 0, T0);
    e.open_table(id.into(), cfg());
}

fn buy(e: &mut Escrow, who: &str, table: &str, chips: u128) -> u128 {
    call(who, 0, T0);
    e.buy_in(table.into(), Some(U128(chips * CHIP))).0
}

fn pay(e: &mut Escrow, table: &str, who: &str, amount: u128, key: &str) -> bool {
    call(OP, 0, T0);
    e.cash_out(table.into(), acct(who), U128(amount), key.into())
}

/// Sums every place money can be, using only views, and checks it equals what came in minus what went out.
fn audit(e: &Escrow, accounts: &[&str], tables: &[&str], tournaments: &[&str], deposited: u128, withdrawn: u128) {
    let balances: u128 = accounts.iter().map(|a| bal(e, a)).sum();
    let at_tables: u128 = tables.iter().map(|t| e.get_table(t.to_string()).map(|v| v.outstanding.0).unwrap_or(0)).sum();
    let in_tournaments: u128 = tournaments.iter().map(|t| e.get_tournament(t.to_string()).map(|v| v.held.0).unwrap_or(0)).sum();
    let earnings = e.get_platform_earnings().0;
    assert_eq!(balances + at_tables + in_tournaments + earnings, deposited - withdrawn, "money is not conserved");
    let t = e.get_totals();
    assert_eq!((t.deposited.0, t.withdrawn.0), (deposited, withdrawn));
    assert_eq!((t.balances.0, t.at_tables.0, t.in_tournaments.0, t.platform_earnings.0), (balances, at_tables, in_tournaments, earnings));
    for id in tables {
        if let Some(v) = e.get_table(id.to_string()) {
            assert!(v.paid.0 + v.remainder.0 <= v.locked.0, "table {id} paid out more than it locked");
            assert_eq!(v.bought_in.0, v.locked.0 + v.rake.0);
        }
    }
}

// ------------------------------------------------------------------------------------------------ game balance

#[test]
fn deposit_and_withdraw_idle_funds() {
    let mut e = setup();
    deposit(&mut e, "alice.near", NEAR);
    assert_eq!(bal(&e, "alice.near"), NEAR);
    call("alice.near", 0, T0);
    e.withdraw(U128(NEAR / 4));
    assert_eq!(bal(&e, "alice.near"), NEAR * 3 / 4);
    audit(&e, &["alice.near"], &[], &[], NEAR, NEAR / 4);
    let logs = get_logs();
    assert!(logs[0].starts_with("EVENT_JSON:{"), "{logs:?}");
    assert!(logs[0].contains("\"standard\":\"nomad-escrow\"") && logs[0].contains("\"event\":\"withdrawn\""));
}

#[test]
#[should_panic(expected = "not enough idle game balance")]
fn withdrawing_locked_funds_is_refused() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100); // 0.1 NEAR now at the table
    call("alice.near", 0, T0);
    e.withdraw(U128(NEAR));
}

#[test]
fn a_failed_withdrawal_is_put_back() {
    let mut e = setup();
    deposit(&mut e, "alice.near", NEAR);
    call("alice.near", 0, T0);
    e.withdraw(U128(NEAR));
    assert_eq!(bal(&e, "alice.near"), 0);
    call("escrow.near", 0, T0);
    assert!(!e.on_payout(acct("alice.near"), U128(NEAR), false, Err(PromiseError::Failed)));
    assert_eq!(bal(&e, "alice.near"), NEAR);
    audit(&e, &["alice.near"], &[], &[], NEAR, 0);
    assert!(e.on_payout(acct("alice.near"), U128(NEAR), false, Ok(())));
}

// ------------------------------------------------------------------------------------------------------ tables

#[test]
fn buy_in_takes_the_rake_and_locks_the_rest() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    let locked = buy(&mut e, "alice.near", "t1", 100);
    assert_eq!(locked, 95 * CHIP);
    assert_eq!(e.get_platform_earnings().0, 5 * CHIP);
    assert_eq!(bal(&e, "alice.near"), NEAR - 100 * CHIP);
    // Top up from an attached deposit alone.
    call("alice.near", 50 * CHIP, T0);
    assert_eq!(e.buy_in("t1".into(), None).0, 95 * CHIP + 475 * CHIP / 10);
    let t = e.get_table("t1".into()).unwrap();
    assert_eq!((t.bought_in.0, t.rake.0, t.seated, t.buy_ins), (150 * CHIP, 75 * CHIP / 10, 1, 2));
    audit(&e, &["alice.near"], &["t1"], &[], NEAR + 50 * CHIP, 0);
}

#[test]
fn rake_follows_the_configured_basis_points() {
    let mut e = setup();
    call("owner.near", 0, T0);
    e.set_fees(Some(250), None);
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    assert_eq!(buy(&mut e, "alice.near", "t1", 200), 195 * CHIP);
}

#[test]
#[should_panic(expected = "fee above 20%")]
fn fees_are_capped() {
    let mut e = setup();
    call("owner.near", 0, T0);
    e.set_fees(None, Some(2_001));
}

#[test]
fn cash_out_pays_winnings_from_the_table_and_retries_are_no_ops() {
    let mut e = setup();
    house_table(&mut e, "t1");
    for p in ["alice.near", "bob.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "t1", 100);
    }
    // Locked 190 chips. Alice won 50 from Bob.
    assert!(pay(&mut e, "t1", "alice.near", 145 * CHIP, "h1-alice"));
    assert!(!pay(&mut e, "t1", "alice.near", 145 * CHIP, "h1-alice"), "a retry is a no-op");
    assert_eq!(bal(&e, "alice.near"), NEAR - 100 * CHIP + 145 * CHIP);
    assert_eq!(e.get_cash_out("t1".into(), "h1-alice".into()).unwrap().amount.0, 145 * CHIP);
    assert!(pay(&mut e, "t1", "bob.near", 45 * CHIP, "h1-bob"));
    let t = e.get_table("t1".into()).unwrap();
    assert_eq!((t.paid.0, t.outstanding.0, t.seated, t.cash_outs), (190 * CHIP, 0, 0, 2));
    audit(&e, &["alice.near", "bob.near"], &["t1"], &[], 2 * NEAR, 0);
}

#[test]
#[should_panic(expected = "this key was used for a different cash-out")]
fn a_key_cannot_be_reused_for_another_amount() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    pay(&mut e, "t1", "alice.near", 50 * CHIP, "k");
    pay(&mut e, "t1", "alice.near", 60 * CHIP, "k");
}

#[test]
#[should_panic(expected = "operator only")]
fn only_the_operator_records_results() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    call("alice.near", 0, T0);
    e.cash_out("t1".into(), acct("alice.near"), U128(95 * CHIP), "k".into());
}

#[test]
#[should_panic(expected = "pays out more than the table took in")]
fn a_table_never_pays_out_more_than_it_locked() {
    let mut e = setup();
    house_table(&mut e, "t1");
    for p in ["alice.near", "bob.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "t1", 100);
    }
    pay(&mut e, "t1", "alice.near", 190 * CHIP + 1, "k");
}

#[test]
#[should_panic(expected = "pays out more than the table took in")]
fn over_payout_is_refused_across_players() {
    let mut e = setup();
    house_table(&mut e, "t1");
    for p in ["alice.near", "bob.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "t1", 100);
    }
    pay(&mut e, "t1", "alice.near", 150 * CHIP, "a");
    pay(&mut e, "t1", "bob.near", 41 * CHIP, "b");
}

#[test]
#[should_panic(expected = "the player is not seated at this table")]
fn a_second_cash_out_with_a_new_key_is_refused() {
    let mut e = setup();
    house_table(&mut e, "t1");
    for p in ["alice.near", "bob.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "t1", 100);
    }
    pay(&mut e, "t1", "alice.near", 50 * CHIP, "a1");
    pay(&mut e, "t1", "alice.near", 50 * CHIP, "a2");
}

#[test]
fn a_player_can_sit_down_again_after_cashing_out() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    pay(&mut e, "t1", "alice.near", 95 * CHIP, "a1");
    assert!(e.get_seat("t1".into(), acct("alice.near")).is_none());
    buy(&mut e, "alice.near", "t1", 100);
    assert!(pay(&mut e, "t1", "alice.near", 95 * CHIP, "a2"));
    audit(&e, &["alice.near"], &["t1"], &[], NEAR, 0);
}

#[test]
fn closing_reports_the_remainder_once_the_table_is_empty() {
    let mut e = setup();
    house_table(&mut e, "t1");
    for p in ["alice.near", "bob.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "t1", 100);
    }
    pay(&mut e, "t1", "alice.near", 120 * CHIP, "a");
    call(OP, 0, T0);
    e.close_table("t1".into());
    let t = e.get_table("t1".into()).unwrap();
    assert!(t.closed && !t.finalized, "Bob is still seated");
    pay(&mut e, "t1", "bob.near", 60 * CHIP, "b");
    let t = e.get_table("t1".into()).unwrap();
    assert!(t.finalized);
    assert_eq!((t.remainder.0, t.outstanding.0), (10 * CHIP, 0));
    assert_eq!(e.get_platform_earnings().0, 10 * CHIP + 10 * CHIP, "rake plus remainder");
    assert!(get_logs().iter().any(|l| l.contains("table_finalized") && l.contains(&(10 * CHIP).to_string())));
    audit(&e, &["alice.near", "bob.near"], &["t1"], &[], 2 * NEAR, 0);
}

#[test]
#[should_panic(expected = "the table is closed")]
fn a_closed_table_takes_no_buy_ins() {
    let mut e = setup();
    house_table(&mut e, "t1");
    call(OP, 0, T0);
    e.close_table("t1".into());
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
}

// ----------------------------------------------------------------------------------------------- hosted tables

fn hosted(e: &mut Escrow, invites: Option<Vec<&str>>) {
    call("host.near", 0, T0);
    e.create_hosted_table("friends".into(), cfg(), invites.map(|v| v.into_iter().map(acct).collect()));
}

#[test]
fn invitees_and_the_host_may_buy_in() {
    let mut e = setup();
    hosted(&mut e, Some(vec!["alice.near"]));
    let t = e.get_table("friends".into()).unwrap();
    assert!(t.invite_only && t.host == Some(acct("host.near")));
    assert!(e.may_join("friends".into(), acct("alice.near")));
    assert!(!e.may_join("friends".into(), acct("mallory.near")));
    for p in ["alice.near", "host.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "friends", 100);
    }
    assert_eq!(e.get_table("friends".into()).unwrap().seated, 2);
    // The host opens it to everyone.
    call("host.near", 0, T0);
    e.set_invites("friends".into(), None);
    deposit(&mut e, "mallory.near", NEAR);
    buy(&mut e, "mallory.near", "friends", 100);
}

#[test]
#[should_panic(expected = "this table is invite-only")]
fn strangers_cannot_buy_in_to_an_invite_only_table() {
    let mut e = setup();
    hosted(&mut e, Some(vec!["alice.near"]));
    deposit(&mut e, "mallory.near", NEAR);
    buy(&mut e, "mallory.near", "friends", 100);
}

#[test]
#[should_panic(expected = "host only")]
fn only_the_host_changes_invites() {
    let mut e = setup();
    hosted(&mut e, Some(vec!["alice.near"]));
    call("alice.near", 0, T0);
    e.set_invites("friends".into(), Some(vec![acct("mallory.near")]));
}

#[test]
#[should_panic(expected = "operator or host only")]
fn only_the_host_or_operator_closes_a_table() {
    let mut e = setup();
    hosted(&mut e, None);
    call("alice.near", 0, T0);
    e.close_table("friends".into());
}

#[test]
fn the_host_closes_and_the_operator_still_cashes_out() {
    let mut e = setup();
    hosted(&mut e, None);
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "friends", 100);
    call("host.near", 0, T0);
    e.close_table("friends".into());
    assert!(pay(&mut e, "friends", "alice.near", 95 * CHIP, "a"));
    let t = e.get_table("friends".into()).unwrap();
    assert!(t.finalized && t.remainder.0 == 0);
}

#[test]
#[should_panic(expected = "below the table's minimum buy-in")]
fn buy_in_below_the_minimum_is_refused() {
    let mut e = setup();
    hosted(&mut e, None);
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "friends", 39);
}

#[test]
#[should_panic(expected = "above the table's maximum buy-in")]
fn top_ups_count_toward_the_maximum() {
    let mut e = setup();
    hosted(&mut e, None);
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "friends", 150);
    buy(&mut e, "alice.near", "friends", 51);
}

#[test]
#[should_panic(expected = "the buy-in must be a whole number of chips")]
fn buy_ins_are_whole_chips() {
    let mut e = setup();
    hosted(&mut e, None);
    deposit(&mut e, "alice.near", NEAR);
    call("alice.near", 0, T0);
    e.buy_in("friends".into(), Some(U128(100 * CHIP + 1)));
}

#[test]
#[should_panic(expected = "the table is full")]
fn a_full_table_takes_no_new_seats() {
    let mut e = setup();
    call("host.near", 0, T0);
    e.create_hosted_table("duel".into(), TableConfig { seats: 2, ..cfg() }, None);
    for p in ["a.near", "b.near", "c.near"] {
        deposit(&mut e, p, NEAR);
        buy(&mut e, p, "duel", 100);
    }
}

#[test]
#[should_panic(expected = "operator only")]
fn only_the_operator_opens_house_tables() {
    let mut e = setup();
    call("alice.near", 0, T0);
    e.open_table("t1".into(), cfg());
}

// ------------------------------------------------------------------------------------------------- tournaments

const START: u64 = T0 + 3_600_000_000_000;

fn tournament(e: &mut Escrow, prize: u128, code_hash: Option<String>) {
    call("host.near", prize, T0);
    e.create_tournament("sunday".into(), "Sunday Major".into(), U128(NEAR), 8, U64(START), code_hash, None);
}

fn register(e: &mut Escrow, who: &str, ts: u64) {
    call(who, NEAR, ts);
    e.register("sunday".into(), None);
}

fn settle(e: &mut Escrow, placings: &[&str]) -> bool {
    call(OP, 0, START);
    e.settle_tournament("sunday".into(), placings.iter().map(|p| acct(p)).collect())
}

#[test]
fn tournament_pays_60_40_after_the_fee_plus_the_host_prize() {
    let mut e = setup();
    tournament(&mut e, 2 * NEAR, None);
    let players = ["a.near", "b.near", "c.near", "d.near"];
    for p in players {
        register(&mut e, p, T0);
    }
    let v = e.get_tournament("sunday".into()).unwrap();
    assert_eq!((v.held.0, v.players.len(), v.started), (6 * NEAR, 4, false));
    assert!(settle(&mut e, &["c.near", "a.near", "d.near", "b.near"]));
    // Entries 4, fee 0.2, pool 3.8 + 2 prize = 5.8: 1st 3.48, 2nd 2.32.
    assert_eq!(bal(&e, "c.near"), 3_480_000_000_000_000_000_000_000);
    assert_eq!(bal(&e, "a.near"), 2_320_000_000_000_000_000_000_000);
    assert_eq!((bal(&e, "b.near"), bal(&e, "d.near")), (0, 0));
    assert_eq!(e.get_platform_earnings().0, NEAR / 5);
    let v = e.get_tournament("sunday".into()).unwrap();
    assert_eq!((v.status, v.held.0, v.fee.0), (TournamentStatus::Settled, 0, NEAR / 5));
    // A retry with the same placings does nothing.
    assert!(!settle(&mut e, &["c.near", "a.near", "d.near", "b.near"]));
    assert_eq!(bal(&e, "c.near"), 3_480_000_000_000_000_000_000_000);
    let mut everyone = players.to_vec();
    everyone.push("host.near");
    audit(&e, &everyone, &[], &["sunday"], 6 * NEAR, 0);
}

#[test]
fn a_lone_player_takes_the_whole_pool() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    assert!(settle(&mut e, &["a.near"]));
    assert_eq!(bal(&e, "a.near"), NEAR * 95 / 100);
}

#[test]
#[should_panic(expected = "already settled with different placings")]
fn settlement_cannot_be_changed() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    register(&mut e, "b.near", T0);
    settle(&mut e, &["a.near", "b.near"]);
    settle(&mut e, &["b.near", "a.near"]);
}

#[test]
#[should_panic(expected = "operator only")]
fn only_the_operator_settles() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    call("host.near", 0, START);
    e.settle_tournament("sunday".into(), vec![acct("a.near")]);
}

#[test]
#[should_panic(expected = "the tournament has not started")]
fn settling_before_the_start_is_refused() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    call(OP, 0, T0);
    e.settle_tournament("sunday".into(), vec![acct("a.near")]);
}

#[test]
#[should_panic(expected = "a placed account is not registered")]
fn placings_must_be_registered_players() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    register(&mut e, "b.near", T0);
    settle(&mut e, &["a.near", "mallory.near"]);
}

#[test]
#[should_panic(expected = "the tournament has started")]
fn registering_after_the_start_is_refused() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", START);
}

#[test]
#[should_panic(expected = "already registered")]
fn registering_twice_is_refused() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    register(&mut e, "a.near", T0);
}

#[test]
fn leaving_and_cancelling_refund_to_game_balances() {
    let mut e = setup();
    tournament(&mut e, 2 * NEAR, None);
    register(&mut e, "a.near", T0);
    register(&mut e, "b.near", T0);
    call("a.near", 0, T0);
    e.leave("sunday".into());
    assert_eq!(bal(&e, "a.near"), NEAR);
    assert!(!e.is_registered("sunday".into(), acct("a.near")));
    call("host.near", 0, T0);
    e.cancel_tournament("sunday".into());
    assert_eq!((bal(&e, "b.near"), bal(&e, "host.near")), (NEAR, 2 * NEAR));
    assert_eq!(e.get_tournament("sunday".into()).unwrap().status, TournamentStatus::Cancelled);
    audit(&e, &["a.near", "b.near", "host.near"], &[], &["sunday"], 4 * NEAR, 0);
}

#[test]
#[should_panic(expected = "the tournament has started")]
fn leaving_after_the_start_is_refused() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    register(&mut e, "a.near", T0);
    call("a.near", 0, START);
    e.leave("sunday".into());
}

#[test]
#[should_panic(expected = "only the operator can cancel it now")]
fn the_host_cannot_cancel_after_the_start() {
    let mut e = setup();
    tournament(&mut e, 0, None);
    call("host.near", 0, START);
    e.cancel_tournament("sunday".into());
}

#[test]
fn the_operator_can_cancel_a_started_tournament() {
    let mut e = setup();
    tournament(&mut e, NEAR, None);
    register(&mut e, "a.near", T0);
    call(OP, 0, START);
    e.cancel_tournament("sunday".into());
    assert_eq!((bal(&e, "a.near"), bal(&e, "host.near")), (NEAR, NEAR));
}

#[test]
fn private_tournaments_need_the_code() {
    let mut e = setup();
    tournament(&mut e, 0, Some(hex::encode(env::sha256(b"open sesame"))));
    assert!(e.get_tournament("sunday".into()).unwrap().private);
    call("a.near", NEAR, T0);
    e.register("sunday".into(), Some("open sesame".into()));
    assert!(e.is_registered("sunday".into(), acct("a.near")));
}

#[test]
#[should_panic(expected = "wrong or missing code")]
fn a_wrong_code_is_refused() {
    let mut e = setup();
    tournament(&mut e, 0, Some(hex::encode(env::sha256(b"open sesame"))));
    call("a.near", NEAR, T0);
    e.register("sunday".into(), Some("guess".into()));
}

#[test]
#[should_panic(expected = "the tournament is full")]
fn a_full_tournament_is_refused() {
    let mut e = setup();
    call("host.near", 0, T0);
    e.create_tournament("sunday".into(), "HU".into(), U128(NEAR), 2, U64(START), None, None);
    for p in ["a.near", "b.near", "c.near"] {
        register(&mut e, p, T0);
    }
}

// ------------------------------------------------------------------------------------------------- earnings

#[test]
fn the_owner_claims_platform_earnings() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    call("owner.near", 0, T0);
    e.claim_platform_earnings(None);
    assert_eq!(e.get_platform_earnings().0, 0);
    audit(&e, &["alice.near"], &["t1"], &[], NEAR, 5 * CHIP);
    // A failed transfer puts it back.
    call("escrow.near", 0, T0);
    e.on_payout(acct("owner.near"), U128(5 * CHIP), true, Err(PromiseError::Failed));
    assert_eq!(e.get_platform_earnings().0, 5 * CHIP);
    audit(&e, &["alice.near"], &["t1"], &[], NEAR, 0);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_claims_platform_earnings() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    call(OP, 0, T0);
    e.claim_platform_earnings(None);
}

// ----------------------------------------------------------------------------------------------------- reclaim

const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;

fn reclaim(e: &mut Escrow, who: &str, table: &str, ts: u64) -> u128 {
    call(who, 0, ts);
    e.reclaim(table.into()).0
}

#[test]
fn a_player_reclaims_after_the_operator_is_idle_for_a_day() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    let t = e.get_table("t1".into()).unwrap();
    assert_eq!((t.last_operator_at.0, t.reclaimable_at.0), (T0, T0 + DAY));
    assert_eq!(reclaim(&mut e, "alice.near", "t1", T0 + DAY), 95 * CHIP);
    assert!(get_logs()[0].contains("\"event\":\"reclaimed\""));
    assert_eq!(bal(&e, "alice.near"), NEAR - 5 * CHIP);
    assert!(e.get_seat("t1".into(), acct("alice.near")).is_none());
    let t = e.get_table("t1".into()).unwrap();
    assert_eq!((t.seated, t.reclaims, t.cash_outs, t.paid.0), (0, 1, 0, 95 * CHIP));
    audit(&e, &["alice.near"], &["t1"], &[], NEAR, 0);
}

#[test]
#[should_panic(expected = "the operator is still active at this table")]
fn reclaiming_before_the_operator_is_idle_long_enough_is_refused() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    reclaim(&mut e, "alice.near", "t1", T0 + DAY - 1);
}

#[test]
#[should_panic(expected = "the operator is still active at this table")]
fn a_cash_out_restarts_the_clock() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    deposit(&mut e, "bob.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    buy(&mut e, "bob.near", "t1", 100);
    call(OP, 0, T0 + DAY / 2);
    e.cash_out("t1".into(), acct("bob.near"), U128(10 * CHIP), "k1".into());
    assert_eq!(e.get_table("t1".into()).unwrap().last_operator_at.0, T0 + DAY / 2);
    reclaim(&mut e, "alice.near", "t1", T0 + DAY);
}

#[test]
#[should_panic(expected = "you are not seated at this table")]
fn only_seated_players_reclaim() {
    let mut e = setup();
    house_table(&mut e, "t1");
    reclaim(&mut e, "bob.near", "t1", T0 + DAY);
}

#[test]
fn reclaim_is_capped_by_what_the_table_can_still_pay() {
    let mut e = setup();
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    deposit(&mut e, "bob.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    buy(&mut e, "bob.near", "t1", 100);
    // Bob won 150 of Alice's 95: only 40 are left at the table.
    pay(&mut e, "t1", "bob.near", 150 * CHIP, "k1");
    assert_eq!(reclaim(&mut e, "alice.near", "t1", T0 + DAY), 40 * CHIP);
    let t = e.get_table("t1".into()).unwrap();
    assert_eq!((t.paid.0, t.locked.0, t.outstanding.0), (190 * CHIP, 190 * CHIP, 0));
    audit(&e, &["alice.near", "bob.near"], &["t1"], &[], 2 * NEAR, 0);
}

#[test]
fn the_last_reclaim_from_a_closed_table_finalises_it() {
    let mut e = setup();
    call("host.near", 0, T0);
    e.create_hosted_table("friends".into(), cfg(), None);
    deposit(&mut e, "alice.near", NEAR);
    deposit(&mut e, "bob.near", NEAR);
    buy(&mut e, "alice.near", "friends", 100);
    buy(&mut e, "bob.near", "friends", 100);
    // A host closing is not operator activity.
    call("host.near", 0, T0 + DAY / 2);
    e.close_table("friends".into());
    assert_eq!(e.get_table("friends".into()).unwrap().last_operator_at.0, T0);
    reclaim(&mut e, "alice.near", "friends", T0 + DAY);
    assert!(!e.get_table("friends".into()).unwrap().finalized);
    reclaim(&mut e, "bob.near", "friends", T0 + DAY);
    let t = e.get_table("friends".into()).unwrap();
    assert!(t.finalized && t.outstanding.0 == 0 && t.remainder.0 == 0);
    audit(&e, &["alice.near", "bob.near"], &["friends"], &[], 2 * NEAR, 0);
}

#[test]
fn the_owner_sets_the_reclaim_window() {
    let mut e = setup();
    assert_eq!(e.get_config().reclaim_after_secs, 24 * 60 * 60);
    call("owner.near", 0, T0);
    e.set_reclaim_after(3600);
    assert_eq!(e.get_config().reclaim_after_secs, 3600);
    house_table(&mut e, "t1");
    deposit(&mut e, "alice.near", NEAR);
    buy(&mut e, "alice.near", "t1", 100);
    assert_eq!(reclaim(&mut e, "alice.near", "t1", T0 + 3600 * 1_000_000_000), 95 * CHIP);
}

#[test]
#[should_panic(expected = "at least 1 hour")]
fn the_reclaim_window_is_at_least_an_hour() {
    let mut e = setup();
    call("owner.near", 0, T0);
    e.set_reclaim_after(3599);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_the_reclaim_window() {
    let mut e = setup();
    call(OP, 0, T0);
    e.set_reclaim_after(7200);
}

// ------------------------------------------------------------------------------------------ money conservation

/// A small deterministic generator, so the run is the same every time.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn money_is_conserved_through_random_play() {
    let players = ["p0.near", "p1.near", "p2.near", "p3.near", "p4.near", "p5.near"];
    let mut accounts = players.to_vec();
    accounts.extend(["host.near", "owner.near"]);
    let tables = ["house", "friends"];
    // Open tournaments; settled and cancelled ones hold nothing, so the audit can skip them.
    let mut tournaments: Vec<String> = vec![];
    let mut settled: Vec<(String, Vec<AccountId>)> = vec![];
    let mut e = setup();
    call(OP, 0, T0);
    e.open_table("house".into(), cfg());
    call("p0.near", 0, T0);
    e.create_hosted_table("friends".into(), TableConfig { seats: 4, ..cfg() }, Some(players[..4].iter().map(|p| acct(p)).collect()));

    let mut rng = Rng(7);
    let (mut deposited, mut withdrawn) = (0u128, 0u128);
    let mut now = T0;
    let mut keys: Vec<(String, String, u128)> = vec![];
    let mut ops = [0u32; 10];
    let mut reclaims = 0u32;

    for step in 0..1_500 {
        now += 1_000_000_000;
        let p = players[rng.below(players.len() as u64) as usize];
        let op = rng.below(10);
        match op {
            0 => {
                let amount = (rng.below(500) as u128 + 1) * CHIP;
                call(p, amount, now);
                e.deposit();
                deposited += amount;
            }
            1 => {
                let b = bal(&e, p);
                if b == 0 {
                    continue;
                }
                let amount = b * (rng.below(100) as u128 + 1) / 100;
                call(p, 0, now);
                e.withdraw(U128(amount));
                withdrawn += amount;
            }
            2 | 3 => {
                let table = tables[rng.below(2) as usize];
                if !e.may_join(table.into(), acct(p)) {
                    continue;
                }
                let t = e.get_table(table.into()).unwrap();
                let seat = e.get_seat(table.into(), acct(p)).map(|s| s.bought_in.0 / CHIP).unwrap_or(0);
                if seat == 0 && t.seated >= t.config.seats as u32 {
                    continue;
                }
                let min = if seat == 0 { t.config.min_buy_in as u128 } else { 1 };
                let max = t.config.max_buy_in as u128 - seat;
                if max < min {
                    continue;
                }
                let chips = min + rng.below((max - min + 1) as u64) as u128;
                // Pay part from a fresh deposit, part from the balance.
                let attach = (rng.below(chips as u64 + 1) as u128) * CHIP;
                if bal(&e, p) + attach < chips * CHIP {
                    continue;
                }
                call(p, attach, now);
                e.buy_in(table.into(), Some(U128(chips * CHIP)));
                deposited += attach;
            }
            4 | 5 => {
                let table = tables[rng.below(2) as usize];
                if e.get_seat(table.into(), acct(p)).is_none() {
                    continue;
                }
                let t = e.get_table(table.into()).unwrap();
                if rng.below(10) == 0 {
                    // The operator goes quiet for a day and the player takes their seat back.
                    now += DAY;
                    let seat = e.get_seat(table.into(), acct(p)).unwrap().locked.0;
                    call(p, 0, now);
                    assert_eq!(e.reclaim(table.into()).0, seat.min(t.outstanding.0));
                    reclaims += 1;
                    continue;
                }
                // Skew toward paying most of what is left, so the table limit is hit regularly.
                let amount = t.outstanding.0 * rng.below(101) as u128 / 100;
                let key = format!("k{step}");
                call(OP, 0, now);
                assert!(e.cash_out(table.into(), acct(p), U128(amount), key.clone()));
                keys.push((table.into(), key, amount));
                assert!(e.get_table(table.into()).unwrap().paid.0 <= t.locked.0);
            }
            6 => {
                // Retry an old cash-out: nothing may change.
                if keys.is_empty() {
                    continue;
                }
                let (table, key, amount) = keys[rng.below(keys.len() as u64) as usize].clone();
                let player = e.get_cash_out(table.clone(), key.clone()).unwrap().player;
                let before = e.get_totals();
                call(OP, 0, now);
                assert!(!e.cash_out(table, player, U128(amount), key));
                assert_eq!(e.get_totals(), before);
            }
            7 => {
                let id = format!("t{step}");
                let prize = rng.below(3) as u128 * NEAR / 10;
                call("host.near", prize, now);
                e.create_tournament(id.clone(), "Random".into(), U128(rng.below(50) as u128 * CHIP), 5, U64(now + 20_000_000_000), None, None);
                deposited += prize;
                tournaments.push(id);
            }
            8 => {
                let Some(id) = tournaments.last().cloned() else { continue };
                call(p, 0, now); // views read the clock too
                let t = e.get_tournament(id.clone()).unwrap();
                if t.status != TournamentStatus::Open || t.started || t.players.len() >= 5 {
                    continue;
                }
                if t.players.contains(&acct(p)) {
                    call(p, 0, now);
                    e.leave(id);
                } else {
                    call(p, t.entry_fee.0, now);
                    e.register(id, None);
                    deposited += t.entry_fee.0;
                }
            }
            _ => {
                // Settle or cancel every started tournament, and retry an earlier settlement.
                let mut still_open = vec![];
                for id in std::mem::take(&mut tournaments) {
                    call(OP, 0, now);
                    let t = e.get_tournament(id.clone()).unwrap();
                    if !t.started {
                        still_open.push(id);
                        continue;
                    }
                    if rng.below(4) == 0 {
                        e.cancel_tournament(id.clone());
                    } else {
                        let mut placings = t.players.clone();
                        let shift = rng.below(placings.len().max(1) as u64) as usize;
                        placings.rotate_left(shift);
                        assert!(e.settle_tournament(id.clone(), placings.clone()));
                        settled.push((id, placings));
                    }
                }
                tournaments = still_open;
                if let Some((id, placings)) = settled.last().cloned() {
                    let before = e.get_totals();
                    call(OP, 0, now);
                    assert!(!e.settle_tournament(id, placings));
                    assert_eq!(e.get_totals(), before);
                }
                if rng.below(3) == 0 && e.get_platform_earnings().0 > 0 {
                    let amount = e.get_platform_earnings().0;
                    call("owner.near", 0, now);
                    e.claim_platform_earnings(None);
                    withdrawn += amount;
                }
            }
        }
        ops[op as usize] += 1;
        let ids: Vec<&str> = tournaments.iter().map(|s| s.as_str()).collect();
        audit(&e, &accounts, &tables, &ids, deposited, withdrawn);
    }

    // Close both tables, cash everyone out at their locked amount where the table can still pay, and check the books.
    call(OP, 0, now);
    e.close_table("house".into());
    call("p0.near", 0, now);
    e.close_table("friends".into());
    for table in tables {
        for p in players {
            if e.get_seat(table.into(), acct(p)).is_some() {
                let left = e.get_table(table.into()).unwrap().outstanding.0;
                call(OP, 0, now);
                e.cash_out(table.into(), acct(p), U128(left / 2), format!("final-{p}"));
            }
        }
        let t = e.get_table(table.into()).unwrap();
        assert!(t.finalized && t.outstanding.0 == 0 && t.paid.0 + t.remainder.0 == t.locked.0);
    }
    let ids: Vec<&str> = tournaments.iter().map(|s| s.as_str()).collect();
    audit(&e, &accounts, &tables, &ids, deposited, withdrawn);
    assert!(ops.iter().all(|n| *n > 20), "every kind of step ran: {ops:?}");
    assert!(reclaims > 5, "reclaims ran: {reclaims}");
}
