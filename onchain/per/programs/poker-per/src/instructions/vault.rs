//! M9: the game vault and play keys, so the player's wallet (Phantom) only ever signs Solana
//! transactions it can preview.
//!
//! Wallets preview a transaction by simulating it on Solana. Rollup transactions can't be simulated
//! there (the table belongs to the delegation program on L1), so the wallet warns that the
//! transaction is unsafe. With these instructions the wallet signs only:
//! - on L1: `open_vault` and MagicBlock's deposit and withdrawal (all simulate cleanly);
//! - a plain message that authorizes a browser-held play key until a time.
//!
//! The vault is a per-wallet PDA that owns a wSOL token account. MagicBlock's deposit can put money
//! straight into that account in the rollup (its merge takes any destination token account). Inside
//! the rollup, a play key carrying the wallet's signed message can buy in from the vault, cash a
//! seat out into it, and withdraw from it, but only ever to that same wallet's own token account.
//! The table key (the seat's reader) can cash its own seat out into the vault too, so leaving a table
//! needs no wallet at all.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed, set_return_data};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID};
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, TEE_VALIDATOR};
use crate::errors::PokerError;
use crate::instructions::money::*;
use crate::instructions::money::{buy_in_flow, cash_out_flow, close_flow, MAGIC_FEE_VAULT_SEED};
use crate::instructions::table::{DELEGATION_PROGRAM_ID, ESPL_PROGRAM_ID};
use crate::private::{write, Sponsor};
use crate::state::Config;
use crate::table::{
    invite_admits, rake_for, Hand, Ledger, PrivateInvites, Seat, Table, DECK_SEED, HAND_IDLE, HAND_SEED, LEDGER_SEED,
    INVITES_SEED, LOG_SEED, MAX_INVITES, PRIVATE_INVITES_SEED, RECORD_SEED, STATUS_CLOSED, STATUS_OPEN, TABLE_SEED, WSOL_MINT,
};

pub const VAULT_SEED: &[u8] = b"vault";
/// A play key's authorization lasts at most this long (the client asks for 7 days).
pub const MAX_PLAY_KEY_SECS: i64 = 30 * 24 * 60 * 60;
/// A table counts as abandoned (anyone may close it) after this many escape delays empty and idle.
pub const ABANDONED_ESCAPE_DELAYS: i64 = 6;
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const ESPL_INIT_EPHEMERAL_ATA: u8 = 0;
const ESPL_DELEGATE_EPHEMERAL_ATA: u8 = 4;
const ESPL_CREATE_EPHEMERAL_ATA_PERMISSION: u8 = 6;
const ESPL_DELEGATE_EPHEMERAL_ATA_PERMISSION: u8 = 7;
/// Permission program `UpdatePermission` with no member list: public (see create_table).
const PERMISSION_UPDATE_PUBLIC: [u8; 9] = [1, 0, 0, 0, 0, 0, 0, 0, 0];

/// The exact text the wallet signs to authorize a play key. Wallets show it as is, so it says in plain
/// words what it allows; the program rebuilds it byte for byte. It doesn't name the wallet: the
/// signature check's public key is the wallet (and play-key transactions are close to Solana's size
/// limit, so every byte counts).
pub fn play_key_message(key: &Pubkey, expires: i64) -> String {
    format!(
        "Nomad Poker private tables
Allow play key {} to use my game balance until {} (unix time). It can buy in to tables (where chips can be lost), leave them, and send money only back to this wallet.",
        key, expires
    )
}

