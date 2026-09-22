package com.comunica.access.webhook

import android.content.Context
import android.util.Log
import com.comunica.access.data.RulesStore
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Envia os payloads pendentes para o endpoint configurado.
 *
 * ponytail: a fila é esvaziada quando chega um SMS e quando a app abre, em vez de
 * reagir ao regresso da rede. Chega para o caso normal — cada transferência traz
 * um SMS que puxa a fila atrás — mas uma confirmação só fica entregue no evento
 * seguinte se o telemóvel estiver offline. Passar para WorkManager com
 * NetworkType.CONNECTED se isso vier a incomodar.
 */
object WebhookSender {

    private const val TIMEOUT_MS = 15_000

    /**
     * Tenta entregar tudo o que está em fila, pela ordem de chegada.
     * Pára ao primeiro erro para não baralhar a ordem no painel.
     */
    fun flush(context: Context) {
        val config = WebhookConfig.from(context) ?: return
        val pending = WebhookQueue.load(context)
        if (pending.isEmpty()) return

        thread {
            var entregues = 0
            for (payload in pending) {
                if (!post(config, payload)) break
                entregues++
            }

            if (entregues > 0) {
                WebhookQueue.save(context, pending.drop(entregues))
                RulesStore.log(context, "webhook · $entregues entregue(s)")
            }
            val resto = pending.size - entregues
            if (resto > 0) {
                Log.w(TAG, "$resto payload(s) por entregar, ficam em fila")
                RulesStore.log(context, "webhook · $resto por entregar")
            }
        }
    }

    private fun post(config: WebhookConfig, payload: String): Boolean = runCatching {
        val connection = (URL(config.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            config.token.takeIf { it.isNotBlank() }?.let {
                setRequestProperty("Authorization", "Bearer $it")
            }
        }

        try {
            connection.outputStream.use { it.write(payload.toByteArray()) }
            val code = connection.responseCode
            Log.d(TAG, "POST → $code")
            // 4xx não melhora com repetição (payload ou token errados): descarta-se
            // para a fila não ficar bloqueada por sempre no mesmo item.
            code in 200..299 || code in 400..499
        } finally {
            connection.disconnect()
        }
    }.getOrElse {
        Log.w(TAG, "falhou o envio: ${it.message}")
        false
    }

    private const val TAG = "AutomationService"
}

/** Endpoint do painel. Sem URL configurado não há envio — só fila. */
data class WebhookConfig(val url: String, val token: String) {
    companion object {
        const val KEY_URL = "webhook_url"
        const val KEY_TOKEN = "webhook_token"

        /**
         * Número do SIM deste telemóvel. É o que diz ao painel de quem é a
         * transferência quando o mesmo token serve mais do que um telemóvel.
         * Não vem do sistema — ver [com.comunica.access.model.Confirmation.toJson].
         */
        const val KEY_NUMERO = "webhook_numero"

        fun from(context: Context): WebhookConfig? {
            val prefs = RulesStore.prefs(context)
            val url = prefs.getString(KEY_URL, null)?.trim().orEmpty()
            // Só HTTPS: isto leva identificadores de transações reais.
            if (!url.startsWith("https://")) return null
            return WebhookConfig(url, prefs.getString(KEY_TOKEN, null)?.trim().orEmpty())
        }

        /** Vazio se não estiver configurado: o payload sai sem o campo. */
        fun numero(context: Context): String =
            RulesStore.prefs(context).getString(KEY_NUMERO, null)?.trim().orEmpty()
    }
}
