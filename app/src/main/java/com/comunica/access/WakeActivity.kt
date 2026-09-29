package com.comunica.access

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.WindowManager

/**
 * Acorda o ecrã e tira o bloqueio antes de marcar.
 *
 * Com o ecrã apagado ou no ecrã de bloqueio, a caixa USSD não fica na janela
 * ativa e o AccessibilityService nunca a vê: a sequência marcava e ficava parada
 * até ao limite de 5 minutos. Só uma Activity pode pedir para tirar o bloqueio,
 * por isso esta existe, sem interface, e fecha-se logo a seguir.
 *
 * Bloqueio só por deslizar sai sozinho. Com PIN/padrão o sistema pede-o e isto
 * falha — o telemóvel da automação tem de ficar sem bloqueio seguro.
 */
class WakeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }

        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isKeyguardLocked || Build.VERSION.SDK_INT < 27) {
            done(true)
            return
        }
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = done(true)
            override fun onDismissCancelled() = done(false)
            override fun onDismissError() = done(false)
        })
    }

    private fun done(unlocked: Boolean) {
        SequenceLauncher.onWake(applicationContext, unlocked)
        finish()
    }

    companion object {
        /** Ecrã ligado e sem bloqueio: pode-se marcar diretamente. */
        fun ready(context: Context): Boolean =
            context.getSystemService(PowerManager::class.java).isInteractive &&
                !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

        fun intent(context: Context) = Intent(context, WakeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
}