/// Checks that the instruction right before this one is Solana's Ed25519 signature check of
/// `play_key_message(key, expires)` by `wallet`, and that `expires` is in the window. The
/// runtime has already verified that signature, or the transaction wouldn't run.
pub fn verify_play_key(instructions: &AccountInfo, wallet: &Pubkey, key: &Pubkey, expires: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expires > now && expires <= now.saturating_add(MAX_PLAY_KEY_SECS), PokerError::PlayKeyExpired);
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, PokerError::BadPlayKeyProof);
    let ix = load_instruction_at_checked(current as usize - 1, instructions)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, PokerError::BadPlayKeyProof);
    let d = &ix.data;
    // One signature; offsets refer to this same instruction (index u16::MAX).
    require!(d.len() >= 16 && d[0] == 1, PokerError::BadPlayKeyProof);
    let u = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (pk_off, msg_off, msg_len) = (u(6), u(10), u(12));
    require!(u(4) == u16::MAX as usize && u(8) == u16::MAX as usize && u(14) == u16::MAX as usize, PokerError::BadPlayKeyProof);
    let pk = d.get(pk_off..pk_off + 32).ok_or(PokerError::BadPlayKeyProof)?;
    require!(pk == wallet.as_ref(), PokerError::BadPlayKeyProof);
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(PokerError::BadPlayKeyProof)?;
    require!(msg == play_key_message(key, expires).as_bytes(), PokerError::BadPlayKeyProof);
    Ok(())
}

// ---------------------------------------------------------------------------------------- L1: open

/// Creates the wallet's game vault: the vault's wSOL token account on L1, its ephemeral token account
/// delegated to the TEE (so MagicBlock projects it into the rollup), and that account's permission,
/// claimed, made public and delegated, exactly as `create_table` does for a table's escrow (M3: anyone
/// can otherwise attach a private permission nobody can log in as, which blocks every transfer).
/// The wallet signs and pays the rent; it previews cleanly in a wallet. Idempotent.
#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    /// CHECK: the vault PDA; holds nothing itself, only owns the token account.
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL only.
    #[account(address = WSOL_MINT @ PokerError::UnsupportedMint)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault's wSOL token account on L1, created here.
    #[account(mut, address = get_associated_token_address(&vault.key(), &mint.key()))]
    pub vault_token: UncheckedAccount<'info>,
    /// CHECK: the vault's ephemeral token account (Ephemeral SPL Token PDA).
    #[account(mut, seeds = [vault.key().as_ref(), mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub vault_eata: UncheckedAccount<'info>,
    /// CHECK: Ephemeral SPL Token program's delegation buffer.
    #[account(mut, seeds = [b"buffer", vault_eata.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub vault_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", vault_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub vault_delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", vault_eata.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub vault_delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: the vault account's permission, created public here.
    #[account(mut, seeds = [PERMISSION_SEED, vault_eata.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub vault_permission: UncheckedAccount<'info>,
    /// CHECK: permission program's delegation buffer.
    #[account(mut, seeds = [b"buffer", vault_permission.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub vault_permission_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation", vault_permission.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub vault_permission_delegation_record: UncheckedAccount<'info>,
    /// CHECK: delegation program PDA
    #[account(mut, seeds = [b"delegation-metadata", vault_permission.key().as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub vault_permission_delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: the TEE validator, the only one the vault is delegated to.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    associated_token::create_idempotent(CpiContext::new(
        a.associated_token_program.key(),
        associated_token::Create {
            payer: a.wallet.to_account_info(),
            associated_token: a.vault_token.to_account_info(),
            authority: a.vault.to_account_info(),
            mint: a.mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
    ))?;
    // Same order as create_table: create, delegate, then claim the permission. Each step is skipped
    // if it's done already, so calling this again is harmless.
    if a.vault_eata.data_is_empty() {
        invoke(
            &Instruction {
                program_id: ESPL_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(a.vault_eata.key(), false),
                    AccountMeta::new(a.wallet.key(), true),
                    AccountMeta::new_readonly(a.vault.key(), false),
                    AccountMeta::new_readonly(a.mint.key(), false),
                    AccountMeta::new_readonly(a.system_program.key(), false),
                ],
                data: vec![ESPL_INIT_EPHEMERAL_ATA],
            },
            &[a.vault_eata.to_account_info(), a.wallet.to_account_info(), a.vault.to_account_info(), a.mint.to_account_info(), a.system_program.to_account_info(), a.espl_program.to_account_info()],
        )?;
    }
    if *a.vault_eata.owner != DELEGATION_PROGRAM_ID {
        delegate_vault_eata(&ctx)?;
    }
    claim_vault_permission(&ctx)?;
    // An outsider can get in first (M9 review): delegate the vault's token account or its permission to
    // another validator, or delegate the permission while it's still private. Then the vault would take
    // deposits it can never pay out, so refuse to open it: the wallet's preview fails and no money moves.
    let a = &ctx.accounts;
    let to_tee = |record: &UncheckedAccount| -> Result<bool> { Ok(record.try_borrow_data()?.get(8..40) == Some(TEE_VALIDATOR.as_ref())) };
    let public = a.vault_permission.try_borrow_data()?.get(34) == Some(&0);
    require!(to_tee(&a.vault_delegation_record)? && to_tee(&a.vault_permission_delegation_record)? && public, PokerError::VaultBlocked);
    emit!(VaultOpened { vault: a.vault.key() });
    Ok(())
}

