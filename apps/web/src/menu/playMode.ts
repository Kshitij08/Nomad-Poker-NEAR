/** The Nomad menu's Demo (Coins) / On-chain (NEAR testnet) switch, remembered between visits. */
import { PlayerPrefs } from '../app/services';

const NOMAD_MODE_PREF = 'Nomad.PlayMode';

export const NomadPlayMode = {
  get onchain(): boolean {
    return PlayerPrefs.getInt(NOMAD_MODE_PREF, 0) === 1;
  },
  set onchain(v: boolean) {
    PlayerPrefs.setInt(NOMAD_MODE_PREF, v ? 1 : 0);
  },
};
