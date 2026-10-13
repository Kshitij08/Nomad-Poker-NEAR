//! M12: Agents on SOL tables. An Agent is a bot that plays private cash tables for a player, staking from
//! their game balance. The Agent runner (a backend service) holds an **Agent key**, which the player's play
//! key sets on the player's Agent record. What that key can do is limited here, not in the runner:
//! - buy in to a cash table from the player's game balance, as the player's own seat (so its seats look like
//!   anyone's), one seat at a time, with at most `stake` committed (bought in, minus what it cashed out);
//! - cash its own seat out, only into the player's game balance;
//! - nothing else: it can't withdraw, can't touch the player's own seats, and stops when the record
//!   expires, when the player stops it or replaces the key, or when the player cancels their play keys
//!   (the record remembers the key set it was made under).
//! It plays its seat with the seat's table key (reader), as every player does.
//!
//! The record (one per wallet) lives only in the rollup and is private: only the Agent key and the play key
//! that set it can read it, so nobody can look up a wallet's stake or which seat its Agent holds. Its tiny
//! rent (32 lamports a byte) comes from the program's Agent sponsor account, set up once by the admin.
//!
//! Agents v2 (docs/AGENTS_V2.md §5): an Agent can play a strategy copied from the marketplace. The play key sets
//! the fee terms with the Agent (the copier's consent): the strategy's creator, their share and Nomad's share of
//! new profit. Each cash-out of the Agent's seat adds to the record's lifetime buy-ins and cash-outs; when their
//! difference rises above the highest it has been (the high-water mark), the shares of that new profit go to the
//! creator's and Nomad's (config.dev_wallet's) game balances, never on losses. The record moved to new seeds
//! (["agent2", wallet]) for the bigger layout; records under the old seeds are left alone.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::cpi_delegate;
use ephemeral_rollups_sdk::types::DelegateAccountArgs;
use ephemeral_rollups_sdk::utils::{close_pda_with_system_transfer, create_pda};
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, TEE_VALIDATOR};
use crate::errors::PokerError;
use crate::instructions::money::*;
use crate::instructions::money::{buy_in_flow, cash_out_flow};
use crate::instructions::table::DELEGATION_PROGRAM_ID;
use crate::instructions::vault::{vault_address, vault_gen_seed, verify_play_key, wallet_state_of, VAULT_SEED, WALLET_SEED};
use crate::private::{write, Sponsor};
use crate::state::{Config, MAX_CREATOR_FEE_BPS, MAX_PLATFORM_FEE_BPS};
use crate::table::{invite_admits, rake_for, Hand, Ledger, Seat, Table, HAND_IDLE, HAND_SEED, LEDGER_SEED, STATUS_OPEN, TABLE_SEED, WSOL_MINT};

pub const AGENT_SEED: &[u8] = b"agent2";
pub const AGENT_SPONSOR_SEED: &[u8] = b"agent-sponsor";
/// An Agent key's record lasts at most this long; the player sets it again (no wallet prompt) to go on.
pub const MAX_AGENT_SECS: i64 = 7 * 24 * 60 * 60;
const DELEGATE_BUFFER_TAG: &[u8] = b"buffer";

/// The player's Agent: who may play for them, until when, and how much it may have at risk.
#[account]
#[derive(InitSpace)]
pub struct AgentState {
    pub wallet: Pubkey,
    /// The runner's key; default = no Agent (stopped).
    pub agent: Pubkey,
    pub expires: i64,
    /// The wallet's play-key set when this was set: cancelling play keys stops the Agent too.
    pub key_set: u32,
    /// Most it may have committed at once (buy-ins minus its own cash-outs), in lamports of wSOL.
    pub stake: u64,
    pub committed: u64,
    /// Its seat, while it has one (table default = none).
    pub table: Pubkey,
    pub seat: u8,
    pub reader: Pubkey,
    pub bump: u8,
    /// v2, copy strategies: the strategy's creator (default = the player's own strategy, no fee) and the shares
    /// of new profit the player agreed to, in basis points.
    pub strategy_creator: Pubkey,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
    /// Bought in at the current seat; counted into `net_in` when the Agent cashes that seat out.
    pub seat_in: u64,
    /// Lifetime (under these terms) buy-ins and cash-outs of the seats the Agent cashed out itself.
    pub net_in: u64,
    pub net_out: u64,
    /// The highest `net_out - net_in` fees were charged up to.
    pub high_water: i64,
    /// Seats left another way while copying (the player cashed them out): their result isn't counted.
    pub skipped: u32,
    pub reserved: [u8; 16],
}