fn delegate_vault_eata(ctx: &Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    let mut data = vec![ESPL_DELEGATE_EPHEMERAL_ATA];
    data.extend_from_slice(TEE_VALIDATOR.as_ref());
    invoke(
        &Instruction {
            program_id: ESPL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.wallet.key(), true),
                AccountMeta::new(a.vault_eata.key(), false),
                AccountMeta::new_readonly(ESPL_PROGRAM_ID, false),
                AccountMeta::new(a.vault_buffer.key(), false),
                AccountMeta::new(a.vault_delegation_record.key(), false),
                AccountMeta::new(a.vault_delegation_metadata.key(), false),
                AccountMeta::new_readonly(DELEGATION_PROGRAM_ID, false),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ],
            data,
        },
        &[
            a.wallet.to_account_info(),
            a.vault_eata.to_account_info(),
            a.espl_program.to_account_info(),
            a.vault_buffer.to_account_info(),
            a.vault_delegation_record.to_account_info(),
            a.vault_delegation_metadata.to_account_info(),
            a.delegation_program.to_account_info(),
            a.system_program.to_account_info(),
        ],
    )?;
    Ok(())
}

/// Create (flags 0: the vault PDA becomes the authority member), make public (the vault signs),
/// delegate to the TEE. An outsider may have created the permission first (anyone can, with flags 0):
/// the vault is still its authority member then, so it's made public and delegated all the same. Once
/// delegated (by us, or by an outsider first) it can't be changed from L1; see the M9 proof's limits.
fn claim_vault_permission(ctx: &Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    if *a.vault_permission.owner == DELEGATION_PROGRAM_ID {
        return Ok(());
    }
    if a.vault_permission.data_is_empty() {
        create_vault_permission(ctx)?;
    }
    // Byte 34 is the member list's Option tag; 0 means public already.
    let is_public = a.vault_permission.try_borrow_data()?.get(34) == Some(&0);
    if !is_public {
        make_vault_permission_public(ctx)?;
    }
    delegate_vault_permission(ctx)
}

fn create_vault_permission(ctx: &Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    invoke(
        &Instruction {
            program_id: ESPL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.vault_eata.key(), false),
                AccountMeta::new(a.vault_permission.key(), false),
                AccountMeta::new(a.wallet.key(), true),
                AccountMeta::new_readonly(a.system_program.key(), false),
                AccountMeta::new_readonly(PERMISSION_PROGRAM_ID, false),
            ],
            data: vec![ESPL_CREATE_EPHEMERAL_ATA_PERMISSION, 0],
        },
        &[a.vault_eata.to_account_info(), a.vault_permission.to_account_info(), a.wallet.to_account_info(), a.system_program.to_account_info(), a.permission_program.to_account_info(), a.espl_program.to_account_info()],
    )?;
    Ok(())
}

