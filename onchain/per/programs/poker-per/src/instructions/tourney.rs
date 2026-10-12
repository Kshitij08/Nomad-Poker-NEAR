//! M11: on-chain tournaments (see `crate::tourney` for the account and its rules).
//!
//! Life of a tournament:
//! - L1: the host creates it with its escrow (`create_tournament`) and hands it to the rollup
//!   (`delegate_tournament`). At the start time the keeper creates its tables (`create_tourney_table`,
//!   tables whose creator is the tournament), hands them over (`delegate_table`) and opens them
//!   (`open_table`).
//! - Rollup, money (play key, as buy-ins): `tourney_fund` (host prize), `tourney_register`,
//!   `tourney_leave` (refund before the start), `tourney_cancel` (host), `tourney_refund` (after a
//!   cancellation, anyone), `tourney_payout` (at the end, anyone).
//! - Rollup, play (anyone; the keeper or players' games): `tourney_link_table`, `tourney_start` (VRF),
//!   `tourney_draw` (its callback: the seat draw), `tourney_seat_table` (seats a round at a table with
//!   fresh stacks), `tourney_sync` (between hands: blinds, eliminations, the end of a table's round,
//!   the next round's seat plan, the champion). Hands are played by the ordinary instructions.
//!
//! The tournament is zero-copy: every handler copies what it needs out of a loaded tournament and lets
//! the load go before a transfer the tournament signs (a held load would block the CPI's borrow).
//! Only `create_tournament` can make a tournament account (its address is the host + id PDA there), so
//! the loaders' owner and discriminator checks are enough to trust one.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::{delegate, vrf, vrf_callback};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::cpi_delegate;
use ephemeral_rollups_sdk::types::DelegateAccountArgs;
use ephemeral_rollups_sdk::utils::{close_pda_with_system_transfer, create_pda};
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use anchor_lang::system_program::{transfer, Transfer as SolTransfer};
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use solana_sha256_hasher::hashv;

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, TEE_VALIDATOR};
use crate::errors::PokerError;
use crate::instructions::money::*;
use crate::instructions::table::{setup_escrow, EscrowAccounts, DELEGATION_PROGRAM_ID, ESCAPE_PAYER_FLOAT, ESCAPE_PAYER_SEED, ESPL_PROGRAM_ID};
use crate::instructions::vault::{vault_gen_seed, verify_play_key, VAULT_SEED, WALLET_SEED};
use crate::private::{write, Sponsor};
use crate::state::Config;
use crate::table::{
    Hand, Ledger, Seat, Table, HAND_IDLE, HAND_SEED, LEDGER_SEED, STATUS_CREATED, STATUS_OPEN, TABLE_RESERVED, TABLE_SEED,
    TABLE_SPONSOR_LAMPORTS, TABLE_VERSION, VRF_RETRY_SECS, WSOL_MINT,
};
use crate::tourney::*;

const DELEGATE_BUFFER_TAG: &[u8] = b"buffer";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TourneyParams {
    pub name: [u8; NAME_LEN],
    pub speed: u8,
    pub max_players: u8,
    pub entry_fee: u64,
    pub start_ts: i64,
    /// sha256(tournament address, code) for a private tournament; all zero for a listed one.
    pub code_hash: [u8; 32],
}

pub fn check_tourney_params(p: &TourneyParams, now: i64, config_max_buy_in: u64) -> Result<()> {
    require!(p.speed <= SPEED_SLOW, PokerError::BadTourneySettings);
    require!(p.max_players >= 2 && p.max_players as usize <= MAX_ENTRANTS, PokerError::BadTourneySettings);
    require!(p.entry_fee <= config_max_buy_in, PokerError::BadTourneySettings);
    require!(p.start_ts >= now.saturating_add(MIN_LEAD_SECS) && p.start_ts <= now.saturating_add(MAX_LEAD_SECS), PokerError::BadTourneySettings);
    require!(p.name.iter().any(|&b| b != 0), PokerError::BadTourneySettings);
    Ok(())
}

/// What a transfer signed by the tournament needs, copied out of a load.
#[derive(Clone, Copy)]
struct PoolSigner {
    host: Pubkey,
    id: [u8; 8],
    bump: [u8; 1],
}

impl PoolSigner {
    fn of(t: &Tournament) -> Self {
        PoolSigner { host: t.host, id: t.tourney_id.to_le_bytes(), bump: [t.bump] }
    }
    fn pay<'info>(&self, tourney: &AccountInfo<'info>, escrow: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, token_program: &Program<'info, Token>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer { from: escrow.to_account_info(), to: to.to_account_info(), authority: tourney.clone() },
                &[&[TOURNEY_SEED, self.host.as_ref(), &self.id, &self.bump]],
            ),
            amount,
        )
    }
}

// ======================================================================================== L1: create

