//! L1 table lifecycle: create (with its escrow), delegate to the TEE rollup, and the
//! timeout-rollback escape hatch. Closing a table happens inside the rollup (see money.rs).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::Token;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::cpi_delegate;
use ephemeral_rollups_sdk::types::DelegateAccountArgs;
use ephemeral_rollups_sdk::utils::{close_pda_with_system_transfer, create_pda};

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, TEE_VALIDATOR};
use crate::errors::PokerError;
use crate::state::Config;
use crate::table::{
    check_table_params, may_delegate, may_request_escape, Invites, Table, TableParams, INVITES_SEED, MAX_INVITES,
    STATUS_CREATED, STATUS_OPEN, TABLE_RESERVED, TABLE_SEED, TABLE_SPONSOR_LAMPORTS, TABLE_VERSION, WSOL_MINT,
};

pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
pub const ESPL_PROGRAM_ID: Pubkey = pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
const DLP_REQUEST_UNDELEGATION: u64 = 26;
const DLP_UNDELEGATE_WITH_ROLLBACK_AFTER_TIMEOUT: u64 = 27;
const ESPL_INIT_EPHEMERAL_ATA: u8 = 0;
const ESPL_DELEGATE_EPHEMERAL_ATA: u8 = 4;

/// Per-table, program-owned (system-account) PDA that pays the table's delegation rent. Because the
/// delegation program records it as rent payer, and only this program can sign for it, nobody can
/// capture the escape-hatch role, and anyone can file the emergency request once the table is idle.
pub const ESCAPE_PAYER_SEED: &[u8] = b"escape-payer";
/// Lamports kept in the escape payer: delegation record/metadata rent and undelegation-request
/// rent. Rent comes back to it when those accounts close.
pub const ESCAPE_PAYER_FLOAT: u64 = 10_000_000;
const DELEGATE_BUFFER_TAG: &[u8] = b"buffer";

/// Creates the table and its escrow in one instruction. The escrow is MagicBlock's ephemeral token
/// account for (table, wSOL), created and delegated to the TEE validator here, so nobody else can
/// set it up first or point it at another validator. The table address includes the creator.
#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreateTable<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, creator.key().as_ref(), &table_id.to_le_bytes()],
        bump,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: must be wrapped SOL.
    #[account(address = WSOL_MINT @ PokerError::UnsupportedMint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the table's ordinary wSOL token account on L1, created here. MagicBlock projects the
    /// escrow into the rollup at this address, and the projection needs it to exist (found in M2).
    #[account(mut, address = get_associated_token_address(&table.key(), &mint.key()))]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the table's ephemeral token account, created by the Ephemeral SPL Token program.
    #[account(mut, seeds = [table.key().as_ref(), mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub escrow_eata: UncheckedAccount<'info>,
    /// CHECK: Ephemeral SPL Token program's delegation buffer for the escrow.
    #[account(mut, seeds = [b"buffer", escrow_eata.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub escrow_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", escrow_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", escrow_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub escrow_delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_table(ctx: Context<CreateTable>, table_id: u64, params: TableParams) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, PokerError::Paused);
    check_table_params(&params, config.max_buy_in)?;
    let t = &mut ctx.accounts.table;
    t.version = TABLE_VERSION;
    t.bump = ctx.bumps.table;
    t.status = STATUS_CREATED;
    t.max_seats = params.max_seats;
    t.seat_mask = 0;
    t.invite_only = params.invite_only;
    t.table_id = table_id;
    t.creator = ctx.accounts.creator.key();
    t.mint = ctx.accounts.mint.key();
    t.small_blind = params.small_blind;
    t.big_blind = params.big_blind;
    t.min_buy_in = params.min_buy_in;
    t.max_buy_in = params.max_buy_in;
    t.rake_bps = config.rake_bps;
    t.last_activity_ts = Clock::get()?.unix_timestamp;
    t.ledger_hash = [0; 32];
    t.ledger_seq = 0;
    t.reserved = [0; TABLE_RESERVED];

    let a = &ctx.accounts;
    // The table sponsors the rent of its rollup-only private accounts and their permissions.
    transfer(
        CpiContext::new(a.system_program.key(), Transfer { from: a.creator.to_account_info(), to: a.table.to_account_info() }),
        TABLE_SPONSOR_LAMPORTS,
    )?;
    associated_token::create_idempotent(CpiContext::new(
        a.associated_token_program.key(),
        associated_token::Create {
            payer: a.creator.to_account_info(),
            associated_token: a.escrow.to_account_info(),
            authority: a.table.to_account_info(),
            mint: a.mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
    ))?;
    invoke(
        &Instruction {
            program_id: ESPL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.escrow_eata.key(), false),
                AccountMeta::new(a.creator.key(), true),
                AccountMeta::new_readonly(a.table.key(), false),
                AccountMeta::new_readonly(a.mint.key(), false),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ],
            data: vec![ESPL_INIT_EPHEMERAL_ATA],
        },
        &[
            a.escrow_eata.to_account_info(),
            a.creator.to_account_info(),
            a.table.to_account_info(),
            a.mint.to_account_info(),
            a.system_program.to_account_info(),
            a.espl_program.to_account_info(),
        ],
    )?;
    let mut data = vec![ESPL_DELEGATE_EPHEMERAL_ATA];
    data.extend_from_slice(TEE_VALIDATOR.as_ref());
    invoke(
        &Instruction {
            program_id: ESPL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.creator.key(), true),
                AccountMeta::new(a.escrow_eata.key(), false),
                AccountMeta::new_readonly(ESPL_PROGRAM_ID, false),
                AccountMeta::new(a.escrow_buffer.key(), false),
                AccountMeta::new(a.escrow_delegation_record.key(), false),
                AccountMeta::new(a.escrow_delegation_metadata.key(), false),
                AccountMeta::new_readonly(DELEGATION_PROGRAM_ID, false),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ],
            data,
        },
        &[
            a.creator.to_account_info(),
            a.escrow_eata.to_account_info(),
            a.espl_program.to_account_info(),
            a.escrow_buffer.to_account_info(),
            a.escrow_delegation_record.to_account_info(),
            a.escrow_delegation_metadata.to_account_info(),
            a.delegation_program.to_account_info(),
            a.system_program.to_account_info(),
        ],
    )?;
    let t = &ctx.accounts.table;
    emit!(TableCreated { table: t.key(), table_id, creator: t.creator, mint: t.mint, max_buy_in: t.max_buy_in, rake_bps: t.rake_bps });
    Ok(())
}