fn make_vault_permission_public(ctx: &Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    let wallet = a.wallet.key();
    let bump = [ctx.bumps.vault];
    invoke_signed(
        &Instruction {
            program_id: PERMISSION_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.vault.key(), true),
                AccountMeta::new_readonly(a.vault_eata.key(), false),
                AccountMeta::new(a.vault_permission.key(), false),
            ],
            data: PERMISSION_UPDATE_PUBLIC.to_vec(),
        },
        &[a.vault.to_account_info(), a.vault_eata.to_account_info(), a.vault_permission.to_account_info(), a.permission_program.to_account_info()],
        &[&[VAULT_SEED, wallet.as_ref(), &bump]],
    )?;
    Ok(())
}

fn delegate_vault_permission(ctx: &Context<OpenVault>) -> Result<()> {
    let a = &ctx.accounts;
    invoke(
        &Instruction {
            program_id: ESPL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.wallet.key(), true),
                AccountMeta::new(a.vault_eata.key(), false),
                AccountMeta::new_readonly(PERMISSION_PROGRAM_ID, false),
                AccountMeta::new(a.vault_permission.key(), false),
                AccountMeta::new_readonly(a.system_program.key(), false),
                AccountMeta::new(a.vault_permission_buffer.key(), false),
                AccountMeta::new(a.vault_permission_delegation_record.key(), false),
                AccountMeta::new(a.vault_permission_delegation_metadata.key(), false),
                AccountMeta::new_readonly(DELEGATION_PROGRAM_ID, false),
                AccountMeta::new_readonly(a.validator.key(), false),
            ],
            data: vec![ESPL_DELEGATE_EPHEMERAL_ATA_PERMISSION],
        },
        &[
            a.wallet.to_account_info(),
            a.vault_eata.to_account_info(),
            a.permission_program.to_account_info(),
            a.vault_permission.to_account_info(),
            a.system_program.to_account_info(),
            a.vault_permission_buffer.to_account_info(),
            a.vault_permission_delegation_record.to_account_info(),
            a.vault_permission_delegation_metadata.to_account_info(),
            a.delegation_program.to_account_info(),
            a.validator.to_account_info(),
            a.espl_program.to_account_info(),
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------- rollup: buy-in

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct VaultBuyIn<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`; checked against the signed message.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA (signs the transfer).
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &table.mint))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
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
    /// CHECK: the table's invite list (see `BuyIn::invites`); checked in `invite_admits`.
    pub invites: Option<UncheckedAccount<'info>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// `buy_in` paid from the wallet's game vault, signed by a play key the wallet authorized. The seat
/// belongs to the wallet, exactly as if the wallet had signed.
pub fn vault_buy_in(ctx: Context<VaultBuyIn>, seat: u8, amount: u64, reader: Pubkey, expires: i64) -> Result<()> {
    vault_buy_in_with(ctx, seat, amount, reader, expires, None)
}

/// `vault_buy_in` at an invite-only table with the secret code from the table's invite link (M9c), for
/// a wallet that isn't on the table's invite list. The code is checked against the table's private
/// invite list; the TEE withholds this transaction, so the code stays secret.
pub fn vault_buy_in_code(ctx: Context<VaultBuyIn>, seat: u8, amount: u64, reader: Pubkey, expires: i64, code: [u8; 16]) -> Result<()> {
    vault_buy_in_with(ctx, seat, amount, reader, expires, Some(&code))
}

fn vault_buy_in_with(ctx: Context<VaultBuyIn>, seat: u8, amount: u64, reader: Pubkey, expires: i64, code: Option<&[u8; 16]>) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    verify_play_key(&ctx.accounts.instructions, &wallet, &ctx.accounts.play_key.key(), expires)?;
    let vault_bump = [ctx.bumps.vault];
    buy_in_flow!(ctx, seat, amount, reader, wallet, code, token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer { from: ctx.accounts.vault_token.to_account_info(), to: ctx.accounts.escrow.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
            &[&[VAULT_SEED, wallet.as_ref(), &vault_bump]],
        ),
        amount,
    )?)
}

// ---------------------------------------------------------------------------------------- rollup: cash-out

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct VaultCashOut<'info> {
    /// The seat's table key (its reader), or a play key of the seat's wallet.
    pub signer: Signer<'info>,
    /// CHECK: the seat's wallet (checked against the ledger).
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA.
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &table.mint))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar (used when a play key signs).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
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
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// `cash_out` into the seat wallet's game vault. Signed by the seat's table key (`expires` is then
/// ignored), or by a play key of that wallet with its signed message, which also covers a lost table
/// key. The money can only go to the seat's own wallet's vault.
pub fn vault_cash_out(ctx: Context<VaultCashOut>, seat: u8, expires: i64) -> Result<()> {
    let (signer, wallet) = (ctx.accounts.signer.key(), ctx.accounts.wallet.key());
    let wallet_vouched = if expires != 0 { verify_play_key(&ctx.accounts.instructions, &wallet, &signer, expires).is_ok() } else { false };
    cash_out_flow!(ctx, seat, |p: Pubkey, reader: Pubkey| -> Result<()> {
        require_keys_eq!(p, wallet, PokerError::NotSeated);
        require!(signer == reader || wallet_vouched, PokerError::NotSeatKey);
        Ok(())
    }, vault_token)
}

// ---------------------------------------------------------------------------------------- rollup: withdraw, balance

#[derive(Accounts)]
pub struct VaultWithdraw<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`; the only possible recipient.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA (signs the transfer).
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&vault.key(), &WSOL_MINT))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// The wallet's own wSOL account in the rollup; MagicBlock's withdrawal takes it to Solana.
    #[account(mut, address = get_associated_token_address(&wallet.key(), &WSOL_MINT))]
    pub wallet_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: Magic program, executable only inside the rollup.
    #[account(address = MAGIC_PROGRAM_ID, constraint = magic_program.executable @ PokerError::NotInRollup)]
    pub magic_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Moves `amount` from the game vault to the wallet's own rollup balance, ready for MagicBlock's
