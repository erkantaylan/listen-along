package com.erkantaylan.listenalong.auth

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.erkantaylan.listenalong.MainActivity

/**
 * Receives `com.etaylan.listen:/oauth2redirect?...` or, in release builds,
 * the App Link `https://music.etaylan.com/auth/mobile/callback?...` (from the
 * browser, or from the server's fallback page's intent: button) and
 * hands it to [MainActivity] (CLEAR_TOP closes the Custom Tab above it;
 * NEW_TASK finds the app's task even when the browser ran the tab in its
 * own). Checks nothing itself: [AuthController.handleRedirect] does.
 */
class AuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data
        if (uri != null) {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .setData(uri)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
        finish()
    }
}
