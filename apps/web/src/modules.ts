/**
 * Every module, in install order. A module installs services (ctx.services.*) and registers screens
 * (ctx.router.register). Later modules may use what earlier ones installed: account (the Nomad server session) comes
 * before economy, which builds the account, friends and leaderboards on it.
 */
import type { AppModule } from './app/app';
import { install as theming } from './theming/install';
import { install as economy } from './economy/install';
import { install as web3 } from './web3/install';
import { install as account } from './account/install';
import { install as retention } from './retention/install';
import { install as agents } from './agents/install';
import { install as tournaments } from './tournaments/install';
import { install as net } from './net/install';
import { install as menu } from './menu/install';

export const MODULES: readonly AppModule[] = [theming, account, economy, web3, retention, agents, tournaments, net, menu];