/// withdrawal to Solana (which the wallet signs on L1).
pub fn vault_withdraw(ctx: Context<VaultWithdraw>, amount: u64, expires: i64) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    verify_play_key(&ctx.accounts.instructions, &wallet, &ctx.accounts.play_key.key(), expires)?;
    require!(amount > 0, PokerError::NothingToCollect);
    let bump = [ctx.bumps.vault];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer { from: ctx.accounts.vault_token.to_account_info(), to: ctx.accounts.wallet_token.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
            &[&[VAULT_SEED, wallet.as_ref(), &bump]],
        ),
        amount,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct VaultBalance<'info> {
    pub play_key: Signer<'info>,
    /// CHECK: the wallet that authorized `play_key`.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's vault PDA.
    #[account(seeds = [VAULT_SEED, wallet.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(address = get_associated_token_address(&vault.key(), &WSOL_MINT))]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, for the wallet's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// The vault's balance as return data (u64 LE), for the client to simulate. The rollup's RPC shows a
/// token balance only to its owner, and nobody can log in as the vault.
pub fn vault_balance(ctx: Context<VaultBalance>, expires: i64) -> Result<()> {
    verify_play_key(&ctx.accounts.instructions, &ctx.accounts.wallet.key(), &ctx.accounts.play_key.key(), expires)?;
    set_return_data(&ctx.accounts.vault_token.amount.to_le_bytes());
    Ok(())
}

// ---------------------------------------------------------------------------------------- rollup: closing a hosted table (M9b)

