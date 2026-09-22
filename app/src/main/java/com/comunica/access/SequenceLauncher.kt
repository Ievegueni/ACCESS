package com.comunica.access

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.data.RulesStore
import com.comunica.access.model.Sequence

/**
 * Arranca uma sequência: prepara o runner e marca o número.
 *
 * Partilhado entre a Activity (botão "Executar") e o receiver de SMS, para que o
 * arranque seja idêntico nos dois caminhos.
 */
object SequenceLauncher {

    fun launch(
        context: Context,
        sequence: Sequence,
        smsValue: String? = null,
        smsFields: Map<String, String> = emptyMap(),
    ) {
        // Antes de marcar: a primeira caixa USSD pode aparecer antes de voltarmos aqui.
        SequenceRunner.start(sequence, smsValue, smsFields)
        RulesStore.log(context, "${sequence.name} · a marcar ${sequence.dial}")

        // Uri.fromParts trata o '#' dos códigos USSD, que numa Uri normal seria
        // lido como fragmento e truncaria o número.
        val intent = Intent(Intent.ACTION_CALL, Uri.fromParts("tel", sequence.dial, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        runCatching { context.startActivity(intent) }.onFailure {
            SequenceRunner.stop()
            Log.w(TAG, "falhou ao marcar", it)
            RulesStore.log(context, "${sequence.name} · falhou ao marcar: ${it.message}")
        }
    }

    private const val TAG = "AutomationService"
}