/// The host creates the tournament and its escrow (the pool), exactly as a table and its escrow are
/// created (`setup_escrow`). One wallet approval; the host pays the rent.
#[derive(Accounts)]
#[instruction(tourney_id: u64)]
pub struct CreateTournament<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = host, space = TOURNEY_SPACE, seeds = [TOURNEY_SEED, host.key().as_ref(), &tourney_id.to_le_bytes()], bump)]
    pub tourney: AccountLoader<'info, Tournament>,
    /// CHECK: must be wrapped SOL.
    #[account(address = WSOL_MINT @ PokerError::UnsupportedMint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the tournament's wSOL token account on L1, created here.
    #[account(mut, address = get_associated_token_address(&tourney.key(), &WSOL_MINT))]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the tournament's ephemeral token account.
    #[account(mut, seeds = [tourney.key().as_ref(), mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub escrow_eata: UncheckedAccount<'info>,
    /// CHECK: ESPL delegation buffer.
    #[account(mut, seeds = [b"buffer", escrow_eata.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub escrow_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", escrow_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", escrow_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: the escrow's permission, created public here.
    #[account(mut, seeds = [PERMISSION_SEED, escrow_eata.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub escrow_permission: UncheckedAccount<'info>,
    /// CHECK: permission program's delegation buffer.
    #[account(mut, seeds = [b"buffer", escrow_permission.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub escrow_permission_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", escrow_permission.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_permission_delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", escrow_permission.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_permission_delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: the TEE validator.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_tournament(ctx: Context<CreateTournament>, tourney_id: u64, params: TourneyParams) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, PokerError::Paused);
    let now = Clock::get()?.unix_timestamp;
    check_tourney_params(&params, now, config.max_buy_in)?;
    let host = ctx.accounts.host.key();
    {
        let mut t = ctx.accounts.tourney.load_init()?;
        t.version = TOURNEY_VERSION;
        t.bump = ctx.bumps.tourney;
        t.status = T_REGISTERING;
        t.speed = params.speed;
        t.max_players = params.max_players;
        t.tourney_id = tourney_id;
        t.host = host;
        t.mint = WSOL_MINT;
        t.name = params.name;
        t.entry_fee = params.entry_fee;
        t.start_ts = params.start_ts;
        t.code_hash = params.code_hash;
        for e in t.entrants.iter_mut() {
            e.table = NO_TABLE;
            e.seat = NO_TABLE;
        }
    }
    let a = &ctx.accounts;
    let (id, bump) = (tourney_id.to_le_bytes(), [ctx.bumps.tourney]);
    setup_escrow(
        &EscrowAccounts {
            payer: &a.host.to_account_info(),
            owner: &a.tourney.to_account_info(),
            mint: &a.mint.to_account_info(),
            escrow: &a.escrow.to_account_info(),
            escrow_eata: &a.escrow_eata.to_account_info(),
            escrow_buffer: &a.escrow_buffer.to_account_info(),
            escrow_delegation_record: &a.escrow_delegation_record.to_account_info(),
            escrow_delegation_metadata: &a.escrow_delegation_metadata.to_account_info(),
            escrow_permission: &a.escrow_permission.to_account_info(),
            escrow_permission_buffer: &a.escrow_permission_buffer.to_account_info(),
            escrow_permission_delegation_record: &a.escrow_permission_delegation_record.to_account_info(),
            escrow_permission_delegation_metadata: &a.escrow_permission_delegation_metadata.to_account_info(),
            espl_program: &a.espl_program.to_account_info(),
            delegation_program: &a.delegation_program.to_account_info(),
            permission_program: &a.permission_program.to_account_info(),
            validator: &a.validator.to_account_info(),
            token_program: &a.token_program.to_account_info(),
            associated_token_program: &a.associated_token_program.to_account_info(),
            system_program: &a.system_program.to_account_info(),
        },
        &[TOURNEY_SEED, host.as_ref(), &id, &bump],
    )?;
    emit!(TourneyCreated { tourney: a.tourney.key(), host, tourney_id, entry_fee: params.entry_fee, start_ts: params.start_ts });
    Ok(())
}