#[commit]
#[derive(Accounts)]
pub struct CloseTableKeyed<'info> {
    /// The creator's play key (with `expires`), or anyone once the table is abandoned (`expires` 0).
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger; its readers are removed here.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: deck PDA; kept, its contents erased.
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump)]
    pub deck: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// The creator's game vault account: receives any leftover in the escrow. Optional (a creator
    /// without a game balance leaves the leftover in the escrow).
    #[account(mut, address = get_associated_token_address(
        &Pubkey::find_program_address(&[VAULT_SEED, table.creator.as_ref()], &crate::ID).0, &table.mint))]
    pub creator_vault_token: Option<Box<Account<'info, TokenAccount>>>,
    /// The dev wallet's token account: unpaid rake is collected into it first. Needed only when there
    /// is unpaid rake.
    #[account(mut, token::mint = table.mint, token::authority = config.dev_wallet)]
    pub dev_token: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: public hand record PDA; closed here.
    #[account(mut, seeds = [RECORD_SEED, table.key().as_ref()], bump)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: hand log PDA; kept.
    #[account(mut, seeds = [LOG_SEED, table.key().as_ref()], bump)]
    pub log: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand log; its readers are removed here.
    #[account(mut, seeds = [PERMISSION_SEED, log.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub log_permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's rent vault for rollup-only accounts.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: the TEE validator's magic fee vault; the table pays its own commit (see `commit_table`).
    #[account(mut, seeds = [MAGIC_FEE_VAULT_SEED, TEE_VALIDATOR.as_ref()], bump, seeds::program = crate::instructions::table::DELEGATION_PROGRAM_ID)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar (used when a play key signs).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// `close_table` without the creator's wallet in the rollup (M9b). Signed by the creator's play key
/// (its signed message, `expires` set), or by anyone once the table has been empty and idle for
/// ABANDONED_ESCAPE_DELAYS escape delays (`expires` 0; the backend's keeper closes abandoned tables
/// this way). Unpaid
/// rake goes to the dev wallet first; any leftover goes to the creator's game balance. The table pays
/// the commit, so the signer needs no SOL in the rollup. The creator reclaims the rent on L1 as usual.
pub fn close_table_keyed(ctx: Context<CloseTableKeyed>, expires: i64) -> Result<()> {
    let creator = ctx.accounts.table.creator;
    if expires != 0 {
        verify_play_key(&ctx.accounts.instructions, &creator, &ctx.accounts.signer.key(), expires)?;
    } else {
        // Abandoned: empty for ABANDONED_ESCAPE_DELAYS escape delays (6 hours by default), so a table
        // waiting for players isn't closed under its host. Unlike the escape hatch, a timestamp from the
        // future (a rollup clock behind Solana's) counts as active, not idle (M9b review).
        require!(ctx.accounts.table.seat_mask == 0, PokerError::TableNotEmpty);
        let (now, last) = (Clock::get()?.unix_timestamp, ctx.accounts.table.last_activity_ts);
        let idle = ctx.accounts.config.escape_idle_secs().saturating_mul(ABANDONED_ESCAPE_DELAYS);
        require!(now >= last && now - last >= idle, PokerError::TableActive);
    }
    let rake = ctx.accounts.ledger.rake_accrued;
    if rake > 0 {
        let dev = ctx.accounts.dev_token.as_ref().ok_or(PokerError::NothingToCollect)?;
        pay_from_escrow(&ctx.accounts.escrow, dev, &ctx.accounts.table, &ctx.accounts.token_program, rake)?;
        let ledger = &mut ctx.accounts.ledger;
        ledger.rake_accrued = 0;
        ledger.escrow_owed = ledger.escrow_owed.checked_sub(rake).ok_or(PokerError::MathOverflow)?;
        ledger.total_rake_collected = ledger.total_rake_collected.checked_add(rake).ok_or(PokerError::MathOverflow)?;
        // As collect_rake: check the escrow covers the ledger, then record the new fingerprint.
        let fp = settle_check(&mut ctx.accounts.escrow, &mut ctx.accounts.ledger)?;
        stamp(&mut ctx.accounts.table, fp)?;
        emit!(RakeCollected { table: ctx.accounts.table.key(), amount: rake, dev_wallet: ctx.accounts.config.dev_wallet });
    }
    close_flow!(ctx, creator_vault_token, {
        let t = &ctx.accounts.table;
        let (id, bump) = (t.table_id.to_le_bytes(), [t.bump]);
        let ts = table_seeds(t, &id, &bump);
        MagicIntentBundleBuilder::new(
            ctx.accounts.table.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.table.to_account_info()])
        .build_and_invoke_signed(&[&ts])?
    })
}

