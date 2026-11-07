/**
 * Port of Economy/Ui/PlayFabLoginUI.cs's panel (BuildRuntimeUI): the "Account" card (Play as Guest, Continue with
 * Google, Keep me signed in, Save with email / Sign in with email, Sign out, Done) and the email form, as the router
 * overlay 'login-playfab'.
 *
 * In the shipped flow the Nomad Login screen is the front door (ChromeSuppressed = true), so this panel only shows
 * when the player asks for it: `{ form: 'signin' }` = ShowEmailSignIn, `{ form: 'save' }` = Save your account,
 * `{ linkAccount: true }` = OpenLinkAccount, no params = Open. It closes itself when Refresh decides there is nothing
 * to show, exactly like the C# panel hides.
 */
import type { AppContext, Screen } from '../../app/app';
import type { UNode } from '../../hud/unityUi';
import type { EconomyAccount } from '../account';
import { PokerClientIdentity } from '../identity';
import {
  attachInput, DEFAULT_SCALER, DefaultColors, makeNode, OverlayCanvas, place, resourceSprite, setImage, setLabel, stretch,
  unityColor, wireButton, WHITE, type UiButton,
} from './canvas';
import './economy.css';

export interface LoginPanelParams {
  form?: 'signin' | 'save';
  linkAccount?: boolean;
}

type FormMode = 'save' | 'signin';
const Gold = unityColor(0.95, 0.78, 0.32);

interface Btn {
  node: UNode;
  label: UNode;
  button: UiButton;
}

export class PlayFabLoginPanel implements Screen {
  readonly overlay = true;
  private canvas: OverlayCanvas | null = null;
  private root!: UNode;
  private dimmer!: UNode;
  private main!: UNode;
  private account_!: UNode;
  private title!: UNode;
  private identity!: UNode;
  private status!: UNode;
  private guest!: Btn;
  private google!: Btn;
  private keepRow!: UNode;
  private keepCheck!: UNode;
  private orEmail!: UNode;
  private saveBtn!: Btn;
  private signInBtn!: Btn;
  private signOutBtn!: Btn;
  private closeBtn!: Btn;
  private accountTitle!: UNode;
  private confirm!: Btn;
  private cancel!: Btn;
  private email!: HTMLInputElement;
  private password!: HTMLInputElement;
  private keepOn = false;
  private mode: FormMode = 'save';
  private openedByPlayer = true;
  private statusText: string | null = null;
  private offs: (() => void)[] = [];

  constructor(private readonly ctx: AppContext, private readonly acct: EconomyAccount) {}

  mount(el: HTMLElement, params?: unknown): void {
    const p = (params ?? {}) as LoginPanelParams;
    el.classList.add('econ-screen');
    this.root = makeNode('PlayFabLoginCanvas');
    this.build();
    this.canvas = new OverlayCanvas(el, this.root, DEFAULT_SCALER, 100);
    this.keepOn = this.acct.keepMeSignedIn;
    this.offs.push(this.acct.statusChanged.on((m) => this.setStatus(m)));
    this.offs.push(this.ctx.events.on('account:changed', () => this.refresh()));
    if (p.linkAccount) {
      this.setStatus('Link Google or email to keep your chips on every device.');
    } else if (p.form) {
      this.showForm(p.form);
    }
    this.setStatus(this.statusText ?? this.acct.status);
    this.refresh();
  }

  unmount(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.canvas?.dispose();
    this.canvas = null;
  }

  // ---- building (BuildRuntimeUI numbers)

