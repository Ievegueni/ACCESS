package com.comunica.access.accessibility

import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.comunica.access.model.Sequence
import com.comunica.access.model.Step

/**
 * Estado de uma sequência USSD em execução.
 *
 * Vive em memória: o AccessibilityService e a Activity partilham processo, e uma
 * sequência interrompida não deve sobreviver a um reinício do serviço — retomar
 * a meio de um menu que já não está no ecrã faria escolhas às cegas.
 *
 * Cada caixa é identificada pelo seu texto. Uma versão anterior usava um intervalo
 * mínimo entre passos e encalhava: se a caixa seguinte aparecia dentro desse
 * intervalo, os eventos dela eram descartados e, como o ecrã depois fica parado,
 * não chegava mais nenhum — a sequência ficava suspensa indefinidamente.
 */
object SequenceRunner {

    private var steps: List<String> = emptyList()
    private var index = 0

    /** Texto da última caixa respondida, para não responder duas vezes à mesma. */
    private var lastAnswered: String? = null

    /** Valor extraído do SMS, usado pelos passos que contenham `{sms}`. */
    private var smsValue: String? = null

    /** Campos etiquetados do SMS (`iban: ...`), usados como `{iban}`. */
    private var smsFields: Map<String, String> = emptyMap()

    var name: String = ""
        private set

    val running: Boolean
        get() = index < steps.size

    val progress: String
        get() = "$index/${steps.size}"

    fun start(
        sequence: Sequence,
        smsValue: String? = null,
        smsFields: Map<String, String> = emptyMap(),
    ) {
        steps = sequence.steps
        name = sequence.name
        index = 0
        lastAnswered = null
        this.smsValue = smsValue
        this.smsFields = smsFields
    }

    fun stop() {
        steps = emptyList()
        index = 0
        lastAnswered = null
        smsValue = null
        smsFields = emptyMap()
    }

    /**
     * Um SMS pode chegar com a sequência já a meio (o caso do código enviado
     * durante a operação), por isso os valores podem ser atualizados sem reiniciar.
     */
    fun offerSms(value: String?, fields: Map<String, String>) {
        value?.let { smsValue = it }
        if (fields.isNotEmpty()) smsFields = smsFields + fields
    }

    /**
     * Troca `{campo}` pelo valor vindo do SMS. Devolve null se algum ainda não
     * chegou — melhor esperar do que responder com o campo vazio.
     */
    private fun resolve(raw: String): String? {
        var missing: String? = null
        val filled = PLACEHOLDER.replace(raw) { match ->
            val key = match.groupValues[1].lowercase()
            val value = if (key == "sms") smsValue else smsFields[key]
            if (value == null) {
                missing = key
                ""
            } else {
                value
            }
        }
        missing?.let {
            Log.d(TAG, "passo ${index + 1} espera {$it}, ainda não chegou no SMS")
            return null
        }
        return filled
    }

    /**
     * Tenta aplicar o passo atual à janela [root]. Devolve o que foi escrito
     * quando avança, ou null se este ecrã ainda não é a caixa que esperamos.
     */
    fun apply(root: AccessibilityNodeInfo): String? {
        if (!running) return null

        val confirm = findConfirm(root)
        if (confirm == null) {
            Log.d(TAG, "sem botão confirmar em ${root.packageName} — ${describe(root)}")
            return null
        }

        // A assinatura ignora campos editáveis: o que lá escrevemos mudaria o texto
        // e a mesma caixa passaria por nova.
        val signature = signatureOf(root)
        if (signature == lastAnswered) return null

        val step = Step.parse(resolve(steps[index]) ?: return null)

        if (step.expect != null && !signature.contains(step.expect, ignoreCase = true)) {
            Log.w(TAG, "caixa inesperada no passo ${index + 1}: queria \"${step.expect}\", está \"$signature\"")
            return null
        }

        if (step.answer.isNotEmpty()) {
            val field = NodeFinder.findEditable(root)
            if (field == null) {
                Log.d(TAG, "sem campo de texto para \"${step.answer}\" — ${describe(root)}")
                return null
            }
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, step.answer)
            }
            if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                Log.w(TAG, "ACTION_SET_TEXT falhou")
                return null
            }
        }

        if (!confirm.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            Log.w(TAG, "ACTION_CLICK no confirmar falhou")
            return null
        }

        index++
        lastAnswered = signature
        return step.answer
    }

    /** Todo o texto fixo da caixa — identifica-a e serve de verificação. */
    private fun signatureOf(root: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        fun walk(node: AccessibilityNodeInfo?) {
            if (node == null) return
            if (!node.isEditable) {
                node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += it }
            }
            for (i in 0 until node.childCount) walk(node.getChild(i))
        }
        walk(root)
        return parts.joinToString(" ")
    }

    /**
     * O botão de confirmar da caixa USSD.
     *
     * A caixa da Samsung não é uma AlertDialog: os botões não têm
     * viewIdResourceName, por isso `android:id/button1` não existe e só resta o
     * rótulo. "Cancelar" nunca entra na lista.
     */
    private fun findConfirm(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        NodeFinder.findNodeByViewId(root, CONFIRM_ID)?.let { if (it.isClickable) return it }
        for (label in CONFIRM_LABELS) {
            val node = NodeFinder.findNodeByText(root, label) ?: continue
            clickableSelfOrParent(node)?.let { return it }
        }
        return null
    }

    /** O texto costuma estar num filho não-clicável do botão. */
    private fun clickableSelfOrParent(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var current = node
        repeat(3) {
            if (current == null) return null
            if (current.isClickable) return current
            current = current.parent
        }
        return null
    }

    /** Ids e textos dos nós acionáveis — para perceber que caixa é esta quando falha. */
    private fun describe(root: AccessibilityNodeInfo): String {
        val found = mutableListOf<String>()
        fun walk(node: AccessibilityNodeInfo?) {
            if (node == null || found.size >= 12) return
            if (node.isClickable || node.isEditable) {
                val id = node.viewIdResourceName ?: node.className?.toString() ?: "?"
                found += "$id${if (node.isEditable) "[edit]" else ""}=\"${node.text}\""
            }
            for (i in 0 until node.childCount) walk(node.getChild(i))
        }
        walk(root)
        return if (found.isEmpty()) "nada acionável" else found.joinToString(" | ")
    }

    // '}' escapado: o Android usa ICU, que o rejeita solto (a JVM aceita-o).
    private val PLACEHOLDER = Regex("""\{([\p{L}\w]+)\}""")
    private const val CONFIRM_ID = "android:id/button1"
    private val CONFIRM_LABELS = listOf("Enviar", "Send", "OK", "Confirmar", "Submit", "Continuar")
    private const val TAG = "AutomationService"
}
