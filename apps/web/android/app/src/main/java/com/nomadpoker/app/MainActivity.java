package com.nomadpoker.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        applyOrientation(getResources().getConfiguration());
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // A foldable that opens into a tablet gets both orientations back (configChanges keeps the activity alive).
        applyOrientation(newConfig);
    }

    /** Phones play in portrait only (Redesign v2); tablets keep both orientations. */
    private void applyOrientation(Configuration config) {
        setRequestedOrientation(config.smallestScreenWidthDp < 600
            ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }
}