/// What the player agrees to pay a copied strategy: shares of new profit (above the high-water mark).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeTerms {
    /// Default = the player's own strategy (both shares 0).
    pub creator: Pubkey,
    pub creator_fee_bps: u16,
    /// Must be the config's current share (the player sees it before signing).
    pub platform_fee_bps: u16,
}

/// Terms a player may set: none, or a creator other than themselves with a share within the cap and Nomad's at
/// the config's rate.
pub fn check_terms(t: &FeeTerms, wallet: &Pubkey, platform_bps: u16) -> Result<()> {
    if t.creator == Pubkey::default() {
        require!(t.creator_fee_bps == 0 && t.platform_fee_bps == 0, PokerError::BadFeeTerms);
    } else {
        require!(t.creator != *wallet, PokerError::BadFeeTerms);
        require!(t.creator_fee_bps <= MAX_CREATOR_FEE_BPS, PokerError::BadFeeTerms);
        require!(t.platform_fee_bps == platform_bps && platform_bps <= MAX_PLATFORM_FEE_BPS, PokerError::BadFeeTerms);
    }
    Ok(())
}

/// The fees of one cash-out (lamports of wSOL), and the profit they were charged on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    pub base: u64,
    pub creator: u64,
    pub platform: u64,
}

impl AgentState {
    pub fn terms(&self) -> FeeTerms {
        FeeTerms { creator: self.strategy_creator, creator_fee_bps: self.creator_fee_bps, platform_fee_bps: self.platform_fee_bps }
    }

    /// New terms start the counts afresh (the high-water mark is per player and strategy).
    pub fn set_terms(&mut self, t: &FeeTerms) {
        if self.terms() != *t {
            self.strategy_creator = t.creator;
            self.creator_fee_bps = t.creator_fee_bps;
            self.platform_fee_bps = t.platform_fee_bps;
            self.net_in = 0;
            self.net_out = 0;
            self.high_water = 0;
            self.skipped = 0;
        }
    }

    /// The Agent cashed its seat out with `stack`: counts the seat and returns the fees due on profit above the
    /// high-water mark. They never exceed the stack (new profit is at most this seat's profit).
    pub fn settle(&mut self, stack: u64) -> Result<FeeSplit> {
        self.net_in = self.net_in.checked_add(self.seat_in).ok_or(PokerError::MathOverflow)?;
        self.net_out = self.net_out.checked_add(stack).ok_or(PokerError::MathOverflow)?;
        self.seat_in = 0;
        if self.strategy_creator == Pubkey::default() {
            return Ok(FeeSplit::default());
        }
        let pnl = self.net_out as i128 - self.net_in as i128;
        if pnl <= self.high_water as i128 {
            return Ok(FeeSplit::default());
        }
        let base = pnl - self.high_water as i128;
        self.high_water = i64::try_from(pnl).map_err(|_| error!(PokerError::MathOverflow))?;
        let base = u64::try_from(base).map_err(|_| error!(PokerError::MathOverflow))?.min(stack);
        let share = |bps: u16| ((base as u128 * bps as u128) / 10_000) as u64;
        let (creator, platform) = (share(self.creator_fee_bps), share(self.platform_fee_bps));
        require!(creator.saturating_add(platform) <= stack, PokerError::MathOverflow);
        Ok(FeeSplit { base, creator, platform })
    }
}

/// Holds lamports in the rollup to pay Agent records' rent. Program-owned, delegated to the TEE.
#[account]
#[derive(InitSpace)]
pub struct AgentSponsor {
    pub bump: u8,
}

fn agent_seeds_of(wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AGENT_SEED, wallet.as_ref()], &crate::ID)
}

fn load_agent(info: &AccountInfo) -> Result<AgentState> {
    require!(!info.data_is_empty(), PokerError::NotAgent);
    require_keys_eq!(*info.owner, crate::ID, PokerError::NotAgent);
    let data = info.try_borrow_data()?;
    AgentState::try_deserialize(&mut &data[..]).map_err(|_| error!(PokerError::NotAgent))
}

/// The Agent key may act: it's this record's key, not expired, and the play keys weren't cancelled since.
fn check_agent(a: &AgentState, signer: &Pubkey, wallet_state: &AccountInfo) -> Result<()> {
    require!(a.agent != Pubkey::default() && a.agent == *signer, PokerError::NotAgent);
    require!(Clock::get()?.unix_timestamp < a.expires, PokerError::AgentExpired);
    require!(wallet_state_of(wallet_state)?.0 == a.key_set, PokerError::AgentExpired);
    Ok(())
}

// ---------------------------------------------------------------------------------------- L1: the sponsor (admin, once)

#[derive(Accounts)]
pub struct CreateAgentSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PokerError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + AgentSponsor::INIT_SPACE, seeds = [AGENT_SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, AgentSponsor>,
    pub system_program: Program<'info, System>,
}