/// Hands the table to the TEE validator (no other validator is accepted). A new table: creator
/// only. A table returned to L1 still open: anyone, so players are never stranded. The delegation
/// rent is paid by the table's escape payer PDA, which `payer` tops up; so re-delegating never moves
/// the escape-hatch role to whoever re-delegates.
#[delegate]
#[derive(Accounts)]
#[instruction(table_id: u64, creator: Pubkey)]
pub struct DelegateTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the table PDA; status and creator are checked against its data in the handler.
    #[account(mut, del, seeds = [TABLE_SEED, creator.as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA holding lamports only; this program signs for it.
    #[account(mut, seeds = [ESCAPE_PAYER_SEED, table.key().as_ref()], bump)]
    pub escape_payer: UncheckedAccount<'info>,
    /// CHECK: must be the TEE validator, so table state is only ever processed inside the enclave.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_table(ctx: Context<DelegateTable>, table_id: u64, creator: Pubkey) -> Result<()> {
    {
        let info = ctx.accounts.table.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, PokerError::TableNotOpen);
        let mut table = {
            let data = info.try_borrow_data()?;
            Table::try_deserialize(&mut &data[..])?
        };
        may_delegate(table.status, table.creator == ctx.accounts.payer.key())?;
        table.status = STATUS_OPEN;
        // Stamp the delegation time: the escape-hatch idle clock starts now.
        table.last_activity_ts = Clock::get()?.unix_timestamp;
        let mut data = info.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data[..];
        table.try_serialize(&mut cursor)?;
    }
    let a = &ctx.accounts;
    // Top up the escape payer, which pays the delegation program's rent below.
    let need = ESCAPE_PAYER_FLOAT.saturating_sub(a.escape_payer.lamports());
    if need > 0 {
        transfer(CpiContext::new(a.system_program.key(), Transfer { from: a.payer.to_account_info(), to: a.escape_payer.to_account_info() }), need)?;
    }
    // Same steps as the SDK's delegate_account, but with the escape payer PDA as rent payer.
    let table_key = a.table.key();
    let id = table_id.to_le_bytes();
    let table_bump = [ctx.bumps.table];
    let table_seeds: &[&[u8]] = &[TABLE_SEED, creator.as_ref(), &id, &table_bump];
    let payer_bump = [ctx.bumps.escape_payer];
    let payer_seeds: &[&[u8]] = &[ESCAPE_PAYER_SEED, table_key.as_ref(), &payer_bump];
    let buffer_bump = [ctx.bumps.buffer_table];
    let buffer_seeds: &[&[u8]] = &[DELEGATE_BUFFER_TAG, table_key.as_ref(), &buffer_bump];
    let table = a.table.to_account_info();
    let buffer = a.buffer_table.to_account_info();
    let escape_payer = a.escape_payer.to_account_info();
    let system = a.system_program.to_account_info();
    let data_len = table.data_len();
    create_pda(&buffer, &crate::ID, data_len, &[buffer_seeds, payer_seeds], &system, &escape_payer, false)?;
    {
        let src = table.try_borrow_data()?;
        buffer.try_borrow_mut_data()?.copy_from_slice(&src);
    }
    table.try_borrow_mut_data()?.fill(0);
    table.assign(&anchor_lang::solana_program::system_program::ID);
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::assign(&table_key, &DELEGATION_PROGRAM_ID),
        &[table.clone(), system.clone()],
        &[table_seeds],
    )?;
    cpi_delegate(
        &escape_payer,
        &table,
        &a.owner_program.to_account_info(),
        &buffer,
        &a.delegation_record_table.to_account_info(),
        &a.delegation_metadata_table.to_account_info(),
        &system,
        &[table_seeds, payer_seeds],
        DelegateAccountArgs {
            commit_frequency_ms: u32::MAX,
            seeds: vec![TABLE_SEED.to_vec(), creator.as_ref().to_vec(), id.to_vec()],
            validator: Some(TEE_VALIDATOR),
        },
    )?;
    close_pda_with_system_transfer(&buffer, &[buffer_seeds], &escape_payer, &system)?;
    Ok(())
}

