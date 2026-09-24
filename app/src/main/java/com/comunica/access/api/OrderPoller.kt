package com.comunica.access.api

import android.content.Context
import android.util.Log
import com.comunica.access.SequenceLauncher
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.data.RulesStore
import com.comunica.access.webhook.WebhookConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * Pergunta ao painel se há trabalho e executa a sequência pedida.
 *
 * É o trigger por API: o cliente faz `POST /api/v1/ordens` no servidor dele e a
 * transferência arranca aqui, sem SMS pelo meio. O contrato está em
 * `BACKOFFICE.md §8`.
 *
 * **Porque é o telemóvel a perguntar:** em dados móveis está atrás de NAT e
 * ninguém lhe liga de fora. O servidor segura cada pedido até 25 s (long-poll),
 * por isso isto não é um ciclo de sondagem por segundo — é uma ligação parada à
 * espera, e a ordem chega em menos de um segundo depois de ser criada.
 *
 * Vive no processo do AccessibilityService, que o sistema mantém ligado: não
 * precisa de foreground service nem de WorkManager, e morre com o serviço.
 */
object OrderPoller {

    /** Quanto tempo o servidor segura o pedido. O timeout tem de ser maior. */
    private const val ESPERA_S = 25
    private const val TIMEOUT_MS = (ESPERA_S + 10) * 1000

    private const val PAUSA_MIN_MS = 5_000L
    private const val PAUSA_MAX_MS = 60_000L

    /** Enquanto uma sequência corre não há nada a fazer com outra ordem. */
    private const val PAUSA_OCUPADO_MS = 2_000L

    @Volatile
    private var worker: Thread? = null

    fun start(context: Context) {
        if (worker != null) return
        val app = context.applicationContext
        worker = Thread { ciclo(app) }.apply { isDaemon = true; start() }
    }

    fun stop() {
        worker?.interrupt()
        worker = null
    }

    private fun ciclo(context: Context) {
        var pausa = PAUSA_MIN_MS
        // Só se regista a primeira ocorrência de cada problema: o histórico tem 50
        // linhas e um servidor em baixo durante a noite apagava tudo o resto.
        var ultimoErro: String? = null

        while (!Thread.currentThread().isInterrupted) {
            val config = WebhookConfig.from(context)
            if (config == null || config.token.isBlank()) {
                // Ainda não configurado, ou configurado só com URL: nada a perguntar.
                if (!dormir(PAUSA_MAX_MS)) return
                continue
            }

            if (SequenceRunner.running || SequenceLauncher.aRepetir > 0) {
                // Não se vai buscar o que não se pode executar: a ordem ficaria
                // marcada como entregue no servidor e expirava à espera. Uma
                // repetição agendada (operador indisponível) conta como ocupado.
                if (!dormir(PAUSA_OCUPADO_MS)) return
                continue
            }

            val (codigo, corpo) = pedir(config, WebhookConfig.numero(context))
            when {
                codigo == 200 && corpo != null -> {
                    pausa = PAUSA_MIN_MS
                    ultimoErro = null
                    executar(context, corpo)
                }
                // Sem ordens: o servidor já esperou os 25 s, volta-se a perguntar já.
                codigo == 204 -> {
                    pausa = PAUSA_MIN_MS
                    ultimoErro = null
                }
                else -> {
                    val erro = descricao(codigo)
                    if (erro != ultimoErro) {
                        RulesStore.log(context, "ordens · $erro")
                        ultimoErro = erro
                    }
                    Log.w(TAG, "ordens: $erro, nova tentativa em ${pausa / 1000}s")
                    if (!dormir(pausa)) return
                    pausa = (pausa * 2).coerceAtMost(PAUSA_MAX_MS)
                }
            }
        }
    }

    /** Devolve o código HTTP e o corpo (null se não houver). -1 = falhou a ligação. */
    private fun pedir(config: WebhookConfig, numero: String): Pair<Int, String?> = runCatching {
        val alvo = StringBuilder("${config.base}/api/telemovel/ordens?espera=$ESPERA_S")
        if (numero.isNotBlank()) alvo.append("&numero=").append(URLEncoder.encode(numero, "UTF-8"))

        val connection = (URL(alvo.toString()).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Authorization", "Bearer ${config.token}")
        }
        try {
            val codigo = connection.responseCode
            val corpo = if (codigo == 200) connection.inputStream.bufferedReader().readText() else null
            codigo to corpo
        } finally {
            connection.disconnect()
        }
    }.getOrElse {
        Log.w(TAG, "ordens: falhou o pedido: ${it.message}")
        -1 to null
    }