/// Creates the Agent sponsor with `lamports` beyond its rent (they pay Agent records' rent in the rollup).
pub fn create_agent_sponsor(ctx: Context<CreateAgentSponsor>, lamports: u64) -> Result<()> {
    ctx.accounts.sponsor.bump = ctx.bumps.sponsor;
    if lamports > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.key(), anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: ctx.accounts.sponsor.to_account_info() }),
            lamports,
        )?;
    }
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateAgentSponsor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PokerError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the sponsor PDA (checked by its seeds and owner).
    #[account(mut, del, seeds = [AGENT_SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
    /// CHECK: must be the TEE validator.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
}

/// Hands the sponsor (and its lamports) to the TEE validator.
pub fn delegate_agent_sponsor(ctx: Context<DelegateAgentSponsor>) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(*a.sponsor.owner, crate::ID, PokerError::NotAgent);
    let key = a.sponsor.key();
    let s_bump = [ctx.bumps.sponsor];
    let s_seeds: &[&[u8]] = &[AGENT_SPONSOR_SEED, &s_bump];
    let buffer_bump = [ctx.bumps.buffer_sponsor];
    let buffer_seeds: &[&[u8]] = &[DELEGATE_BUFFER_TAG, key.as_ref(), &buffer_bump];
    let acct = a.sponsor.to_account_info();
    let buffer = a.buffer_sponsor.to_account_info();
    let admin = a.admin.to_account_info();
    let system = a.system_program.to_account_info();
    create_pda(&buffer, &crate::ID, acct.data_len(), &[buffer_seeds], &system, &admin, false)?;
    {
        let src = acct.try_borrow_data()?;
        buffer.try_borrow_mut_data()?.copy_from_slice(&src);
    }
    acct.try_borrow_mut_data()?.fill(0);
    acct.assign(&anchor_lang::solana_program::system_program::ID);
    invoke_signed(&anchor_lang::solana_program::system_instruction::assign(&key, &DELEGATION_PROGRAM_ID), &[acct.clone(), system.clone()], &[s_seeds])?;
    cpi_delegate(
        &admin,
        &acct,
        &a.owner_program.to_account_info(),
        &buffer,
        &a.delegation_record_sponsor.to_account_info(),
        &a.delegation_metadata_sponsor.to_account_info(),
        &system,
        &[s_seeds],
        DelegateAccountArgs { commit_frequency_ms: u32::MAX, seeds: vec![AGENT_SPONSOR_SEED.to_vec()], validator: Some(TEE_VALIDATOR) },
    )?;
    close_pda_with_system_transfer(&buffer, &[buffer_seeds], &admin, &system)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------- rollup: set / stop (play key)

