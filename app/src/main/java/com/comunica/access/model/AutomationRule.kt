package com.comunica.access.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * Uma regra: quando [targetPackage] estiver em primeiro plano, localizar o nó
 * com o texto [buttonText] e clicar nele.
 */
data class AutomationRule(
    val targetPackage: String,
    val buttonText: String,
    val enabled: Boolean = true,
) {
    fun matches(packageName: String?) = enabled && packageName == targetPackage

    val isValid: Boolean
        get() = targetPackage.isNotBlank() && buttonText.isNotBlank()
}

fun List<AutomationRule>.toJson(): String = JSONArray().apply {
    forEach { r ->
        put(
            JSONObject()
                .put("targetPackage", r.targetPackage)
                .put("buttonText", r.buttonText)
                .put("enabled", r.enabled)
        )
    }
}.toString()

fun rulesFromJson(json: String?): List<AutomationRule> {
    if (json.isNullOrBlank()) return emptyList()
    val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
    return (0 until array.length()).map { i ->
        val o = array.getJSONObject(i)
        AutomationRule(
            targetPackage = o.optString("targetPackage"),
            buttonText = o.optString("buttonText"),
            enabled = o.optBoolean("enabled", true),
        )
    }
}
