package com.comunica.access.accessibility

import android.accessibilityservice.AccessibilityService
import android.content.SharedPreferences
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.comunica.access.api.OrderPoller
import com.comunica.access.data.RulesStore
import com.comunica.access.model.AutomationRule

class AutomationService : AccessibilityService() {

    private var rules: List<AutomationRule> = emptyList()

    /** Evita cliques repetidos enquanto o mesmo ecrã continua a emitir eventos. */
    private val lastRun = mutableMapOf<AutomationRule, Long>()

    private val prefsListener =
        SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == RulesStore.KEY_RULES) {
                rules = RulesStore.load(this)
                Log.d(TAG, "Regras recarregadas: ${rules.size}")
            }
        }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d(TAG, "config: eventTypes=${serviceInfo?.eventTypes} capabilities=${serviceInfo?.capabilities}")
        rules = RulesStore.load(this)
        RulesStore.prefs(this).registerOnSharedPreferenceChangeListener(prefsListener)
        RulesStore.log(this, "Serviço ligado (${rules.size} regras)")
        Log.d(TAG, "Serviço ligado com ${rules.size} regras")
        // O trigger por API vive aqui porque é este processo que o sistema mantém
        // ligado — sem serviço de acessibilidade não havia quem executasse a ordem.
        OrderPoller.start(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val packageName = event?.packageName?.toString() ?: return
        Log.d(TAG, "Evento ${AccessibilityEvent.eventTypeToString(event.eventType)} em $packageName")

        // Antes das regras: as caixas USSD pertencem ao sistema (com.android.phone e
        // equivalentes), por isso nunca correspondem ao package de uma regra.
        // A própria Access tem campos de texto e botões: sem esta guarda o runner
        // chegou a inspecionar o formulário de sequências e podia escrever nele.
        if (SequenceRunner.running && packageName != getPackageName()) {
            rootInActiveWindow?.let { window ->
                SequenceRunner.apply(window)?.let { answer ->
                    val shown = if (answer.isEmpty()) "(confirmar)" else "\"$answer\""
                    Log.d(TAG, "Passo ${SequenceRunner.progress} → $shown")
                    RulesStore.log(this, "${SequenceRunner.name} · passo ${SequenceRunner.progress} · $shown")
                    if (!SequenceRunner.running) RulesStore.log(this, "${SequenceRunner.name} · sequência terminada")
                }
            }
            return
        }

        val matching = rules.filter { it.matches(packageName) && it.isValid }
        if (matching.isEmpty()) return

        // O evento pode chegar depois de a app-alvo já ter saído de primeiro plano;
        // sem esta guarda o clique cairia na janela que estiver ativa nesse momento.
        val root = rootInActiveWindow
        if (root == null) {
            Log.w(TAG, "rootInActiveWindow null (capabilities=${serviceInfo?.capabilities})")
            return
        }
        if (root.packageName?.toString() != packageName) {
            Log.d(TAG, "Janela ativa é ${root.packageName}, evento era de $packageName — ignorado")
            return
        }

        for (rule in matching) {
            val now = SystemClock.elapsedRealtime()
            if (now - (lastRun[rule] ?: 0L) < COOLDOWN_MS) continue

            val node = NodeFinder.findNodeByText(root, rule.buttonText)
            if (node == null) {
                Log.d(TAG, "Nó \"${rule.buttonText}\" não encontrado em $packageName")
                continue
            }

            val clicked = GestureHelper.clickNode(this, node)
            lastRun[rule] = now
            val outcome = if (clicked) "clique OK" else "clique FALHOU"
            Log.d(TAG, "$outcome — \"${rule.buttonText}\" em $packageName")
            RulesStore.log(this, "$packageName · \"${rule.buttonText}\" · $outcome")
        }
    }

    override fun onInterrupt() {
        Log.d(TAG, "Serviço interrompido")
    }

    override fun onDestroy() {
        OrderPoller.stop()
        RulesStore.prefs(this).unregisterOnSharedPreferenceChangeListener(prefsListener)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AutomationService"
        private const val COOLDOWN_MS = 2_000L
    }
}