#[derive(Accounts)]
pub struct AgentSet<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`; checked against the signed message.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist). Read in `wallet_state_of`.
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: the wallet's Agent record (rollup-only, created here the first time).
    #[account(mut, seeds = [AGENT_SEED, wallet.key().as_ref()], bump)]
    pub agent_state: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the record.
    #[account(mut, seeds = [PERMISSION_SEED, agent_state.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub agent_permission: UncheckedAccount<'info>,
    /// CHECK: the Agent sponsor (delegated; pays the record's rent). Checked by its seeds.
    #[account(mut, seeds = [AGENT_SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA (its balance must cover the stake).
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref(), &vault_gen_seed(&wallet_state)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// M12 review M4: only a game balance holding the stake may set an Agent (throwaway wallets can't use up
    /// the sponsor).
    #[account(address = get_associated_token_address(&vault.key(), &WSOL_MINT))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// Nomad's share of copied strategies' profit.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub rollup: RollupPrograms<'info>,
}

/// Sets the wallet's Agent: `agent` (the runner's key) may play until `until` with at most `stake` at risk.
/// Replaces any earlier Agent key (one Agent per wallet). `agent` = default stops it. While the Agent holds a
/// seat, what it has committed stays counted; otherwise the count starts again from 0.
/// `terms`: the copied strategy's fees the player agrees to (default = none). They can't change while the Agent
/// holds a seat; new terms start the high-water mark afresh. Stopping keeps the record's terms.
pub fn agent_set(ctx: Context<AgentSet>, expires: i64, agent: Pubkey, until: i64, stake: u64, terms: FeeTerms) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    let play_key = ctx.accounts.play_key.key();
    verify_play_key(&ctx.accounts.instructions, &ctx.accounts.wallet_state, &wallet, &play_key, expires)?;
    let now = Clock::get()?.unix_timestamp;
    let stopping = agent == Pubkey::default();
    if !stopping {
        require!(until > now && until <= now.saturating_add(MAX_AGENT_SECS), PokerError::AgentExpired);
        require!(stake > 0 && agent != wallet && agent != play_key, PokerError::BadAgentSettings);
        require!(ctx.accounts.vault_token.amount >= stake, PokerError::AgentStakeExceeded);
        check_terms(&terms, &wallet, ctx.accounts.config.agent_fee_bps())?;
    }
    let key_set = wallet_state_of(&ctx.accounts.wallet_state)?.0;
    let info = ctx.accounts.agent_state.to_account_info();
    let (_, bump) = agent_seeds_of(&wallet);
    let ab = [bump];
    let agent_seeds: &[&[u8]] = &[AGENT_SEED, wallet.as_ref(), &ab];
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    let sb = [ctx.bumps.sponsor];
    let sponsor_seeds: &[&[u8]] = &[AGENT_SPONSOR_SEED, &sb];
    let (magic, vault, perm) = (ctx.accounts.rollup.magic_program.to_account_info(), ctx.accounts.rollup.vault.to_account_info(), ctx.accounts.rollup.permission_program.to_account_info());
    let sp = Sponsor { table: &sponsor_info, table_seeds: sponsor_seeds, vault: &vault, magic_program: &magic, permission_program: &perm };
    let mut a = if info.data_is_empty() {
        require!(!stopping, PokerError::NotAgent);
        sp.create_account(&info, agent_seeds, 8 + AgentState::INIT_SPACE)?;
        AgentState {
            wallet, agent: Pubkey::default(), expires: 0, key_set, stake: 0, committed: 0, table: Pubkey::default(), seat: 0, reader: Pubkey::default(), bump,
            strategy_creator: Pubkey::default(), creator_fee_bps: 0, platform_fee_bps: 0, seat_in: 0, net_in: 0, net_out: 0, high_water: 0, skipped: 0,
            reserved: [0; 16],
        }
    } else {
        load_agent(&info)?
    };
    require_keys_eq!(a.wallet, wallet, PokerError::NotAgent);
    a.agent = agent;
    a.expires = if stopping { 0 } else { until };
    a.stake = if stopping { 0 } else { stake };
    a.key_set = key_set;
    if a.table == Pubkey::default() {
        a.committed = 0;
        if !stopping {
            a.set_terms(&terms);
        }
    } else {
        require!(stopping || a.terms() == terms, PokerError::FeeTermsLocked);
    }
    write(&info, &a)?;
    // Private: only the Agent key and this play key can read it.
    let members: Vec<Pubkey> = if stopping { vec![play_key] } else { vec![agent, play_key] };
    let perm_info = ctx.accounts.agent_permission.to_account_info();
    if perm_info.data_is_empty() {
        sp.create_permission(&info, agent_seeds, &perm_info, &members)?;
    } else {
        sp.set_readers(&info, agent_seeds, &perm_info, &members)?;
    }
    emit!(AgentChanged { wallet, running: !stopping });
    if !stopping && terms.creator != Pubkey::default() {
        emit!(AgentCopying { wallet, creator: terms.creator, creator_fee_bps: terms.creator_fee_bps, platform_fee_bps: terms.platform_fee_bps });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------- rollup: buy-in (Agent key)

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct AgentBuyIn<'info> {
    pub agent_key: Signer<'info>,
    /// CHECK: the wallet the Agent plays for (its record's wallet).
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's Agent record; read and checked in the handler.
    #[account(mut, seeds = [AGENT_SEED, wallet.key().as_ref()], bump)]
    pub agent_state: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA (signs the transfer).
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref(), &vault_gen_seed(&wallet_state)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist). Read in `wallet_state_of`.
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &table.mint))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: this seat's rollup-only hand PDA.
    #[account(mut, seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump)]
    pub hand: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand.
    #[account(mut, seeds = [PERMISSION_SEED, hand.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hand_permission: UncheckedAccount<'info>,
    /// CHECK: the table's invite list; checked in `invite_admits`.
    pub invites: Option<UncheckedAccount<'info>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// The Agent sits down (or rebuys at its seat) as the wallet, paid from the wallet's game balance, with
/// `reader` (a fresh key of the runner's) as the seat's table key. One seat at a time, never the player's
/// own seat, and never more than the stake committed.
pub fn agent_buy_in(ctx: Context<AgentBuyIn>, seat: u8, amount: u64, reader: Pubkey) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    let info = ctx.accounts.agent_state.to_account_info();
    let mut a = load_agent(&info)?;
    require_keys_eq!(a.wallet, wallet, PokerError::NotAgent);
    check_agent(&a, &ctx.accounts.agent_key.key(), &ctx.accounts.wallet_state)?;
    let table_key = ctx.accounts.table.key();
    let idx = seat as usize;
    require!(idx < ctx.accounts.ledger.seats.len(), PokerError::InvalidSeat);
    match ctx.accounts.ledger.seat_of(&wallet) {
        // The wallet sits here: only a rebuy at the Agent's own seat (never the player's own seat).
        Some(i) => require!(a.table == table_key && a.seat == seat && i == idx && ctx.accounts.ledger.seats[i].reader == a.reader, PokerError::AgentBusy),
        // A new seat: only when the Agent holds none.
        None => {
            require!(a.table == Pubkey::default(), PokerError::AgentBusy);
            a.table = table_key;
            a.seat = seat;
            a.reader = reader;
        }
    }
    a.committed = a.committed.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    require!(a.committed <= a.stake, PokerError::AgentStakeExceeded);
    a.seat_in = a.seat_in.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    write(&info, &a)?;
    let vault_bump = [ctx.bumps.vault];
    let gen_seed = vault_gen_seed(&ctx.accounts.wallet_state);
    let code: Option<&[u8; 16]> = None;
    buy_in_flow!(ctx, seat, amount, reader, wallet, code, token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer { from: ctx.accounts.vault_token.to_account_info(), to: ctx.accounts.escrow.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
            &[&[VAULT_SEED, wallet.as_ref(), &gen_seed, &vault_bump]],
        ),
        amount,
    )?)
}

// ---------------------------------------------------------------------------------------- rollup: cash-out (Agent key)

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct AgentCashOut<'info> {
    /// The Agent key, or the seat's table key.
    pub signer: Signer<'info>,
    /// CHECK: the wallet the Agent plays for.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's Agent record; read and checked in the handler.
    #[account(mut, seeds = [AGENT_SEED, wallet.key().as_ref()], bump)]
    pub agent_state: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA.
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref(), &vault_gen_seed(&wallet_state)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist).
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &table.mint))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: this seat's hand PDA; closed here.
    #[account(mut, seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump)]
    pub hand: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand; closed here.
    #[account(mut, seeds = [PERMISSION_SEED, hand.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hand_permission: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// Its dev_wallet gets Nomad's share of copied strategies' profit. Not version-checked: leaving always works.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: copying only: the creator's wallet state (WALLET_SEED), for their current vault. Checked in `fee_account`.
    pub creator_wallet_state: Option<UncheckedAccount<'info>>,
    /// CHECK: copying only: the creator's game balance (their vault's token account). Checked in `fee_account`.
    #[account(mut)]
    pub creator_vault_token: Option<UncheckedAccount<'info>>,
    /// CHECK: copying only: config.dev_wallet's wallet state. Checked in `fee_account`.
    pub treasury_wallet_state: Option<UncheckedAccount<'info>>,
    /// CHECK: copying only: config.dev_wallet's game balance. Checked in `fee_account`.
    #[account(mut)]
    pub treasury_vault_token: Option<UncheckedAccount<'info>>,
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// `wallet`'s game balance for a fee, from its wallet state and token account, which must be the right addresses
/// (else the instruction fails). None when that balance can't take money in this rollup (never opened, or its
/// wallet state unreadable): its share then stays with the player rather than block the cash-out.
fn fee_account<'info>(wallet: &Pubkey, mint: &Pubkey, state: &Option<UncheckedAccount<'info>>, token: &Option<UncheckedAccount<'info>>) -> Result<Option<AccountInfo<'info>>> {
    let (state, token) = (state.as_ref().ok_or(PokerError::BadFeeAccount)?, token.as_ref().ok_or(PokerError::BadFeeAccount)?);
    let (state_key, _) = Pubkey::find_program_address(&[WALLET_SEED, wallet.as_ref()], &crate::ID);
    require_keys_eq!(state.key(), state_key, PokerError::BadFeeAccount);
    let seed = match wallet_state_of(&state.to_account_info()) {
        Ok((_, seed)) => seed,
        Err(_) => return Ok(None),
    };
    let (vault, _) = vault_address(wallet, &seed);
    require_keys_eq!(token.key(), get_associated_token_address(&vault, mint), PokerError::BadFeeAccount);
    let info = token.to_account_info();
    if info.data_is_empty() || *info.owner != anchor_spl::token::ID {
        return Ok(None);
    }
    let usable = TokenAccount::try_deserialize(&mut &info.try_borrow_data()?[..]).map(|t| t.mint == *mint && t.owner == vault).unwrap_or(false);
    Ok(if usable { Some(info) } else { None })
}

/// The Agent leaves its seat with the whole stack, into the wallet's game balance; what it took out comes
/// off what it has committed. Works after the Agent was stopped or expired too (leaving is always allowed).
/// Copying a strategy: the shares of new profit above the high-water mark then go from the game balance to the
/// creator's and Nomad's game balances.
pub fn agent_cash_out(ctx: Context<AgentCashOut>, seat: u8) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    let signer = ctx.accounts.signer.key();
    let info = ctx.accounts.agent_state.to_account_info();
    let mut a = load_agent(&info)?;
    require_keys_eq!(a.wallet, wallet, PokerError::NotAgent);
    let idx = seat as usize;
    require!(idx < ctx.accounts.ledger.seats.len(), PokerError::InvalidSeat);
    let (player, reader, stack) = { let s = &ctx.accounts.ledger.seats[idx]; (s.player, s.reader, s.stack) };
    // Only the Agent's own seat: the one on its record, still the wallet's, still with its table key.
    require!(a.table == ctx.accounts.table.key() && a.seat == seat && player == wallet && reader == a.reader, PokerError::NotAgentSeat);
    require!((a.agent != Pubkey::default() && signer == a.agent) || signer == a.reader, PokerError::NotAgent);
    a.committed = a.committed.saturating_sub(stack);
    a.table = Pubkey::default();
    a.reader = Pubkey::default();
    let fees = a.settle(stack)?;
    write(&info, &a)?;
    let left: Result<()> = cash_out_flow!(ctx, seat, |p: Pubkey, _reader: Pubkey| -> Result<()> { require_keys_eq!(p, wallet, PokerError::NotSeated); Ok(()) }, vault_token);
    left?;
    if a.strategy_creator == Pubkey::default() {
        return Ok(());
    }
    let mint = ctx.accounts.table.mint;
    let creator_to = fee_account(&a.strategy_creator, &mint, &ctx.accounts.creator_wallet_state, &ctx.accounts.creator_vault_token)?;
    let treasury_to = fee_account(&ctx.accounts.config.dev_wallet, &mint, &ctx.accounts.treasury_wallet_state, &ctx.accounts.treasury_vault_token)?;
    let vault_bump = [ctx.bumps.vault];
    let gen_seed = vault_gen_seed(&ctx.accounts.wallet_state);
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, wallet.as_ref(), &gen_seed, &vault_bump];
    let mut paid = [0u64; 2];
    for (i, (to, amount)) in [(creator_to, fees.creator), (treasury_to, fees.platform)].into_iter().enumerate() {
        let Some(to) = to else { continue };
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer { from: ctx.accounts.vault_token.to_account_info(), to, authority: ctx.accounts.vault.to_account_info() },
                &[vault_seeds],
            ),
            amount,
        )?;
        paid[i] = amount;
    }
    emit!(AgentFeesPaid { wallet, creator: a.strategy_creator, profit: fees.base, creator_fee: paid[0], platform_fee: paid[1], high_water: a.high_water });
    Ok(())
}

// ---------------------------------------------------------------------------------------- rollup: release (anyone)

#[derive(Accounts)]
pub struct AgentRelease<'info> {
    /// CHECK: the wallet the Agent plays for.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's Agent record.
    #[account(mut, seeds = [AGENT_SEED, wallet.key().as_ref()], bump)]
    pub agent_state: UncheckedAccount<'info>,
    /// CHECK: the table on the record (M12 review M1: it may be closed, or reclaimed and empty). Read below.
    pub table: UncheckedAccount<'info>,
    /// CHECK: the table's ledger PDA (checked by its seeds); read only while the table is open.
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: UncheckedAccount<'info>,
}

/// The Agent's seat was left another way (the player cashed it out with their play key, or the table
/// closed): frees the record for a new seat. What it had committed stays counted (the amount isn't known
/// here), so this never lets it risk more; setting the Agent again starts the count anew.
pub fn agent_release(ctx: Context<AgentRelease>) -> Result<()> {
    let info = ctx.accounts.agent_state.to_account_info();
    let mut a = load_agent(&info)?;
    require_keys_eq!(a.wallet, ctx.accounts.wallet.key(), PokerError::NotAgent);
    require_keys_eq!(a.table, ctx.accounts.table.key(), PokerError::NotAgentSeat);
    let idx = a.seat as usize;
    let table_info = ctx.accounts.table.to_account_info();
    // Our table and still open: the seat is gone only if the ledger shows someone else (or nobody) there.
    let open_table = *table_info.owner == crate::ID
        && !table_info.data_is_empty()
        && Table::try_deserialize(&mut &table_info.try_borrow_data()?[..]).map(|t| t.status == STATUS_OPEN).unwrap_or(false);
    let gone = if !open_table {
        true
    } else {
        let li = ctx.accounts.ledger.to_account_info();
        require_keys_eq!(*li.owner, crate::ID, PokerError::NotAgentSeat);
        let ledger = Ledger::try_deserialize(&mut &li.try_borrow_data()?[..])?;
        idx >= ledger.seats.len() || ledger.seats[idx].player != a.wallet || ledger.seats[idx].reader != a.reader
    };
    require!(gone, PokerError::AgentBusy);
    // Copying: the seat's result isn't known here, so it counts neither way (no fee, no loss carried forward).
    if a.strategy_creator != Pubkey::default() && a.seat_in > 0 {
        a.skipped = a.skipped.saturating_add(1);
    }
    a.seat_in = 0;
    a.table = Pubkey::default();
    a.reader = Pubkey::default();
    write(&info, &a)
}

// ---------------------------------------------------------------------------------------- rollup: close (play key)

#[derive(Accounts)]
pub struct AgentClose<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`; checked against the signed message.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist).
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: the wallet's Agent record; closed here.
    #[account(mut, seeds = [AGENT_SEED, wallet.key().as_ref()], bump)]
    pub agent_state: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the record; closed here.
    #[account(mut, seeds = [PERMISSION_SEED, agent_state.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub agent_permission: UncheckedAccount<'info>,
    /// CHECK: the Agent sponsor; gets the rent back.
    #[account(mut, seeds = [AGENT_SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