/// Hands the tournament to the TEE validator, as `delegate_table` does for a table (its escape payer
/// pays the delegation rent, so the escape-hatch role can't be captured). The host, while registering.
#[delegate]
#[derive(Accounts)]
#[instruction(tourney_id: u64, host: Pubkey)]
pub struct DelegateTournament<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the tournament PDA; status and host are checked against its data in the handler.
    #[account(mut, del, seeds = [TOURNEY_SEED, host.as_ref(), &tourney_id.to_le_bytes()], bump)]
    pub tourney: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA holding lamports only; this program signs for it.
    #[account(mut, seeds = [ESCAPE_PAYER_SEED, tourney.key().as_ref()], bump)]
    pub escape_payer: UncheckedAccount<'info>,
    /// CHECK: must be the TEE validator.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_tournament(ctx: Context<DelegateTournament>, tourney_id: u64, host: Pubkey) -> Result<()> {
    {
        let info = ctx.accounts.tourney.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, PokerError::TourneyWrongStage);
        let data = info.try_borrow_data()?;
        require!(data.len() >= TOURNEY_SPACE && data[..8] == *Tournament::DISCRIMINATOR, PokerError::TourneyWrongStage);
        let t: &Tournament = bytemuck::from_bytes(&data[8..TOURNEY_SPACE]);
        require!(t.status == T_REGISTERING, PokerError::TourneyWrongStage);
        require_keys_eq!(t.host, ctx.accounts.payer.key(), PokerError::NotCreator);
    }
    let a = &ctx.accounts;
    let need = ESCAPE_PAYER_FLOAT.saturating_sub(a.escape_payer.lamports());
    if need > 0 {
        transfer(CpiContext::new(a.system_program.key(), SolTransfer { from: a.payer.to_account_info(), to: a.escape_payer.to_account_info() }), need)?;
    }
    let key = a.tourney.key();
    let id = tourney_id.to_le_bytes();
    let t_bump = [ctx.bumps.tourney];
    let t_seeds: &[&[u8]] = &[TOURNEY_SEED, host.as_ref(), &id, &t_bump];
    let payer_bump = [ctx.bumps.escape_payer];
    let payer_seeds: &[&[u8]] = &[ESCAPE_PAYER_SEED, key.as_ref(), &payer_bump];
    let buffer_bump = [ctx.bumps.buffer_tourney];
    let buffer_seeds: &[&[u8]] = &[DELEGATE_BUFFER_TAG, key.as_ref(), &buffer_bump];
    let acct = a.tourney.to_account_info();
    let buffer = a.buffer_tourney.to_account_info();
    let escape_payer = a.escape_payer.to_account_info();
    let system = a.system_program.to_account_info();
    create_pda(&buffer, &crate::ID, acct.data_len(), &[buffer_seeds, payer_seeds], &system, &escape_payer, false)?;
    {
        let src = acct.try_borrow_data()?;
        buffer.try_borrow_mut_data()?.copy_from_slice(&src);
    }
    acct.try_borrow_mut_data()?.fill(0);
    acct.assign(&anchor_lang::solana_program::system_program::ID);
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::assign(&key, &DELEGATION_PROGRAM_ID),
        &[acct.clone(), system.clone()],
        &[t_seeds],
    )?;
    cpi_delegate(
        &escape_payer,
        &acct,
        &a.owner_program.to_account_info(),
        &buffer,
        &a.delegation_record_tourney.to_account_info(),
        &a.delegation_metadata_tourney.to_account_info(),
        &system,
        &[t_seeds, payer_seeds],
        DelegateAccountArgs { commit_frequency_ms: u32::MAX, seeds: vec![TOURNEY_SEED.to_vec(), host.as_ref().to_vec(), id.to_vec()], validator: Some(TEE_VALIDATOR) },
    )?;
    close_pda_with_system_transfer(&buffer, &[buffer_seeds], &escape_payer, &system)?;
    Ok(())
}

/// A table for the tournament: created by the program with the tournament as its creator and `index`
/// as its id, so it's tied to the tournament and nobody can make one that looks like it. It holds chips
/// only (no escrow). Anyone may create it and pays its rent (the keeper). Then `delegate_table` (anyone,
/// for a tournament table) and `open_table`.
#[derive(Accounts)]
#[instruction(tourney_id: u64, host: Pubkey, index: u64)]
pub struct CreateTourneyTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the tournament (delegated, so its data isn't read here); its address ties it to host and id.
    #[account(seeds = [TOURNEY_SEED, host.as_ref(), &tourney_id.to_le_bytes()], bump)]
    pub tourney: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Table::INIT_SPACE, seeds = [TABLE_SEED, tourney.key().as_ref(), &index.to_le_bytes()], bump)]
    pub table: Box<Account<'info, Table>>,
    pub system_program: Program<'info, System>,
}

pub fn create_tourney_table(ctx: Context<CreateTourneyTable>, _tourney_id: u64, _host: Pubkey, index: u64) -> Result<()> {
    require!((index as usize) < MAX_TOURNEY_TABLES, PokerError::BadTourneySettings);
    let t = &mut ctx.accounts.table;
    t.version = TABLE_VERSION;
    t.bump = ctx.bumps.table;
    t.status = STATUS_CREATED;
    t.max_seats = TOURNEY_SEATS;
    t.table_id = index;
    t.creator = ctx.accounts.tourney.key();
    t.mint = WSOL_MINT;
    t.small_blind = small_blind(0);
    t.big_blind = small_blind(0) * 2;
    t.last_activity_ts = Clock::get()?.unix_timestamp;
    t.kind = KIND_TOURNEY;
    t.reserved = [0; TABLE_RESERVED];
    // The table sponsors its rollup-only private accounts, as at a cash table.
    transfer(
        CpiContext::new(ctx.accounts.system_program.key(), SolTransfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.table.to_account_info() }),
        TABLE_SPONSOR_LAMPORTS,
    )?;
    Ok(())
}

// ======================================================================================== rollup: money

