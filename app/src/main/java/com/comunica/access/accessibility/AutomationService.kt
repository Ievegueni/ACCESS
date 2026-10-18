package com.comunica.access.accessibility

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.content.SharedPreferences
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.comunica.access.MainActivity
import com.comunica.access.SaldoCheck
import com.comunica.access.SequenceLauncher
import com.comunica.access.api.OrderPoller
import com.comunica.access.data.RulesStore
import com.comunica.access.model.AutomationRule
import com.comunica.access.model.Confirmation
import com.comunica.access.webhook.WebhookConfig
import com.comunica.access.webhook.WebhookQueue
import com.comunica.access.webhook.WebhookSender

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
        emPrimeiroPlano()
    }

    /**
     * Notificação fixa: um serviço em primeiro plano não entra no limpador
     * periódico da Unisoc (Redmi A5), que matava o processo e deixava a
     * acessibilidade marcada como "crashed" — as sequências paravam no 1.º passo.
     */
    private fun emPrimeiroPlano() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CANAL, "Serviço activo", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val abrir = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CANAL) else Notification.Builder(this)
        val n = builder
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Access activo")
            .setContentText("À espera de ordens")
            .setContentIntent(abrir)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICACAO, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICACAO, n)
            }
        } catch (e: Exception) {
            // Sem primeiro plano o serviço continua a funcionar, só fica exposto ao limpador.
            Log.w(TAG, "startForeground falhou", e)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val packageName = event?.packageName?.toString() ?: return
        Log.d(TAG, "Evento ${AccessibilityEvent.eventTypeToString(event.eventType)} em $packageName")

        // Antes das regras: as caixas USSD pertencem ao sistema (com.android.phone e
        // equivalentes), por isso nunca correspondem ao package de uma regra.
        // A própria Access tem campos de texto e botões: sem esta guarda o runner
        // chegou a inspecionar o formulário de sequências e podia escrever nele.
        if (SequenceRunner.closing && !SequenceRunner.running && packageName != getPackageName()) {
            rootInActiveWindow?.let { window ->
                SequenceRunner.closeResult(window)?.let { text ->
                    Log.d(TAG, "Resultado fechado: \"$text\"")
                    RulesStore.log(this, "${SequenceRunner.name} · resultado: \"${text.take(160)}\" · OK")
                    // A consulta de saldo também acaba numa caixa destas.
                    if (!SaldoCheck.onTexto(this, text, caixaFinal = true)) confirmarPeloEcra(text)
                }
            }
            return
        }

        if (SequenceRunner.running && packageName != getPackageName()) {
            rootInActiveWindow?.let { window ->
                SequenceRunner.apply(window)?.let { answer ->
                    val shown = if (answer.isEmpty()) "(confirmar)" else "\"$answer\""
                    Log.d(TAG, "Passo ${SequenceRunner.progress} → $shown")
                    RulesStore.log(this, "${SequenceRunner.name} · passo ${SequenceRunner.progress} · $shown")
                    if (!SequenceRunner.running) RulesStore.log(this, "${SequenceRunner.name} · sequência terminada")
                }
                // "Serviço indisponível": o runner já parou, o launcher decide se repete.
                SequenceRunner.takeFailure()?.let { failure ->
                    RulesStore.log(this, "${SequenceRunner.name} · operador: \"${failure.text.take(80)}\"")
                    SequenceLauncher.onFailure(this, failure)
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

    /**
     * A caixa final traz o TID: confirma a ordem já, sem esperar pelo SMS, que às
     * vezes não chega. Leva o orderId — o SMS que vier depois sai sem ele e o
     * servidor junta-o a este pelo TID.
     */
    private fun confirmarPeloEcra(text: String) {
        val c = Confirmation.fromResult(
            text,
            SequenceRunner.field("iban"),
            SequenceRunner.field("valor"),
            System.currentTimeMillis(),
        ) ?: return
        WebhookQueue.add(this, c.toJson(WebhookConfig.numero(this), SequenceRunner.takeOrderId()))
        RulesStore.log(this, "confirmação OK (ecrã) · TID ${c.tid}")
        WebhookSender.flush(this)
    }

    override fun onInterrupt() {
        Log.d(TAG, "Serviço interrompido")
    }

    override fun onDestroy() {
        OrderPoller.stop()
        stopForeground(STOP_FOREGROUND_REMOVE)
        RulesStore.prefs(this).unregisterOnSharedPreferenceChangeListener(prefsListener)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AutomationService"
        private const val COOLDOWN_MS = 2_000L
        private const val CANAL = "servico"
        private const val NOTIFICACAO = 1
    }
}
