package com.comunica.access

import android.content.Context
import android.os.SystemClock
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.api.OrderPoller
import com.comunica.access.data.RulesStore
import com.comunica.access.model.Saldo
import com.comunica.access.model.Sequence

/**
 * Prova pelo saldo quando nem a caixa final nem o SMS trazem o TID.
 *
 * Com uma sequência chamada `saldo` configurada, cada ordem com `{valor}` consulta
 * o saldo antes de marcar. Se ao fim de [ESPERA_CONFIRMACAO_MS] a confirmação não
 * chegou, consulta outra vez e manda os dois ao painel, que decide se saiu
 * (PayGate `docs/ACCESS.md`). Sem a sequência, ou se a consulta falhar, segue tudo
 * como antes: a ordem fica a rever no painel.
 *
 * A confirmação ganha sempre: se chegar antes ou durante a segunda consulta, leva
 * o orderId e o saldo já não é enviado.
 */
object SaldoCheck {

    private enum class Fase { ANTES, DEPOIS }

    private class Ordem(val id: Int, val sequence: Sequence, val campos: Map<String, String>)

    private class Consulta(val fase: Fase, val ordem: Ordem, val ate: Long, val antes: String? = null)

    /** Consulta de saldo a correr. Enquanto existir, o poller não vai buscar ordens. */
    @Volatile
    private var consulta: Consulta? = null

    /** Transferência marcada com o saldo antes lido, à espera da confirmação. */
    @Volatile
    private var aVerificar: Pair<Ordem, String>? = null

    val ocupado: Boolean
        get() = consulta != null

    private fun sequencia(context: Context): Sequence? = RulesStore.loadSequences(context)
        .firstOrNull { it.name.equals(NOME, ignoreCase = true) && it.isValid && it.placeholders.isEmpty() }

    /** Consulta o saldo e só depois marca a ordem. false se não há sequência `saldo`. */
    fun antes(context: Context, sequence: Sequence, campos: Map<String, String>, id: Int): Boolean {
        val saldo = sequencia(context) ?: return false
        aVerificar = null
        consulta = Consulta(Fase.ANTES, Ordem(id, sequence, campos), SystemClock.elapsedRealtime() + CONSULTA_MS)
        RulesStore.log(context, "ordem $id · a consultar o saldo antes")
        SequenceLauncher.launch(context, saldo)
        return true
    }

    /**
     * Texto de um SMS, ou da caixa final da consulta ([caixaFinal]). true se era a
     * resposta à consulta. Uma caixa final sem saldo legível acaba a consulta já,
     * em vez de gastar o tempo da ordem à espera do timeout.
     */
    fun onTexto(context: Context, texto: String, caixaFinal: Boolean = false): Boolean {
        val c = consulta ?: return false
        val saldo = Saldo.parse(texto)
        if (saldo == null && !caixaFinal) return false
        if (saldo == null) RulesStore.log(context, "ordem ${c.ordem.id} · saldo ilegível na caixa")
        terminar(context, c, saldo)
        return true
    }

    /** O operador respondeu com erro à consulta: não se repete, segue sem saldo. */
    fun onFailure(context: Context): Boolean {
        val c = consulta ?: return false
        terminar(context, c, null)
        return true
    }

    /**
     * A confirmação chegou durante a segunda consulta: a ordem é dela, e o saldo
     * que vier a seguir já não conta.
     */
    fun takeOrderId(): Int? {
        val c = consulta?.takeIf { it.fase == Fase.DEPOIS } ?: return null
        consulta = null
        return c.ordem.id
    }

    /** Chamado pelo [OrderPoller] a cada volta: timeouts e a segunda consulta. */
    fun tick(context: Context) {
        consulta?.let { c ->
            if (SystemClock.elapsedRealtime() > c.ate) {
                RulesStore.log(context, "ordem ${c.ordem.id} · saldo sem resposta")
                terminar(context, c, null)
            }
            return
        }
        val (ordem, antes) = aVerificar ?: return
        // A confirmação levou o orderId, ou o telemóvel desistiu: nada a verificar.
        if (SequenceRunner.orderId != ordem.id) {
            aVerificar = null
            return
        }
        if (SequenceRunner.running || SequenceRunner.closing || SequenceLauncher.aRepetir > 0) return
        if (SequenceRunner.msSinceEnd < ESPERA_CONFIRMACAO_MS) return

        aVerificar = null
        val saldo = sequencia(context) ?: return
        // Passa a ser desta consulta: o arranque da sequência apagava-o no runner.
        SequenceRunner.takeOrderId()
        consulta = Consulta(Fase.DEPOIS, ordem, SystemClock.elapsedRealtime() + CONSULTA_MS, antes)
        RulesStore.log(context, "ordem ${ordem.id} · sem confirmação, a consultar o saldo depois")
        SequenceLauncher.launch(context, saldo)
    }

    private fun terminar(context: Context, c: Consulta, saldo: String?) {
        consulta = null
        val o = c.ordem
        when (c.fase) {
            Fase.ANTES -> {
                if (saldo != null) aVerificar = o to saldo
                RulesStore.log(context, "ordem ${o.id} · saldo antes ${if (saldo != null) "lido" else "não lido"}")
                SequenceLauncher.launch(context, o.sequence, o.campos["sms"], o.campos, o.id)
            }
            Fase.DEPOIS -> {
                if (saldo == null || c.antes == null) return
                RulesStore.log(context, "ordem ${o.id} · saldo depois lido, a avisar o painel")
                OrderPoller.enviarSaldo(context, o.id, c.antes, saldo)
            }
        }
    }

    private const val NOME = "saldo"
    /** Uma consulta de saldo leva segundos; isto só se ficou pendurada. */
    private const val CONSULTA_MS = 45_000L
    /** O SMS chega em segundos; dentro dos 90 s em que o poller já espera por ele. */
    private const val ESPERA_CONFIRMACAO_MS = 60_000L
}