/// M12 review M4: removes the wallet's Agent record (no seat held); its rent goes back to the sponsor.
pub fn agent_close(ctx: Context<AgentClose>, expires: i64) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    verify_play_key(&ctx.accounts.instructions, &ctx.accounts.wallet_state, &wallet, &ctx.accounts.play_key.key(), expires)?;
    let info = ctx.accounts.agent_state.to_account_info();
    let a = load_agent(&info)?;
    require_keys_eq!(a.wallet, wallet, PokerError::NotAgent);
    require!(a.table == Pubkey::default(), PokerError::AgentBusy);
    let (_, bump) = agent_seeds_of(&wallet);
    let ab = [bump];
    let agent_seeds: &[&[u8]] = &[AGENT_SEED, wallet.as_ref(), &ab];
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    let sb = [ctx.bumps.sponsor];
    let sponsor_seeds: &[&[u8]] = &[AGENT_SPONSOR_SEED, &sb];
    let (magic, vault, perm) = (ctx.accounts.rollup.magic_program.to_account_info(), ctx.accounts.rollup.vault.to_account_info(), ctx.accounts.rollup.permission_program.to_account_info());
    let sp = Sponsor { table: &sponsor_info, table_seeds: sponsor_seeds, vault: &vault, magic_program: &magic, permission_program: &perm };
    let perm_info = ctx.accounts.agent_permission.to_account_info();
    if !perm_info.data_is_empty() {
        sp.close_permission(&info, agent_seeds, &perm_info)?;
    }
    sp.close_account(&info)?;
    emit!(AgentChanged { wallet, running: false });
    Ok(())
}

