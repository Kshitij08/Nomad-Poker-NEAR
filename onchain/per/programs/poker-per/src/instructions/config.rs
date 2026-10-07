use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::{CONFIG_SEED, CONFIG_VERSION};
use crate::errors::PokerError;
use crate::program::PokerPer;
use crate::state::{check_settings, Config, ConfigV1, CONFIG_RESERVED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigArgs {
    pub dev_wallet: Pubkey,
    pub rake_bps: u16,
    pub max_buy_in: u64,
    pub paused: bool,
    /// 0 = default (1 hour).
    pub escape_idle_secs: u32,
}

/// Creates the config. Only the program's upgrade authority may call it, so nobody can front-run
/// the first initialization with their own admin key.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, PokerPer>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ PokerError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
    check_settings(&args.dev_wallet, args.rake_bps, args.max_buy_in, args.escape_idle_secs)?;
    let config = &mut ctx.accounts.config;
    config.version = CONFIG_VERSION;
    config.bump = ctx.bumps.config;
    config.admin = ctx.accounts.authority.key();
    config.pending_admin = None;
    config.dev_wallet = args.dev_wallet;
    config.rake_bps = args.rake_bps;
    config.max_buy_in = args.max_buy_in;
    config.paused = args.paused;
    config.escape_idle_secs = args.escape_idle_secs;
    config.reserved = [0; CONFIG_RESERVED];
    emit_changed(config);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ PokerError::NotAdmin,
        constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated,
    )]
    pub config: Account<'info, Config>,
}

pub fn update_config(ctx: Context<AdminOnly>, args: ConfigArgs) -> Result<()> {
    check_settings(&args.dev_wallet, args.rake_bps, args.max_buy_in, args.escape_idle_secs)?;
    let config = &mut ctx.accounts.config;
    config.dev_wallet = args.dev_wallet;
    config.rake_bps = args.rake_bps;
    config.max_buy_in = args.max_buy_in;
    config.paused = args.paused;
    config.escape_idle_secs = args.escape_idle_secs;
    emit_changed(config);
    Ok(())
}

/// Step one of an admin handover. Passing `None` cancels a pending proposal.
pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Option<Pubkey>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = new_admin;
    emit!(AdminProposed { admin: config.admin, pending_admin: new_admin });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated,
    )]
    pub config: Account<'info, Config>,
}

/// Step two: the proposed key signs to take over, so a typo can never lock the program out.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let pending = config.pending_admin.ok_or(PokerError::NoPendingAdmin)?;
    require_keys_eq!(pending, ctx.accounts.new_admin.key(), PokerError::NotPendingAdmin);
    let previous = config.admin;
    config.admin = pending;
    config.pending_admin = None;
    emit!(AdminChanged { previous_admin: previous, admin: pending });
    Ok(())
}

/// Upgrades a v1 config (no reserved tail) to the current layout in place. Admin only. The admin
/// pays any extra rent.
#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: old layout, so it cannot be loaded as `Account<Config>`. Seeds, owner, discriminator,
    /// version and admin are all checked in the handler.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
    let info = ctx.accounts.config.to_account_info();
    require_keys_eq!(*info.owner, crate::ID, ErrorCode::AccountOwnedByWrongProgram);
    let old: ConfigV1 = {
        let data = info.try_borrow_data()?;
        require!(data.len() >= 8 && data[..8] == *Config::DISCRIMINATOR, ErrorCode::AccountDiscriminatorMismatch);
        require!(data[8] < CONFIG_VERSION, PokerError::AlreadyMigrated);
        ConfigV1::deserialize(&mut &data[8..])?
    };
    require_keys_eq!(old.admin, ctx.accounts.admin.key(), PokerError::NotAdmin);

    let new_len = 8 + Config::INIT_SPACE;
    let needed = Rent::get()?.minimum_balance(new_len).saturating_sub(info.lamports());
    if needed > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.admin.to_account_info(), to: info.clone() },
            ),
            needed,
        )?;
    }
    info.resize(new_len)?;

    let upgraded = Config {
        version: CONFIG_VERSION,
        bump: old.bump,
        admin: old.admin,
        pending_admin: old.pending_admin,
        dev_wallet: old.dev_wallet,
        rake_bps: old.rake_bps,
        max_buy_in: old.max_buy_in,
        paused: old.paused,
        escape_idle_secs: 0,
        reserved: [0; CONFIG_RESERVED],
    };
    let mut data = info.try_borrow_mut_data()?;
    data.fill(0);
    let mut cursor: &mut [u8] = &mut data[..];
    upgraded.try_serialize(&mut cursor)?;
    emit!(ConfigMigrated { from_version: old.version, to_version: CONFIG_VERSION, new_len: new_len as u32 });
    Ok(())
}

fn emit_changed(config: &Config) {
    emit!(ConfigChanged {
        admin: config.admin,
        dev_wallet: config.dev_wallet,
        rake_bps: config.rake_bps,
        max_buy_in: config.max_buy_in,
        paused: config.paused,
    });
}

#[event]
pub struct ConfigChanged {
    pub admin: Pubkey,
    pub dev_wallet: Pubkey,
    pub rake_bps: u16,
    pub max_buy_in: u64,
    pub paused: bool,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
}

#[event]
pub struct AdminChanged {
    pub previous_admin: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct ConfigMigrated {
    pub from_version: u8,
    pub to_version: u8,
    pub new_len: u32,
}
