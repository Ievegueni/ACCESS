package com.comunica.access.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.comunica.access.SequenceLauncher
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.data.RulesStore
import com.comunica.access.model.Confirmation
import com.comunica.access.model.smsFields
import com.comunica.access.webhook.WebhookConfig
import com.comunica.access.webhook.WebhookQueue
import com.comunica.access.webhook.WebhookSender

/**
 * Dispara uma sequência quando chega um SMS com o texto configurado.
 *
 * Um SMS pode chegar em dois momentos e ambos são úteis: antes da sequência
 * (é ele que a arranca) ou durante (traz o código que um passo `{sms}` espera).
 */
class SmsTrigger : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        Log.d(TAG, "onReceive: ${intent.action}")
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        // Um SMS longo chega partido em vários PDUs; o corpo é a junção de todos.
        val body = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            ?.joinToString("") { it.displayMessageBody.orEmpty() }
            ?.takeIf { it.isNotBlank() } ?: return

        // A confirmação é verificada primeiro: um SMS que traz TID é o fim de uma
        // transferência, nunca o pedido de outra. Sem esta ordem, uma confirmação
        // que calhasse conter o texto do trigger arrancava nova transferência.
        val confirmation = Confirmation.parse(body, System.currentTimeMillis())
        if (confirmation != null) {
            // O número entra no payload agora, não no envio: se for corrigido mais
            // tarde, o que está em fila continua a dizer de onde veio na verdade.
            WebhookQueue.add(
                context,
                confirmation.toJson(WebhookConfig.numero(context), SequenceRunner.takeOrderId()),
            )
            RulesStore.log(
                context,
                "confirmação ${if (confirmation.sucesso) "OK" else "FALHA"} · TID ${confirmation.tid}",
            )
            WebhookSender.flush(context)
            return
        }

        val sequences = RulesStore.loadSequences(context)
        val sequence = sequences.firstOrNull { it.triggeredBy(body) }

        // Logs deliberadamente incondicionais: sem eles, um trigger mal configurado
        // é indistinguível de um receiver que nunca correu.
        Log.d(TAG, "SMS recebido (${body.length} chars): \"${body.take(60)}\"")
        if (sequence == null) {
            val triggers = sequences.mapNotNull { it.smsContains?.ifBlank { null } }
            Log.d(
                TAG,
                if (triggers.isEmpty()) "nenhuma sequência tem trigger por SMS configurado"
                else "nenhum trigger corresponde; configurados: $triggers",
            )
            return
        }

        val fields = smsFields(body)
        val value = sequence.extractFrom(body)
        if (value == null && fields.isEmpty()) {
            RulesStore.log(context, "${sequence.name} · SMS reconhecido mas nada a extrair")
            return
        }

        // Só os nomes dos campos vão para o histórico; os valores nunca, porque o
        // histórico está à vista na app.
        val summary = fields.keys.joinToString(", ").ifEmpty { "valor" }

        if (SequenceRunner.running) {
            SequenceRunner.offerSms(value, fields)
            RulesStore.log(context, "${SequenceRunner.name} · SMS recebido ($summary)")
        } else {
            RulesStore.log(context, "${sequence.name} · disparada por SMS ($summary)")
            SequenceLauncher.launch(context, sequence, value, fields)
        }
    }

    private companion object {
        const val TAG = "AutomationService"
    }
}
