package com.comunica.access.data

import android.content.Context
import android.content.SharedPreferences
import com.comunica.access.model.AutomationRule
import com.comunica.access.model.Sequence
import com.comunica.access.model.rulesFromJson
import com.comunica.access.model.sequencesFromJson
import com.comunica.access.model.toJson
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Persistência local das regras e do histórico de execução.
 * ponytail: SharedPreferences em vez de DataStore — leitura síncrona (o
 * AccessibilityService precisa dela em callbacks) e zero dependências novas.
 * Migrar para DataStore se aparecer necessidade de fluxo assíncrono/multi-processo.
 */
object RulesStore {

    const val KEY_RULES = "rules"
    private const val KEY_SEQUENCES = "sequences"
    private const val PREFS = "access_rules"
    private const val KEY_LOG = "log"
    private const val LOG_MAX = 50

    fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context): List<AutomationRule> =
        rulesFromJson(prefs(context).getString(KEY_RULES, null))

    fun save(context: Context, rules: List<AutomationRule>) {
        prefs(context).edit().putString(KEY_RULES, rules.toJson()).apply()
    }

    fun loadSequences(context: Context): List<Sequence> =
        sequencesFromJson(prefs(context).getString(KEY_SEQUENCES, null))

    fun saveSequences(context: Context, sequences: List<Sequence>) {
        prefs(context).edit().putString(KEY_SEQUENCES, sequences.toJson()).apply()
    }

    fun log(context: Context, message: String) {
        val stamp = SimpleDateFormat("dd/MM HH:mm:ss", Locale.getDefault()).format(Date())
        val entries = history(context).toMutableList()
        entries.add(0, "$stamp — $message")
        prefs(context).edit()
            .putString(KEY_LOG, entries.take(LOG_MAX).joinToString("\n"))
            .apply()
    }

    fun history(context: Context): List<String> =
        prefs(context).getString(KEY_LOG, "")?.lines()?.filter { it.isNotBlank() } ?: emptyList()

    fun clearHistory(context: Context) {
        prefs(context).edit().remove(KEY_LOG).apply()
    }
}
