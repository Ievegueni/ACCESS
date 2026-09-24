package com.comunica.access

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.api.OrderPoller
import com.comunica.access.data.RulesStore
import com.comunica.access.model.Sequence

/**
 * Arranca uma sequência: prepara o runner e marca o número.
 *
 * Partilhado entre a Activity (botão "Executar"), o receiver de SMS e as ordens
 * da API, para que o arranque seja idêntico nos três caminhos. É também quem
 * repete quando o operador responde "serviço indisponível" (ver [onFailure]).
 */
object SequenceLauncher {

    /** O que foi marcado, para o poder marcar outra vez igual. */
    private class Launch(
        val sequence: Sequence,
        val smsValue: String?,
        val smsFields: Map<String, String>,
        val orderId: Int?,
    ) {
        var tentativa = 0
    }

    /** A última marcação: é a ela que pertence o erro que o runner reportar. */
    private var last: Launch? = null

    private val main = Handler(Looper.getMainLooper())

    /**
     * Há uma repetição agendada. O [OrderPoller] não vai buscar ordens enquanto
     * isto for > 0: a seguinte ficava `entregue` à espera desta, e o telemóvel só
     * corre uma sequência de cada vez.
     *
     * Só mexido na thread principal (eventos de acessibilidade, SMS, o Handler);
     * o poller só lê.
     */
    @Volatile
    var aRepetir = 0
        private set

    fun launch(
        context: Context,
        sequence: Sequence,
        smsValue: String? = null,
        smsFields: Map<String, String> = emptyMap(),
        /** Ordem da API que mandou correr isto, para a confirmação a poder fechar. */
        orderId: Int? = null,
    ) = marcar(context, Launch(sequence, smsValue, smsFields, orderId))

    private fun marcar(context: Context, launch: Launch) {
        val sequence = launch.sequence
        last = launch
        // Antes de marcar: a primeira caixa USSD pode aparecer antes de voltarmos aqui.
        SequenceRunner.start(sequence, launch.smsValue, launch.smsFields, launch.orderId)
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

    /**
     * O operador respondeu com a caixa de erro e o runner parou.
     *
     * Antes do valor nada foi submetido: marca-se outra vez daqui a [ESPERA_MS],
     * até [REPETICOES] vezes, e depois avisa-se o painel para a ordem fechar já
     * com um motivo que deixa o cliente repetir. Depois do valor pode ter corrido:
     * não se repete, e a ordem segue o caminho de sempre (SMS ou expira).
     */
    fun onFailure(context: Context, failure: SequenceRunner.Failure) {
        val launch = last ?: return
        val nome = launch.sequence.name

        if (!failure.beforeValue) {
            RulesStore.log(context, "$nome · erro do operador depois do valor: não se repete")
            return
        }

        if (launch.tentativa < REPETICOES) {
            launch.tentativa++
            aRepetir++
            RulesStore.log(
                context,
                "$nome · operador indisponível, nova tentativa ${launch.tentativa}/$REPETICOES em ${ESPERA_MS / 1000}s",
            )
            main.postDelayed({ repetir(context, launch) }, ESPERA_MS)
            return
        }

        RulesStore.log(context, "$nome · operador indisponível, desistiu após $REPETICOES repetições")
        // A confirmação que chegar a seguir (de outra coisa qualquer) não é desta.
        if (launch.orderId != null) SequenceRunner.orderId = null
        launch.orderId?.let { OrderPoller.desistir(context, it, MOTIVO_INDISPONIVEL) }
    }

    /**
     * Um SMS pode ter arrancado outra sequência durante a espera: nesse caso
     * espera-se que acabe, sem gastar uma tentativa.
     */
    private fun repetir(context: Context, launch: Launch) {
        if (SequenceRunner.running) {
            main.postDelayed({ repetir(context, launch) }, ESPERA_MS)
            return
        }
        aRepetir--
        marcar(context, launch)
    }

    /** Até 4 marcações no total, ~2 min: bem dentro dos 10 min da ordem no painel. */
    private const val REPETICOES = 3
    private const val ESPERA_MS = 30_000L
    private const val MOTIVO_INDISPONIVEL = "operador_indisponivel"
    private const val TAG = "AutomationService"
}
