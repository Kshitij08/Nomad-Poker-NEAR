import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The store apps (Phase 8): this web app in a native shell. Build the web app as a store build first:
 *   VITE_STORE_BUILD=1 VITE_API_URL=… VITE_NET_SERVER=… npm run build && npx cap sync
 * The app's origin is https://localhost (Android) / capacitor://localhost (iOS); the API and game server allow both.
 * appId is provisional until the first store upload (see docs/worklog-phases-6-8.md, question 7).
 */
const config: CapacitorConfig = {
  appId: 'com.nomadpoker.app',
  appName: 'Nomad Poker',
  webDir: 'dist',
  android: { allowMixedContent: false },
  ios: { contentInset: 'never' },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: '#0b1016', showSpinner: false },
    StatusBar: { overlaysWebView: true, style: 'DARK', backgroundColor: '#00000000' },
  },
};

export default config;