    /**
     * Arranca a sequência que a ordem pede.
     *
     * Os `campos` entram exatamente como os de um SMS — os passos com `{valor}`,
     * `{iban}` funcionam sem saber de onde vieram. Se a sequência não existir no
     * telemóvel, a ordem fica entregue no servidor e expira ao fim de 10 minutos:
     * é por isso que o motivo vai para o histórico, senão era silêncio.
     */
    private fun executar(context: Context, corpo: String) {
        val ordem = runCatching { JSONObject(corpo) }.getOrElse {
            Log.w(TAG, "ordens: resposta ilegível")
            return
        }
        val id = ordem.optInt("id", 0).takeIf { it > 0 }
        val ref = ordem.optString("ref")
        val nome = ordem.optString("sequencia")

        val sequencia = RulesStore.loadSequences(context)
            .firstOrNull { it.name.equals(nome, ignoreCase = true) && it.isValid }
        if (sequencia == null) {
            RulesStore.log(context, "ordem $ref · sequência \"$nome\" não existe neste telemóvel")
            Log.w(TAG, "ordem $ref pede \"$nome\", que não está configurada")
            return
        }

        val campos = ordem.optJSONObject("campos")?.let { objeto ->
            objeto.keys().asSequence().associate { it.lowercase() to objeto.optString(it) }
        }.orEmpty()

        // Os nomes dos campos vão para o histórico, os valores não: o histórico
        // está à vista na app, tal como no caminho do SMS.
        RulesStore.log(context, "ordem $ref · ${sequencia.name} (${campos.keys.joinToString(", ")})")
        SequenceLauncher.launch(context, sequencia, campos["sms"], campos, id)
    }

    /**
     * Diz ao painel que este telemóvel desistiu da ordem [id], para ela fechar já
     * como `falhada` com [motivo] em vez de expirar ao fim de 10 minutos como
     * `sem_confirmacao` (BACKOFFICE.md §8).
     *
     * ponytail: em memória, 3 tentativas. Se todas falharem a ordem expira na
     * mesma, só com o motivo menos útil. Uma fila em disco, como a do webhook,
     * se isto se perder na prática.
     */
    fun desistir(context: Context, id: Int, motivo: String) {
        val config = WebhookConfig.from(context) ?: return
        val corpo = JSONObject()
            .put("motivo", motivo)
            .put("numero", WebhookConfig.numero(context))
            .toString()
        thread(isDaemon = true) {
            repeat(3) { tentativa ->
                val codigo = runCatching {
                    val connection = (URL("${config.base}/api/telemovel/ordens/$id/falha")
                        .openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        connectTimeout = TIMEOUT_MS
                        readTimeout = TIMEOUT_MS
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        setRequestProperty("Authorization", "Bearer ${config.token}")
                    }
                    try {
                        connection.outputStream.use { it.write(corpo.toByteArray()) }
                        connection.responseCode
                    } finally {
                        connection.disconnect()
                    }
                }.getOrDefault(-1)

                // 4xx não melhora com repetição, tal como no webhook.
                if (codigo in 200..499) {
                    RulesStore.log(context, "ordem $id · painel avisado ($motivo)")
                    return@thread
                }
                Log.w(TAG, "ordem $id: aviso ao painel falhou (${descricao(codigo)})")
                if (tentativa < 2 && !dormir(10_000)) return@thread
            }
            RulesStore.log(context, "ordem $id · não foi possível avisar o painel")
        }
    }

    /** Dorme, ou devolve false se o serviço entretanto parou. */
    private fun dormir(ms: Long): Boolean = try {
        Thread.sleep(ms)
        true
    } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    private fun descricao(codigo: Int) = when (codigo) {
        -1 -> "sem ligação ao painel"
        401 -> "token recusado pelo painel"
        404 -> "o painel não tem a API de ordens"
        503 -> "painel indisponível"
        else -> "painel respondeu $codigo"
    }

    private const val TAG = "AutomationService"
}