/// Step one of the emergency escape hatch: ask the delegation program to return the table. The
/// validator is expected to commit and undelegate; if it doesn't within the timeout (9,000 slots
/// on dlp 3.1.0), anyone can call `rollback_table`. Anyone may file the request: the rent payer the
/// delegation program checks is the table's escape payer PDA, signed for by this program. To stop
/// anyone pulling a busy table out from under its players, the table's L1 copy must have been idle
/// for the config's escape delay.
#[derive(Accounts)]
#[instruction(table_id: u64, creator: Pubkey)]
pub struct RequestTableUndelegation<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated table PDA (owned by the delegation program; data = last commit).
    #[account(seeds = [TABLE_SEED, creator.as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    /// CHECK: the table's escape payer, recorded as rent payer; this program signs for it.
    #[account(mut, seeds = [ESCAPE_PAYER_SEED, table.key().as_ref()], bump)]
    pub escape_payer: UncheckedAccount<'info>,
    /// CHECK: this program, passed to the delegation program as the owner.
    #[account(address = crate::ID)]
    pub owner_program: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"undelegation-request", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub undelegation_request: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(seeds = [b"delegation", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn request_table_undelegation(ctx: Context<RequestTableUndelegation>, table_id: u64, creator: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    {
        let data = a.table.try_borrow_data()?;
        let t = Table::try_deserialize(&mut &data[..])?;
        may_request_escape(t.last_activity_ts, Clock::get()?.unix_timestamp, a.config.escape_idle_secs())?;
    }
    let ix = Instruction {
        program_id: DELEGATION_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(a.escape_payer.key(), true),
            AccountMeta::new_readonly(a.table.key(), true),
            AccountMeta::new_readonly(crate::ID, false),
            AccountMeta::new(a.undelegation_request.key(), false),
            AccountMeta::new_readonly(a.delegation_record.key(), false),
            AccountMeta::new(a.delegation_metadata.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
        ],
        data: DLP_REQUEST_UNDELEGATION.to_le_bytes().to_vec(),
    };
    let id = table_id.to_le_bytes();
    let bump = [ctx.bumps.table];
    let table_key = a.table.key();
    let payer_bump = [ctx.bumps.escape_payer];
    invoke_signed(
        &ix,
        &[
            a.escape_payer.to_account_info(),
            a.table.to_account_info(),
            a.owner_program.to_account_info(),
            a.undelegation_request.to_account_info(),
            a.delegation_record.to_account_info(),
            a.delegation_metadata.to_account_info(),
            a.system_program.to_account_info(),
            a.delegation_program.to_account_info(),
        ],
        &[&[TABLE_SEED, creator.as_ref(), &id, &bump], &[ESCAPE_PAYER_SEED, table_key.as_ref(), &payer_bump]],
    )?;
    emit!(TableUndelegationRequested { table: a.table.key(), table_id });
    Ok(())
}

/// Step two of the escape hatch, permissionless: after the request times out, take the table back
/// with its last state committed to L1 (anything newer inside the rollup is lost). Follows
/// MagicBlock's reference wrapper: keep the data, let the delegation program release the account,
/// then write the data back.
#[derive(Accounts)]
#[instruction(table_id: u64, creator: Pubkey)]
pub struct RollbackTable<'info> {
    /// CHECK: delegated table PDA, signed for by this program.
    #[account(mut, seeds = [TABLE_SEED, creator.as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    /// CHECK: this program, passed to the delegation program as the owner.
    #[account(address = crate::ID)]
    pub owner_program: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"undelegation-request", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub undelegation_request: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: the table's escape payer, which the delegation program recorded as rent payer.
    #[account(mut, seeds = [ESCAPE_PAYER_SEED, table.key().as_ref()], bump)]
    pub delegation_rent_payer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA (only used if a commit was left half-finished)
    #[account(mut, seeds = [b"state-diff", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub commit_state: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA (only used if a commit was left half-finished)
    #[account(mut, seeds = [b"commit-state-record", table.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub commit_record: UncheckedAccount<'info>,
    /// CHECK: refund target for a half-finished commit; the delegation program checks it.
    #[account(mut)]
    pub commit_reimbursement: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
}

pub fn rollback_table(ctx: Context<RollbackTable>, table_id: u64, creator: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    let table_info = a.table.to_account_info();
    let saved = table_info.try_borrow_data()?.to_vec();
    let ix = Instruction {
        program_id: DELEGATION_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(a.table.key(), true),
            AccountMeta::new_readonly(crate::ID, false),
            AccountMeta::new(a.undelegation_request.key(), false),
            AccountMeta::new(a.delegation_record.key(), false),
            AccountMeta::new(a.delegation_metadata.key(), false),
            AccountMeta::new(a.delegation_rent_payer.key(), false),
            AccountMeta::new(a.commit_state.key(), false),
            AccountMeta::new(a.commit_record.key(), false),
            AccountMeta::new(a.commit_reimbursement.key(), false),
        ],
        data: DLP_UNDELEGATE_WITH_ROLLBACK_AFTER_TIMEOUT.to_le_bytes().to_vec(),
    };
    let id = table_id.to_le_bytes();
    let bump = [ctx.bumps.table];
    invoke_signed(
        &ix,
        &[
            table_info.clone(),
            a.owner_program.to_account_info(),
            a.undelegation_request.to_account_info(),
            a.delegation_record.to_account_info(),
            a.delegation_metadata.to_account_info(),
            a.delegation_rent_payer.to_account_info(),
            a.commit_state.to_account_info(),
            a.commit_record.to_account_info(),
            a.commit_reimbursement.to_account_info(),
            a.delegation_program.to_account_info(),
        ],
        &[&[TABLE_SEED, creator.as_ref(), &id, &bump]],
    )?;
    require_keys_eq!(*table_info.owner, crate::ID, PokerError::RollbackFailed);
    table_info.resize(saved.len())?;
    table_info.try_borrow_mut_data()?.copy_from_slice(&saved);
    emit!(TableRolledBack { table: a.table.key(), table_id });
    Ok(())
}

