use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PokerError;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, dev_wallet: Pubkey, rake_bps: u16) -> Result<()> {
    require!(rake_bps <= MAX_RAKE_BPS, PokerError::RakeTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.dev_wallet = dev_wallet;
    config.rake_bps = rake_bps;
    config.bump = ctx.bumps.config;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ PokerError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

pub fn update_handler(ctx: Context<UpdateConfig>, dev_wallet: Pubkey, rake_bps: u16) -> Result<()> {
    require!(rake_bps <= MAX_RAKE_BPS, PokerError::RakeTooHigh);

    let config = &mut ctx.accounts.config;
    config.dev_wallet = dev_wallet;
    config.rake_bps = rake_bps;

    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct UpdateSettlementAuthority<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ PokerError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump
    )]
    pub table: Account<'info, crate::state::Table>,
}

pub fn update_settlement_authority_handler(
    ctx: Context<UpdateSettlementAuthority>,
    _table_id: [u8; 32],
    new_authority: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.table.table_id == _table_id,
        PokerError::Unauthorized
    );
    ctx.accounts.table.settlement_authority = new_authority;
    Ok(())
}