#[event]
pub struct AgentChanged {
    pub wallet: Pubkey,
    pub running: bool,
}

#[event]
pub struct AgentCopying {
    pub wallet: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_bps: u16,
    pub platform_fee_bps: u16,
}

/// A copying Agent cashed out: `profit` above the high-water mark, and the shares paid (0 for a balance that
/// couldn't take money).
#[event]
pub struct AgentFeesPaid {
    pub wallet: Pubkey,
    pub creator: Pubkey,
    pub profit: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub high_water: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copying(creator_bps: u16, platform_bps: u16) -> AgentState {
        AgentState {
            wallet: Pubkey::new_unique(), agent: Pubkey::new_unique(), expires: 0, key_set: 0, stake: 0, committed: 0, table: Pubkey::default(), seat: 0,
            reader: Pubkey::default(), bump: 0, strategy_creator: Pubkey::new_unique(), creator_fee_bps: creator_bps, platform_fee_bps: platform_bps,
            seat_in: 0, net_in: 0, net_out: 0, high_water: 0, skipped: 0, reserved: [0; 16],
        }
    }

    fn session(a: &mut AgentState, buy_in: u64, cash_out: u64) -> FeeSplit {
        a.seat_in = buy_in;
        a.settle(cash_out).unwrap()
    }