/// Sets the invite list of an invite-only table (L1, creator only, any time; the rollup reads a
/// copy). Clients send sha256(table || wallet), never wallets, so the list stays unreadable even in
/// the transaction data.
#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct SetInvites<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the table's address, derived from the creator; not loaded (it may be delegated).
    #[account(seeds = [TABLE_SEED, creator.key().as_ref(), &table_id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = creator, space = 8 + Invites::INIT_SPACE, seeds = [INVITES_SEED, table.key().as_ref()], bump)]
    pub invites: Account<'info, Invites>,
    pub system_program: Program<'info, System>,
}

pub fn set_invites(ctx: Context<SetInvites>, _table_id: u64, hashes: Vec<[u8; 32]>) -> Result<()> {
    require!(hashes.len() <= MAX_INVITES, PokerError::TooManyInvites);
    let inv = &mut ctx.accounts.invites;
    inv.table = ctx.accounts.table.key();
    inv.count = hashes.len() as u8;
    inv.hashes = [[0; 32]; MAX_INVITES];
    inv.hashes[..hashes.len()].copy_from_slice(&hashes);
    Ok(())
}

#[event]
pub struct TableCreated {
    pub table: Pubkey,
    pub table_id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub max_buy_in: u64,
    pub rake_bps: u16,
}

#[event]
pub struct TableUndelegationRequested {
    pub table: Pubkey,
    pub table_id: u64,
}

#[event]
pub struct TableRolledBack {
    pub table: Pubkey,
    pub table_id: u64,
}