/// The play-key accounts shared by the money moves: the wallet's vault pays or is paid, the tournament's
/// escrow is the other side.
#[derive(Accounts)]
pub struct TourneyMoney<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`; checked against the signed message.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA (signs payments out of it).
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref(), &vault_gen_seed(&wallet_state)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist). Read in `wallet_state_of`.
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &WSOL_MINT))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    #[account(mut, address = get_associated_token_address(&tourney.key(), &WSOL_MINT))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

impl<'info> TourneyMoney<'info> {
    fn verify(&self, expires: i64) -> Result<Pubkey> {
        let wallet = self.wallet.key();
        verify_play_key(&self.instructions, &self.wallet_state, &wallet, &self.play_key.key(), expires)?;
        Ok(wallet)
    }
    fn pay_in(&self, amount: u64, vault_bump: u8) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let wallet = self.wallet.key();
        let gen_seed = vault_gen_seed(&self.wallet_state);
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer { from: self.vault_token.to_account_info(), to: self.escrow.to_account_info(), authority: self.vault.to_account_info() },
                &[&[VAULT_SEED, wallet.as_ref(), &gen_seed, &[vault_bump]]],
            ),
            amount,
        )
    }
    fn pay_out(&self, signer: PoolSigner, amount: u64) -> Result<()> {
        signer.pay(&self.tourney.to_account_info(), &self.escrow, &self.vault_token, &self.token_program, amount)
    }
    /// The escrow always holds at least what the tournament owes.
    fn check(&mut self) -> Result<()> {
        self.escrow.reload()?;
        let owed = self.tourney.load()?.owed;
        require!(self.escrow.amount >= owed, PokerError::EscrowShortfall);
        Ok(())
    }
}

/// The host puts (more) prize money in from their game balance. Before the start only; the prize can
/// only go up.
pub fn tourney_fund(ctx: Context<TourneyMoney>, expires: i64, amount: u64) -> Result<()> {
    let wallet = ctx.accounts.verify(expires)?;
    require!(!ctx.accounts.config.paused, PokerError::Paused);
    require!(amount > 0, PokerError::BuyInTooSmall);
    {
        let mut t = ctx.accounts.tourney.load_mut()?;
        require!(t.status == T_REGISTERING, PokerError::TourneyClosed);
        require_keys_eq!(wallet, t.host, PokerError::NotCreator);
        t.host_prize = t.host_prize.checked_add(amount).ok_or(PokerError::MathOverflow)?;
        t.owed = t.owed.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    }
    ctx.accounts.pay_in(amount, ctx.bumps.vault)?;
    ctx.accounts.check()
}

/// Registers the wallet, paying the entry fee from its game balance. `reader` is the player's table key
/// for this tournament (signs their seeds and actions, reads their cards). A private tournament needs
/// its code (the TEE withholds this transaction, so the code stays secret).
pub fn tourney_register(ctx: Context<TourneyMoney>, expires: i64, reader: Pubkey, code: Option<[u8; 16]>) -> Result<()> {
    let wallet = ctx.accounts.verify(expires)?;
    require!(!ctx.accounts.config.paused, PokerError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.tourney.key();
    let auditor = ctx.accounts.config.auditor;
    let (fee, count) = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        require!(t.status == T_REGISTERING && now < t.start_ts, PokerError::TourneyClosed);
        require!(t.entrant_of(&wallet).is_none(), PokerError::AlreadyRegistered);
        require!((t.count as usize) < (t.max_players as usize).min(MAX_ENTRANTS), PokerError::TourneyFull);
        require!(reader != Pubkey::default() && reader != wallet && reader != auditor, PokerError::InvalidReader);
        require!(!t.entrants[..t.count as usize].iter().any(|e| e.reader == reader || e.wallet == reader), PokerError::InvalidReader);
        if t.code_hash != [0; 32] {
            let code = code.ok_or(PokerError::BadTourneyCode)?;
            require!(hashv(&[key.as_ref(), &code]).to_bytes() == t.code_hash, PokerError::BadTourneyCode);
        }
        let i = t.count as usize;
        t.entrants[i] = Entrant { wallet, reader, state: E_REGISTERED, table: NO_TABLE, seat: NO_TABLE, place: 0, pad: [0; 4] };
        t.count += 1;
        let fee = t.entry_fee;
        t.owed = t.owed.checked_add(fee).ok_or(PokerError::MathOverflow)?;
        (fee, t.count)
    };
    ctx.accounts.pay_in(fee, ctx.bumps.vault)?;
    emit!(TourneyRegistered { tourney: key, count });
    ctx.accounts.check()
}

/// Leaves before the start: the entry fee goes back to the game balance.
pub fn tourney_leave(ctx: Context<TourneyMoney>, expires: i64) -> Result<()> {
    let wallet = ctx.accounts.verify(expires)?;
    let (fee, signer) = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        require!(t.status == T_REGISTERING, PokerError::TourneyClosed);
        let i = t.entrant_of(&wallet).ok_or(PokerError::NotRegistered)?;
        let last = t.count as usize - 1;
        t.entrants[i] = t.entrants[last];
        t.entrants[last] = Entrant { table: NO_TABLE, seat: NO_TABLE, ..Default::default() };
        t.count -= 1;
        let fee = t.entry_fee;
        t.owed = t.owed.checked_sub(fee).ok_or(PokerError::MathOverflow)?;
        (fee, PoolSigner::of(&t))
    };
    ctx.accounts.pay_out(signer, fee)?;
    ctx.accounts.check()
}

/// The host cancels before the start; everyone is then refunded (`tourney_refund`).
pub fn tourney_cancel(ctx: Context<TourneyMoney>, expires: i64) -> Result<()> {
    let wallet = ctx.accounts.verify(expires)?;
    let key = ctx.accounts.tourney.key();
    let mut t = ctx.accounts.tourney.load_mut()?;
    require_keys_eq!(wallet, t.host, PokerError::NotCreator);
    require!(t.status == T_REGISTERING, PokerError::TourneyWrongStage);
    t.status = T_CANCELLED;
    emit!(TourneyCancelled { tourney: key });
    Ok(())
}

/// A wallet's game balance, as a payee (refunds). Anyone may call: the money can only go to that wallet's
/// own vault.
#[derive(Accounts)]
pub struct TourneyPayee<'info> {
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    #[account(mut, address = get_associated_token_address(&tourney.key(), &WSOL_MINT))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: the payee wallet (checked against the tournament).
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA.
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref(), &vault_gen_seed(&wallet_state)], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the wallet's state (may not exist).
    #[account(seeds = [WALLET_SEED, wallet.key().as_ref()], bump)]
    pub wallet_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &WSOL_MINT))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// After a cancellation: pays one wallet back (its entry fee, and the host prize if it's the host's).
/// Anyone may call it, once per wallet (the keeper does them all).
pub fn tourney_refund(ctx: Context<TourneyPayee>) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    let (amount, signer, owed) = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        require!(t.status == T_CANCELLED, PokerError::TourneyWrongStage);
        let mut amount = 0u64;
        if let Some(i) = t.entrant_of(&wallet) {
            if t.entrants[i].state != E_REFUNDED {
                t.entrants[i].state = E_REFUNDED;
                amount = amount.checked_add(t.entry_fee).ok_or(PokerError::MathOverflow)?;
            }
        }
        if wallet == t.host && t.host_prize > 0 {
            amount = amount.checked_add(t.host_prize).ok_or(PokerError::MathOverflow)?;
            t.host_prize = 0;
        }
        require!(amount > 0, PokerError::NothingOwed);
        t.owed = t.owed.checked_sub(amount).ok_or(PokerError::MathOverflow)?;
        (amount, PoolSigner::of(&t), t.owed)
    };
    let a = &ctx.accounts;
    signer.pay(&a.tourney.to_account_info(), &a.escrow, &a.vault_token, &a.token_program, amount)?;
    ctx.accounts.escrow.reload()?;
    require!(ctx.accounts.escrow.amount >= owed, PokerError::EscrowShortfall);
    Ok(())
}

/// At the end: pays the champion, the runner-up and the platform fee (5% of the entry fees, to the dev
/// wallet). Anyone may call it, once.
#[derive(Accounts)]
pub struct TourneyPayout<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    #[account(mut, address = get_associated_token_address(&tourney.key(), &WSOL_MINT))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: the champion's wallet (checked against the tournament).
    pub champion: UncheckedAccount<'info>,
    /// CHECK: the champion's vault PDA.
    #[account(seeds = [VAULT_SEED, champion.key().as_ref(), &vault_gen_seed(&champion_state)], bump)]
    pub champion_vault: UncheckedAccount<'info>,
    /// CHECK: the champion's wallet state (may not exist).
    #[account(seeds = [WALLET_SEED, champion.key().as_ref()], bump)]
    pub champion_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&champion_vault.key(), &WSOL_MINT))]
    pub champion_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the runner-up's wallet (checked against the tournament).
    pub runner_up: UncheckedAccount<'info>,
    /// CHECK: the runner-up's vault PDA.
    #[account(seeds = [VAULT_SEED, runner_up.key().as_ref(), &vault_gen_seed(&runner_up_state)], bump)]
    pub runner_up_vault: UncheckedAccount<'info>,
    /// CHECK: the runner-up's wallet state (may not exist).
    #[account(seeds = [WALLET_SEED, runner_up.key().as_ref()], bump)]
    pub runner_up_state: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&runner_up_vault.key(), &WSOL_MINT))]
    pub runner_up_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = WSOL_MINT, token::authority = config.dev_wallet)]
    pub dev_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn tourney_payout(ctx: Context<TourneyPayout>) -> Result<()> {
    let key = ctx.accounts.tourney.key();
    let (first, second, fee, signer) = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        require!(t.status == T_FINISHED, PokerError::TourneyWrongStage);
        require_keys_eq!(ctx.accounts.champion.key(), t.champion, PokerError::NothingOwed);
        require_keys_eq!(ctx.accounts.runner_up.key(), t.runner_up, PokerError::NothingOwed);
        let (first, second, fee) = payouts(t.entry_fee, t.count as u64, t.host_prize)?;
        t.owed = t.owed.checked_sub(first + second + fee).ok_or(PokerError::MathOverflow)?;
        t.status = T_PAID;
        (first, second, fee, PoolSigner::of(&t))
    };
    let a = &ctx.accounts;
    let info = a.tourney.to_account_info();
    signer.pay(&info, &a.escrow, &a.champion_token, &a.token_program, first)?;
    signer.pay(&info, &a.escrow, &a.runner_up_token, &a.token_program, second)?;
    signer.pay(&info, &a.escrow, &a.dev_token, &a.token_program, fee)?;
    emit!(TourneyPaid { tourney: key, first, second, fee });
    Ok(())
}

// ======================================================================================== rollup: play

/// Records a created, handed-over and opened table as the tournament's table `table_id`.
#[derive(Accounts)]
pub struct TourneyLinkTable<'info> {
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    #[account(seeds = [TABLE_SEED, tourney.key().as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// The table was opened (its ledger exists).
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

pub fn tourney_link_table(ctx: Context<TourneyLinkTable>) -> Result<()> {
    let table = &ctx.accounts.table;
    require!(table.kind == KIND_TOURNEY && table.creator == ctx.accounts.tourney.key() && table.status == STATUS_OPEN, PokerError::NotTourneyTable);
    let i = table.table_id as usize;
    require!(i < MAX_TOURNEY_TABLES, PokerError::NotTourneyTable);
    let key = table.key();
    let mut t = ctx.accounts.tourney.load_mut()?;
    if t.tables[i] == Pubkey::default() {
        t.tables[i] = key;
        t.linked += 1;
    }
    Ok(())
}

/// At the start time (anyone; the keeper): too few players cancels (everyone is refunded); otherwise
/// the seat draw's randomness is requested from the VRF. Again after VRF_RETRY_SECS if it never came.
#[vrf]
#[derive(Accounts)]
pub struct TourneyStart<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    /// CHECK: MagicBlock's ephemeral VRF queue.
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

pub fn tourney_start(ctx: Context<TourneyStart>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.tourney.key();
    let nonce = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        match t.status {
            T_REGISTERING => {
                require!(now >= t.start_ts, PokerError::TourneyTooEarly);
                if t.count < 2 {
                    t.status = T_CANCELLED;
                    emit!(TourneyCancelled { tourney: key });
                    return Ok(());
                }
                let need = tables_for(t.count as usize);
                require!(t.tables[..need].iter().all(|k| *k != Pubkey::default()), PokerError::TourneyTablesNotReady);
                t.status = T_DRAWING;
            }
            T_DRAWING => require!(now.saturating_sub(t.vrf_requested_ts) >= VRF_RETRY_SECS, PokerError::VrfPending),
            _ => return err!(PokerError::TourneyWrongStage),
        }
        t.vrf_requested_ts = now;
        t.vrf_nonce = t.vrf_nonce.checked_add(1).ok_or(PokerError::MathOverflow)?;
        t.vrf_nonce
    };
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::TourneyDraw::DISCRIMINATOR.to_vec(),
        caller_seed: hashv(&[key.as_ref(), b"draw", &nonce.to_le_bytes()]).to_bytes(),
        accounts_metas: Some(vec![SerializableAccountMeta { pubkey: key, is_signer: false, is_writable: true }]),
        callback_args: Some(nonce.to_le_bytes().to_vec()),
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

/// The VRF's callback: draws the seats (only the VRF program can call it; only the latest request counts).
#[vrf_callback]
#[derive(Accounts)]
pub struct TourneyDraw<'info> {
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
}

pub fn tourney_draw(ctx: Context<TourneyDraw>, randomness: [u8; 32], nonce: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.tourney.key();
    let mut t = ctx.accounts.tourney.load_mut()?;
    require!(t.status == T_DRAWING && nonce == t.vrf_nonce, PokerError::StaleRandomness);
    let n = t.count as usize;
    let order = draw_order(n, &randomness);
    for (e, table, seat) in seat_plan(&order) {
        let en = &mut t.entrants[e as usize];
        en.state = E_PLAYING;
        en.table = table;
        en.seat = seat;
    }
    t.round = 1;
    t.round_tables = tables_for(n) as u8;
    t.done_mask = 0;
    t.running_since = now;
    // The first deal comes 15 s after the draw (the GDD's Coins rule), so every game can get there.
    t.round_starts_ts = now + 15;
    t.status = T_RUNNING;
    emit!(TourneyDrawn { tourney: key, players: n as u8, tables: t.round_tables });
    Ok(())
}

/// The tournament, one of its tables and that table's private ledger: shared by seating and syncing.
#[derive(Accounts)]
pub struct TourneyTable<'info> {
    #[account(mut)]
    pub tourney: AccountLoader<'info, Tournament>,
    #[account(mut, seeds = [TABLE_SEED, tourney.key().as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

impl<'info> TourneyTable<'info> {
    /// This table's index in the tournament, checked: running, linked, used this round, not finished
    /// with it, and between hands.
    fn index(&self) -> Result<usize> {
        let t = self.tourney.load()?;
        let i = self.table.table_id as usize;
        require!(t.status == T_RUNNING, PokerError::TourneyWrongStage);
        require!(i < t.round_tables as usize && t.tables[i] == self.table.key(), PokerError::NotTourneyTable);
        require!(t.done_mask & (1 << i) == 0, PokerError::TourneyWrongStage);
        require!(self.table.hand_state == HAND_IDLE, PokerError::HandInProgress);
        Ok(i)
    }

    fn set_ledger_readers(&self, ledger_bump: u8) -> Result<()> {
        let t = &self.table;
        let (id, bump) = (t.table_id.to_le_bytes(), [t.bump]);
        let ts = table_seeds(t, &id, &bump);
        let (table_info, magic, vault, perm) = (t.to_account_info(), self.rollup.magic_program.to_account_info(), self.rollup.vault.to_account_info(), self.rollup.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        let table_key = t.key();
        let lb = [ledger_bump];
        let ledger_seeds: &[&[u8]] = &[LEDGER_SEED, table_key.as_ref(), &lb];
        sp.set_readers(&self.ledger.to_account_info(), ledger_seeds, &self.ledger_permission.to_account_info(), &self.ledger.readers())
    }
}

/// Seats this round's players at a table, each with a fresh START_STACK of chips and their own table key
/// as reader (their hand account and its permission are made here, as at a cash table), sets the blinds
/// and starts the table (no Start round at a tournament). Remaining accounts: for each seat being taken,
/// ascending, its hand PDA then that hand's permission PDA.
pub fn tourney_seat_table<'info>(ctx: Context<'info, TourneyTable<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = ctx.accounts.index()?;
    let table_key = ctx.accounts.table.key();
    let (mut seats, sb, bb) = {
        let t = ctx.accounts.tourney.load()?;
        require!(now >= t.round_starts_ts, PokerError::TourneyTooEarly);
        let seats: Vec<(u8, Pubkey, Pubkey)> = t.entrants[..t.count as usize]
            .iter()
            .filter(|e| e.state == E_PLAYING && e.table as usize == i && (e.seat as usize) < TOURNEY_SEATS as usize)
            .map(|e| (e.seat, e.wallet, e.reader))
            .filter(|(seat, _, _)| ctx.accounts.ledger.seats[*seat as usize].is_empty())
            .collect();
        let (sb, bb) = t.blinds_at(now);
        (seats, sb, bb)
    };
    seats.sort_by_key(|s| s.0);
    require!(!seats.is_empty(), PokerError::NothingToCollect);
    require!(ctx.remaining_accounts.len() == seats.len() * 2, PokerError::NotTourneyTable);

    {
        let a = &ctx.accounts;
        let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
        let ts = table_seeds(&a.table, &id, &bump);
        let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        for (k, (seat, wallet, reader)) in seats.iter().enumerate() {
            let hand_info = &ctx.remaining_accounts[k * 2];
            let hand_perm = &ctx.remaining_accounts[k * 2 + 1];
            let (hand_key, hand_bump) = Pubkey::find_program_address(&[HAND_SEED, table_key.as_ref(), &[*seat]], &crate::ID);
            require_keys_eq!(hand_info.key(), hand_key, PokerError::NotTourneyTable);
            let (perm_key, _) = Pubkey::find_program_address(&[PERMISSION_SEED, hand_key.as_ref()], &PERMISSION_PROGRAM_ID);
            require_keys_eq!(hand_perm.key(), perm_key, PokerError::NotTourneyTable);
            let seat_byte = [*seat];
            let hb = [hand_bump];
            let hand_seeds: &[&[u8]] = &[HAND_SEED, table_key.as_ref(), &seat_byte, &hb];
            if hand_info.data_is_empty() {
                sp.create_account(hand_info, hand_seeds, 8 + Hand::INIT_SPACE)?;
            }
            write(hand_info, &Hand { table: table_key, seat: *seat, owner: *wallet, hand_no: 0, cards: [u8::MAX; 2], reader: *reader })?;
            if !hand_perm.data_is_empty() {
                sp.set_readers(hand_info, hand_seeds, hand_perm, &[*reader])?;
            } else {
                sp.create_permission(hand_info, hand_seeds, hand_perm, &[*reader])?;
            }
        }
    }
    {
        let ledger = &mut ctx.accounts.ledger;
        for (seat, wallet, reader) in &seats {
            ledger.seats[*seat as usize] = Seat { player: *wallet, reader: *reader, stack: START_STACK, deposited: 0, sitting_out: false };
            ledger.escrow_owed = ledger.escrow_owed.checked_add(START_STACK).ok_or(PokerError::MathOverflow)?;
        }
    }
    ctx.accounts.set_ledger_readers(ctx.bumps.ledger)?;
    let fp = ctx.accounts.ledger.fingerprint()?;
    let table = &mut ctx.accounts.table;
    for (seat, _, _) in &seats {
        table.seat_mask |= 1 << seat;
    }
    table.small_blind = sb;
    table.big_blind = bb;
    if table.start_requested_for == 0 {
        table.start_requested_for = table.hand_no.checked_add(1).ok_or(PokerError::MathOverflow)?;
    }
    table.idle_since = now;
    table.ledger_hash = fp;
    table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.last_activity_ts = now;
    Ok(())
}

/// Between hands (anyone; the keeper, or players' games before they start the next hand): sets the
/// blinds for the current level, takes out players who busted (their finishing place is the number of
/// players left), and ends the table's round once it's down to its survivors (2 in an early round, the
/// champion at the final table). When every table of the round has ended, plans the next round.
pub fn tourney_sync(ctx: Context<TourneyTable>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = ctx.accounts.index()?;
    let key = ctx.accounts.tourney.key();
    // Busted seats, best first: a bigger stack at the start of the hand they lost finishes higher.
    let mut busted: Vec<(u64, usize)> = (0..TOURNEY_SEATS as usize)
        .filter(|&s| !ctx.accounts.ledger.seats[s].is_empty() && ctx.accounts.ledger.seats[s].stack == 0)
        .map(|s| (ctx.accounts.ledger.game.seats[s].total, s))
        .collect();
    busted.sort_by(|a, b| b.0.cmp(&a.0));
    let mut changed = !busted.is_empty();
    let (sb, bb) = {
        let mut t = ctx.accounts.tourney.load_mut()?;
        let final_round = t.round_tables == 1;
        // Worst first, so they take the lowest places.
        for (_, s) in busted.iter().rev() {
            let wallet = ctx.accounts.ledger.seats[*s].player;
            let place = t.alive() as u8;
            if let Some(e) = t.entrant_of(&wallet) {
                t.entrants[e].state = E_OUT;
                t.entrants[e].place = place;
                t.entrants[e].table = NO_TABLE;
                t.entrants[e].seat = NO_TABLE;
                if place == 2 {
                    t.runner_up = wallet;
                }
            }
            ctx.accounts.ledger.seats[*s] = Seat::default();
            ctx.accounts.table.seat_mask &= !(1u16 << s);
        }
        let survivors: Vec<usize> = (0..TOURNEY_SEATS as usize).filter(|&s| !ctx.accounts.ledger.seats[s].is_empty()).collect();
        let table_done = if final_round { survivors.len() <= 1 } else { survivors.len() <= 2 };
        if table_done {
            changed = true;
            for &s in &survivors {
                let wallet = ctx.accounts.ledger.seats[s].player;
                let stack = ctx.accounts.ledger.seats[s].stack;
                if let Some(e) = t.entrant_of(&wallet) {
                    if final_round {
                        t.entrants[e].place = 1;
                        t.entrants[e].state = E_OUT;
                        t.champion = wallet;
                    }
                    // Early round: they advance (still E_PLAYING); table and seat stay until the next plan,
                    // which uses them to spread former tablemates apart.
                }
                let ledger = &mut ctx.accounts.ledger;
                ledger.escrow_owed = ledger.escrow_owed.checked_sub(stack).ok_or(PokerError::MathOverflow)?;
                ledger.seats[s] = Seat::default();
                ctx.accounts.table.seat_mask &= !(1u16 << s);
            }
            t.done_mask |= 1 << i;
            if final_round {
                t.status = T_FINISHED;
                emit!(TourneyFinished { tourney: key, champion: t.champion, runner_up: t.runner_up });
            } else if t.done_mask.count_ones() as u8 == t.round_tables {
                next_round(&mut t, key, now);
            }
        }
        t.blinds_at(now)
    };
    if changed {
        ctx.accounts.set_ledger_readers(ctx.bumps.ledger)?;
        let fp = ctx.accounts.ledger.fingerprint()?;
        let table = &mut ctx.accounts.table;
        table.ledger_hash = fp;
        table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    }
    let table = &mut ctx.accounts.table;
    table.small_blind = sb;
    table.big_blind = bb;
    Ok(())
}

/// Plans the next round: the survivors, ordered by their old table and seat, seated round-robin (so
/// former tablemates are spread apart), after a pause.
fn next_round(t: &mut Tournament, key: Pubkey, now: i64) {
    let mut alive: Vec<(u8, u8, u8)> = t.entrants[..t.count as usize]
        .iter()
        .enumerate()
        .filter(|(_, e)| e.state == E_PLAYING)
        .map(|(k, e)| (e.table, e.seat, k as u8))
        .collect();
    alive.sort();
    let order: Vec<u8> = alive.iter().map(|x| x.2).collect();
    for (e, table, seat) in seat_plan(&order) {
        t.entrants[e as usize].table = table;
        t.entrants[e as usize].seat = seat;
    }
    t.round = t.round.saturating_add(1);
    t.round_tables = tables_for(order.len()) as u8;
    t.done_mask = 0;
    t.round_starts_ts = now + ROUND_PAUSE_SECS;
    emit!(TourneyNextRound { tourney: key, round: t.round, players: order.len() as u8, tables: t.round_tables });
}

// ======================================================================================== events

#[event]
pub struct TourneyCreated {
    pub tourney: Pubkey,
    pub host: Pubkey,
    pub tourney_id: u64,
    pub entry_fee: u64,
    pub start_ts: i64,
}
#[event]
pub struct TourneyRegistered {
    pub tourney: Pubkey,
    pub count: u8,
}
#[event]
pub struct TourneyCancelled {
    pub tourney: Pubkey,
}
#[event]
pub struct TourneyDrawn {
    pub tourney: Pubkey,
    pub players: u8,
    pub tables: u8,
}
#[event]
pub struct TourneyNextRound {
    pub tourney: Pubkey,
    pub round: u8,
    pub players: u8,
    pub tables: u8,
}
#[event]
pub struct TourneyFinished {
    pub tourney: Pubkey,
    pub champion: Pubkey,
    pub runner_up: Pubkey,
}
#[event]
pub struct TourneyPaid {
    pub tourney: Pubkey,
    pub first: u64,
    pub second: u64,
    pub fee: u64,
}