    #[test]
    fn fees_only_on_new_profit() {
        let mut a = copying(800, 200);
        assert_eq!(session(&mut a, 10_000, 11_000), FeeSplit { base: 1_000, creator: 80, platform: 20 });
        assert_eq!(a.high_water, 1_000);
        // Lose 1000, win it back: nothing new above the peak.
        assert_eq!(session(&mut a, 10_000, 9_000), FeeSplit::default());
        assert_eq!(session(&mut a, 10_000, 11_000), FeeSplit::default());
        assert_eq!(session(&mut a, 10_000, 10_500), FeeSplit { base: 500, creator: 40, platform: 10 });
        assert_eq!(a.high_water, 1_500);
        assert_eq!((a.net_in, a.net_out, a.seat_in), (40_000, 41_500, 0));
    }

    #[test]
    fn losing_first_pays_nothing_until_recovered() {
        let mut a = copying(800, 200);
        assert_eq!(session(&mut a, 10_000, 0), FeeSplit::default());
        assert_eq!(session(&mut a, 10_000, 19_000), FeeSplit::default()); // still -1000 overall
        assert_eq!(session(&mut a, 10_000, 12_000).base, 1_000);
    }

    #[test]
    fn own_strategy_pays_nothing() {
        let mut a = copying(0, 0);
        a.strategy_creator = Pubkey::default();
        assert_eq!(session(&mut a, 10_000, 50_000), FeeSplit::default());
        assert_eq!(a.net_out, 50_000);
    }

