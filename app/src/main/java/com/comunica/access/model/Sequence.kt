package com.comunica.access.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * Uma sequência USSD: marcar [dial] e depois responder aos menus por ordem.
 *
 * Cada entrada de [steps] é o que escrever na caixa seguinte ("1", "2", "5000"...).
 * Um passo vazio significa "não escrever nada, só confirmar" — para os ecrãs
 * informativos que só têm OK.
 */
data class Sequence(
    val name: String,
    val dial: String,
    val steps: List<String>,
    /** Se preenchido, um SMS que contenha este texto dispara a sequência. */
    val smsContains: String? = null,
    /** Regex para extrair do SMS o valor que os passos usam como `{sms}`. */
    val smsExtract: String? = null,
) {
    val isValid: Boolean
        get() = name.isNotBlank() && dial.isNotBlank()

    /** Campos que os passos esperam do SMS, ex. `{iban}` → "iban". */
    val placeholders: List<String>
        get() = PLACEHOLDER.findAll(steps.joinToString(" "))
            .map { it.groupValues[1].lowercase() }
            .distinct()
            .toList()

    /**
     * Passos que dependem do SMS sem trigger configurado: o receiver nunca
     * reclama a mensagem e a sequência fica à espera de campos que não chegam.
     */
    val smsTriggerMissing: Boolean
        get() = placeholders.any { it != "sms" } && smsContains.isNullOrBlank()

    fun triggeredBy(message: String): Boolean =
        !smsContains.isNullOrBlank() && message.contains(smsContains, ignoreCase = true)

    /**
     * O valor a injectar nos passos.
     *
     * Com [smsExtract] manda o regex. Sem ele, há dois casos e distinguem-se
     * sozinhos pelo que vem colado ao marcador:
     *  - "AO06..." com marcador "AO06" → o marcador é o início do valor (um IBAN),
     *    e `\S+` exige pelo menos mais um caractere, devolvendo o bloco todo.
     *  - "o seu codigo e 4821" com marcador "codigo" → o marcador aparece isolado,
     *    `\S+` não casa, e cai-se no primeiro número de 4 a 8 dígitos.
     */
    fun extractFrom(message: String): String? {
        smsExtract?.takeIf { it.isNotBlank() }?.let { pattern ->
            val regex = runCatching { Regex(pattern) }.getOrNull() ?: return null
            val match = regex.find(message) ?: return null
            // Com grupo de captura devolve o grupo; sem ele, o match inteiro.
            return match.groupValues.getOrNull(1)?.ifEmpty { null } ?: match.value
        }

        smsContains?.takeIf { it.isNotBlank() }?.let { marker ->
            val glued = Regex(Regex.escape(marker) + "\\S+", RegexOption.IGNORE_CASE)
            glued.find(message)?.let { return it.value }
        }

        return Regex(DEFAULT_EXTRACT).find(message)?.value
    }

    private companion object {
        const val DEFAULT_EXTRACT = "\\d{4,8}"
    }
}

/**
 * Lê os campos etiquetados de um SMS: `iban: AO06...` fica disponível nos passos
 * como `{iban}`.
 *
 * O valor de cada campo vai até à etiqueta seguinte ou ao fim da mensagem, por
 * isso funciona tanto em linhas separadas como tudo seguido na mesma linha.
 * Consequência a ter presente: texto solto depois do último campo entra nesse
 * campo — o SMS tem de acabar no valor.
 */
fun smsFields(message: String): Map<String, String> =
    FIELD.findAll(message).associate { match ->
        match.groupValues[1].lowercase() to match.groupValues[2].trim()
    }

// A chaveta de fecho tem de vir escapada: o Android compila regex com ICU, que
// rejeita '}' solto — ao contrário da JVM onde os testes correm.
private val PLACEHOLDER = Regex("""\{([\p{L}\w]+)\}""")

private val FIELD = Regex(
    """([\p{L}\w]+)\s*:\s*(.*?)(?=\s*[\p{L}\w]+\s*:|$)""",
    RegexOption.DOT_MATCHES_ALL,
)

/**
 * Um passo já interpretado: responder [answer], mas só se a caixa no ecrã contiver
 * [expect]. Escreve-se `texto esperado > resposta`; sem `>` não há verificação.
 *
 * Guardamos os passos como texto cru para o JSON não mudar de forma — a
 * interpretação é feita aqui.
 */
data class Step(val expect: String?, val answer: String) {
    companion object {
        fun parse(raw: String): Step {
            val cut = raw.indexOf('>')
            if (cut < 0) return Step(null, raw.trim())
            return Step(
                expect = raw.take(cut).trim().ifEmpty { null },
                answer = raw.substring(cut + 1).trim(),
            )
        }
    }
}

fun List<Sequence>.toJson(): String = JSONArray().apply {
    forEach { s ->
        put(
            JSONObject()
                .put("name", s.name)
                .put("dial", s.dial)
                .put("steps", JSONArray(s.steps))
                .put("smsContains", s.smsContains)
                .put("smsExtract", s.smsExtract)
        )
    }
}.toString()

fun sequencesFromJson(json: String?): List<Sequence> {
    if (json.isNullOrBlank()) return emptyList()
    val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
    return (0 until array.length()).map { i ->
        val o = array.getJSONObject(i)
        val steps = o.optJSONArray("steps")
        Sequence(
            name = o.optString("name"),
            dial = o.optString("dial"),
            steps = (0 until (steps?.length() ?: 0)).map { steps!!.optString(it) },
            // optString devolve "null" (texto) quando o JSON tem null literal.
            smsContains = o.optString("smsContains").takeIf { it.isNotBlank() && it != "null" },
            smsExtract = o.optString("smsExtract").takeIf { it.isNotBlank() && it != "null" },
        )
    }
}