  private build(): void {
    const r = this.root;
    this.dimmer = setImage(stretch(makeNode('Dimmer')), unityColor(0.02, 0.03, 0.05, 0.72));
    wireButton(this.ctx, this.dimmer, () => this.close(), { normal: WHITE, highlighted: WHITE, pressed: WHITE, disabled: WHITE }, null);
    r.add(this.dimmer);

    this.main = this.panel('MainPanel', [480, 500]);
    r.add(this.main);
    this.title = this.tmp('TitleText', 'Account', 32, WHITE, true);
    this.identity = this.tmp('IdentityText', 'Not signed in', 18, unityColor(1, 1, 1, 0.7));
    this.status = this.tmp('StatusText', '', 16, Gold);
    this.status.setActive(false);
    this.guest = this.button('GuestButton', 'Play as Guest', unityColor(0.22, 0.26, 0.34), () => void this.onGuest());
    this.google = this.button('GoogleButton', 'Continue with Google', unityColor(0.26, 0.52, 0.92), () => void this.onGoogle());
    this.keepRow = this.keepToggle();
    this.orEmail = this.tmp('OrEmail', 'or email', 14, unityColor(1, 1, 1, 0.4));
    this.saveBtn = this.button('SaveAccountButton', 'Save with email', unityColor(0.18, 0.4, 0.28), () => this.showForm('save'));
    this.signInBtn = this.button('SignInButton', 'Sign in with email', unityColor(0.18, 0.4, 0.28), () => this.showForm('signin'));
    this.signOutBtn = this.button('SignOutButton', 'Sign out', unityColor(0.32, 0.34, 0.4), () => void this.onSignOut());
    this.closeBtn = this.button('CloseButton', 'Done', unityColor(0.32, 0.34, 0.4), () => this.close());
    for (const n of [this.title, this.identity, this.status, this.guest.node, this.google.node, this.keepRow, this.orEmail, this.saveBtn.node, this.signInBtn.node, this.signOutBtn.node, this.closeBtn.node]) this.main.add(n);

    this.account_ = this.panel('AccountPanel', [460, 380]);
    r.add(this.account_);
    this.accountTitle = this.tmp('AccountTitle', 'Save your account', 26, WHITE, true);
    const hint = this.tmp('AccountHint', 'Keeps your chips if you change device.', 16, unityColor(1, 1, 1, 0.55));
    const emailField = this.input('EmailInput', 'you@example.com', 'email');
    const passwordField = this.input('PasswordInput', 'password', 'password');
    const row = makeNode('AccountButtons');
    this.confirm = this.button('ConfirmButton', 'Create', unityColor(0.16, 0.45, 0.3), () => void this.onConfirm());
    this.cancel = this.button('CancelButton', 'Cancel', unityColor(0.32, 0.34, 0.4), () => this.onCancel());
    row.add(this.confirm.node);
    row.add(this.cancel.node);
    for (const n of [this.accountTitle, hint, emailField.node, passwordField.node, row]) this.account_.add(n);
    this.email = emailField.input;
    this.password = passwordField.input;
    this.account_.setActive(false);
  }

  private panel(name: string, size: [number, number]): UNode {
    const bg = resourceSprite('Retention/Art/WeeklyRewards/rectangle_bg') ?? resourceSprite('Retention/Art/Missions/bg');
    const n = makeNode(name, { size });
    if (bg) setImage(n, WHITE, bg, 'Sliced');
    else setImage(n, unityColor(0.1, 0.12, 0.18, 0.96));
    n.el.classList.add('econ-interactive');
    return n;
  }

  /** CreateTmp: centred, size + 14 high. */
  private tmp(name: string, text: string, size: number, color: ReturnType<typeof unityColor>, bold = false): UNode {
    const n = setLabel(makeNode(name, { size: [0, size + 14] }), text, size, color, { bold });
    return n;
  }

  /** CreateButton: 52 high, default uGUI ColorBlock, 20 px bold label. */
  private button(name: string, caption: string, color: ReturnType<typeof unityColor>, onClick: () => void): Btn {
    const node = setImage(makeNode(name, { size: [0, 52] }), color);
    const label = setLabel(stretch(makeNode(name + 'Label')), caption, 20, WHITE, { bold: true });
    node.add(label);
    const button = wireButton(this.ctx, node, onClick, DefaultColors)!;
    return { node, label, button };
  }

  private keepToggle(): UNode {
    const row = makeNode('KeepMeSignedIn', { size: [0, 36] });
    const box = setImage(place(makeNode('Box'), 8, 4, 28, 28), unityColor(0.08, 0.09, 0.12));
    this.keepCheck = setImage(stretch(makeNode('Checkmark'), 4, 4, 4, 4), unityColor(0.35, 0.75, 0.45));
    box.add(this.keepCheck);
    row.add(box);
    row.add(setLabel(place(makeNode('Label'), 46, 4, 220, 28), 'Keep me signed in', 16, unityColor(1, 1, 1, 0.75), { alignH: 'left' }));
    wireButton(this.ctx, row, () => {
      this.keepOn = !this.keepOn;
      this.refresh();
    });
    return row;
  }

  private input(name: string, placeholder: string, type: string): { node: UNode; input: HTMLInputElement } {
    const node = setImage(makeNode(name, { size: [0, 48] }), unityColor(0.08, 0.09, 0.12));
    const area = stretch(makeNode('Text Area'), 12, 6, 12, 6);
    const ph = setLabel(stretch(makeNode('Placeholder')), placeholder, 20, unityColor(1, 1, 1, 0.35), { alignH: 'left', italic: true });
    const text = setLabel(stretch(makeNode('Text')), '', 20, WHITE, { alignH: 'left' });
    area.add(ph);
    area.add(text);
    node.add(area);
    node.el.classList.add('econ-interactive');
    const input = attachInput(node, { type, onSubmit: () => void this.onConfirm() });
    return { node, input };
  }

  /** VerticalLayoutGroup: padding 32/32/28/28, spacing 10, UpperCenter, control width (heights from each rect). */
  private stack(panel: UNode): void {
    const w = panel.sizeDelta[0] - 64;
    let y = 28;
    for (const c of panel.children) {
      if (!c.activeSelf) continue;
      const h = c.sizeDelta[1];
      place(c, 32, y, w, h);
      y += h + 10;
    }
    // The account panel's button row: HorizontalLayoutGroup spacing 12, expand width.
    if (panel === this.account_) {
      const row = panel.children[panel.children.length - 1]!;
      place(this.confirm.node, 0, 0, (w - 12) / 2, 56);
      place(this.cancel.node, (w - 12) / 2 + 12, 0, (w - 12) / 2, 56);
      row.sizeDelta = [w, 56];
    }
  }