    #[test]
    fn fees_never_exceed_the_stack() {
        let mut a = copying(MAX_CREATOR_FEE_BPS, MAX_PLATFORM_FEE_BPS);
        let f = session(&mut a, 1, u64::MAX / 4);
        assert_eq!(f.base, u64::MAX / 4 - 1);
        assert!(f.creator + f.platform <= u64::MAX / 4);
        // Tiny profits round down to nothing.
        assert_eq!(session(&mut a, 0, 3), FeeSplit { base: 3, creator: 0, platform: 0 });
    }

    #[test]
    fn new_terms_start_afresh() {
        let mut a = copying(800, 200);
        session(&mut a, 10_000, 5_000);
        let same = a.terms();
        a.set_terms(&same);
        assert_eq!(a.net_in, 10_000);
        let other = FeeTerms { creator: Pubkey::new_unique(), ..same };
        a.set_terms(&other);
        assert_eq!((a.net_in, a.net_out, a.high_water, a.strategy_creator), (0, 0, 0, other.creator));
    }

    #[test]
    fn terms_checks() {
        let (w, c) = (Pubkey::new_unique(), Pubkey::new_unique());
        let t = |creator: Pubkey, cb: u16, pb: u16| FeeTerms { creator, creator_fee_bps: cb, platform_fee_bps: pb };
        assert!(check_terms(&FeeTerms::default(), &w, 200).is_ok());
        assert!(check_terms(&t(Pubkey::default(), 800, 0), &w, 200).is_err());
        assert!(check_terms(&t(c, 800, 200), &w, 200).is_ok());
        assert!(check_terms(&t(c, 800, 0), &w, 200).is_err()); // skipping Nomad's share
        assert!(check_terms(&t(w, 800, 200), &w, 200).is_err()); // copying yourself
        assert!(check_terms(&t(c, MAX_CREATOR_FEE_BPS + 1, 200), &w, 200).is_err());
        assert!(check_terms(&t(c, 800, 600), &w, 600).is_err()); // above the cap even if the config said so
    }

    /// The layout the runner (backend agents.ts decodeAgentState) and the game (PerAgent.State) read: v2 fields at
    /// fixed offsets after the v1 ones. The record isn't in the IDL (it's a raw rollup account), so it's pinned here.
    #[test]
    fn record_layout() {
        let mut a = copying(0x0320, 0x00c8);
        a.seat = 7;
        a.bump = 0xfe;
        a.seat_in = 0x0101_0101;
        a.net_in = 0x0202_0202;
        a.net_out = 0x0303_0303;
        a.high_water = -5;
        a.skipped = 9;
        let mut v = Vec::new();
        a.try_serialize(&mut v).unwrap();
        assert_eq!(v.len(), 8 + AgentState::INIT_SPACE);
        assert_eq!(v.len(), 254);
        assert_eq!(v[132], 7); // seat
        assert_eq!(v[165], 0xfe); // bump
        assert_eq!(&v[166..198], a.strategy_creator.as_ref());
        assert_eq!(u16::from_le_bytes([v[198], v[199]]), 800);
        assert_eq!(u16::from_le_bytes([v[200], v[201]]), 200);
        assert_eq!(u64::from_le_bytes(v[202..210].try_into().unwrap()), 0x0101_0101);
        assert_eq!(u64::from_le_bytes(v[210..218].try_into().unwrap()), 0x0202_0202);
        assert_eq!(u64::from_le_bytes(v[218..226].try_into().unwrap()), 0x0303_0303);
        assert_eq!(i64::from_le_bytes(v[226..234].try_into().unwrap()), -5);
        assert_eq!(u32::from_le_bytes(v[234..238].try_into().unwrap()), 9);
        assert!(v[238..].iter().all(|b| *b == 0));
    }
}
