package com.comunica.access.webhook

import android.content.Context
import com.comunica.access.data.RulesStore
import org.json.JSONArray

/**
 * Fila persistente de payloads por entregar.
 *
 * Fica em disco para sobreviver a reinícios: uma confirmação perdida é um registo
 * que nunca mais aparece no painel, porque o SMS não volta a chegar.
 */
object WebhookQueue {

    /** Acima disto o mais antigo cai — uma fila que cresce sem limite é uma fuga. */
    private const val MAX = 200

    private const val KEY = "webhook_queue"

    @Synchronized
    fun add(context: Context, payload: String) {
        val pending = load(context).toMutableList()
        pending += payload
        save(context, pending.takeLast(MAX))
    }

    @Synchronized
    fun load(context: Context): List<String> {
        val raw = RulesStore.prefs(context).getString(KEY, null) ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getString(it) }
    }

    @Synchronized
    fun save(context: Context, payloads: List<String>) {
        RulesStore.prefs(context).edit()
            .putString(KEY, JSONArray(payloads).toString())
            .apply()
    }

    fun size(context: Context): Int = load(context).size
}