// ---------------------------------------------------------------------------------------- rollup: private invites (M9c)

#[derive(Accounts)]
pub struct SetInvitesKeyed<'info> {
    /// The creator's play key.
    pub play_key: Signer<'info>,
    /// The table sponsors the private list's rent in the rollup.
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: the table's rollup-only private invite list, created here the first time.
    #[account(mut, seeds = [PRIVATE_INVITES_SEED, table.key().as_ref()], bump)]
    pub invites: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the invite list (no readers, ever).
    #[account(mut, seeds = [PERMISSION_SEED, invites.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub invites_permission: UncheckedAccount<'info>,
    /// CHECK: the table's pre-M9c L1 invite list (the rollup's copy); must not exist, so a table never has
    /// two lists and an old one can't keep admitting wallets the private list dropped (M9c review).
    #[account(seeds = [INVITES_SEED, table.key().as_ref()], bump)]
    pub legacy_invites: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, for the creator's signature check.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

/// Sets an open table's private invite list (M9c), signed by the creator's play key: no wallet prompt and
/// no L1 rent. `hashes` (16-byte `private_invite_hash`es) replaces the wallet list and `code_hash`
/// (`invite_code_hash` of the invite link's code, zeros = no link) replaces the link; `None` keeps
/// either as it is. The list has no readers, and the TEE withholds every transaction that touches it.
pub fn set_invites_keyed(ctx: Context<SetInvitesKeyed>, expires: i64, hashes: Option<Vec<[u8; 16]>>, code_hash: Option<[u8; 32]>) -> Result<()> {
    let a = &ctx.accounts;
    verify_play_key(&a.instructions, &a.table.creator, &a.play_key.key(), expires)?;
    require!(a.table.status == STATUS_OPEN, PokerError::TableNotOpen);
    if let Some(h) = &hashes {
        require!(h.len() <= MAX_INVITES, PokerError::TooManyInvites);
    }
    require!(a.legacy_invites.data_is_empty(), PokerError::OldInviteList);
    let table_key = a.table.key();
    let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
    let ts = table_seeds(&a.table, &id, &bump);
    let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
    let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
    let inv_bump = [ctx.bumps.invites];
    let inv_seeds: &[&[u8]] = &[PRIVATE_INVITES_SEED, table_key.as_ref(), &inv_bump];
    let info = a.invites.to_account_info();
    let mut inv = if info.data_is_empty() {
        // The first call only creates the list and its permission. The TEE withholds a transaction
        // because it touches a permissioned account; this one's account has no permission yet when it
        // arrives, so it must carry no list and no link (M9c review).
        require!(hashes.is_none() && code_hash.is_none(), PokerError::InvitesNotReady);
        sp.create_account(&info, inv_seeds, 8 + PrivateInvites::INIT_SPACE)?;
        PrivateInvites { table: table_key, count: 0, hashes: [[0; 16]; MAX_INVITES], code_hash: [0; 32] }
    } else {
        let data = info.try_borrow_data()?;
        PrivateInvites::try_deserialize(&mut &data[..])?
    };
    sp.create_permission(&info, inv_seeds, &a.invites_permission.to_account_info(), &[])?;
    if let Some(h) = hashes {
        inv.count = h.len() as u8;
        inv.hashes = [[0; 16]; MAX_INVITES];
        inv.hashes[..h.len()].copy_from_slice(&h);
    }
    if let Some(c) = code_hash {
        inv.code_hash = c;
    }
    write(&info, &inv)?;
    Ok(())
}

#[event]
pub struct VaultOpened {
    pub vault: Pubkey,
}