  // ---- flow (PlayFabLoginUI)

  private get busy(): boolean {
    return this.acct.busy;
  }

  private persistKeepMe(): void {
    if (this.keepOn !== this.acct.keepMeSignedIn) this.acct.setKeepMeSignedIn(this.keepOn);
  }

  private async onGuest(): Promise<void> {
    if (this.busy) return;
    this.persistKeepMe();
    this.openedByPlayer = false;
    const error = await this.acct.continueAsGuest();
    this.setStatus(error ?? (this.acct.status && this.acct.status !== 'Signing in…' ? this.acct.status : null));
    this.refresh();
  }

  private async onGoogle(): Promise<void> {
    if (this.busy) return;
    this.persistKeepMe();
    this.openedByPlayer = true;
    const error = await this.acct.continueWithGoogle();
    if (!error) {
      this.keepOn = this.acct.keepMeSignedIn;
      this.account_.setActive(false);
    }
    this.refresh();
  }

  private showForm(mode: FormMode): void {
    this.openedByPlayer = true;
    this.mode = mode;
    this.accountTitle.setText(mode === 'signin' ? 'Sign in with email' : 'Save your account');
    this.confirm.label.setText(mode === 'signin' ? 'Sign in' : 'Create');
    this.password.value = '';
    this.password.dispatchEvent(new Event('input'));
    this.main.setActive(false);
    this.account_.setActive(true);
    this.setStatus(null);
    this.refresh();
  }

  private onCancel(): void {
    this.account_.setActive(false);
    this.setStatus(null);
    this.refresh();
  }

  private async onConfirm(): Promise<void> {
    if (this.busy || !this.account_.activeSelf) return;
    this.persistKeepMe();
    const email = this.email.value;
    const password = this.password.value;
    this.refresh();
    const error = this.mode === 'signin' ? await this.acct.signInWithEmail(email, password) : await this.acct.saveAccount(email, password);
    if (error) {
      this.setStatus(error);
      this.refresh();
      return;
    }
    this.password.value = '';
    this.onCancel();
    this.setStatus(this.mode === 'signin' ? 'Signed in.' : 'Account saved.');
    this.refresh();
  }

  private async onSignOut(): Promise<void> {
    await this.acct.signOut();
    this.keepOn = false;
    this.setStatus('Signed out.');
    this.openedByPlayer = true;
    this.refresh();
  }

  private close(): void {
    this.openedByPlayer = false;
    this.refresh();
  }

  private setStatus(message: string | null): void {
    this.statusText = message;
    if (!this.status) return;
    this.status.setText(message ?? '');
    this.status.setActive(!!message);
    this.relayout();
  }

  /** PlayFabLoginUI.Refresh: show the panel only when there is something to say. */
  private refresh(): void {
    if (!this.canvas) return;
    const signedIn = PokerClientIdentity.isPlayFabSignedIn || this.acct.signedIn;
    const guest = this.acct.isGuest;
    const formOpen = this.account_.activeSelf;
    const needsAttention = (!signedIn && !this.acct.signingInQuietly) || this.busy || !!this.acct.lastError;
    // ChromeSuppressed (the Nomad menu is up): the panel shows only while the player wants it.
    const showChrome = !formOpen && this.openedByPlayer;
    this.main.setActive(showChrome);
    this.dimmer.setActive(showChrome || formOpen);
    if (!showChrome && !formOpen) {
      if (this.ctx.router.current === 'login-playfab') this.ctx.router.back();
      return;
    }
    this.identity.setText(!signedIn ? 'Not signed in' : guest ? `${this.acct.displayName} · playing as guest` : this.acct.displayName);
    this.guest.node.setActive(true);
    this.guest.label.setText(signedIn && guest ? 'Continue as Guest' : 'Play as Guest');
    this.google.node.setActive(!signedIn || guest);
    this.saveBtn.node.setActive(signedIn && guest);
    this.signInBtn.node.setActive(!signedIn || guest);
    this.signOutBtn.node.setActive(signedIn && !guest);
    this.closeBtn.node.setActive(!needsAttention);
    this.orEmail.setActive(true);
    this.keepCheck.setActive(this.keepOn);
    const interactable = !this.busy;
    for (const b of [this.guest, this.google, this.saveBtn, this.signInBtn, this.signOutBtn, this.confirm, this.cancel]) b.button.setInteractable(interactable);
    this.relayout();
  }

  private relayout(): void {
    if (!this.canvas) return;
    this.stack(this.main);
    this.stack(this.account_);
    this.canvas.layout();
  }
}
