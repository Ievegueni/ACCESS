package com.comunica.access.model

import java.text.Normalizer

/**
 * A caixa de erro do operador: "Serviço indisponível, tente mais tarde" e afins.
 *
 * Só tem OK, por isso o passo seguinte (que espera um campo de texto) nunca
 * avançava: o runner ficava 5 minutos parado e a ordem expirava como
 * `sem_confirmacao`, que manda não repetir. Ver BACKOFFICE.md §8.
 */
object UssdFailure {

    /**
     * Pedaços de texto, sem acentos e em minúsculas. Estritos de propósito: uma
     * caixa informativa confundida com erro corta uma sequência que estava a
     * correr bem. "mais tarde" sozinho, por exemplo, aparece em avisos normais.
     */
    private val MARCAS = listOf(
        "indispon",
        "tente mais tarde",
        "tente novamente mais tarde",
        "erro de ligacao",
        "problema de ligacao",
        "mmi invalido",
        "connection problem",
        "invalid mmi",
        "unavailable",
        "try again later",
    )

    /** O texto de uma caixa sem campo para escrever é um erro do operador? */
    fun matches(text: String): Boolean {
        val simples = Normalizer.normalize(text, Normalizer.Form.NFD)
            .replace(ACENTOS, "")
            .lowercase()
        return MARCAS.any { it in simples }
    }

    /**
     * Repetir é seguro? Só se o valor ainda não foi escrito: sem ele o operador
     * não pode ter submetido nada. [answered] é quantos passos já foram
     * respondidos.
     *
     * Numa sequência sem `{valor}` não se sabe onde está o compromisso, por isso
     * só conta como seguro o erro logo à marcação, antes de qualquer resposta.
     */
    fun beforeValue(steps: List<String>, answered: Int): Boolean {
        val valueAt = steps.indexOfFirst { it.contains("{valor}", ignoreCase = true) }
        return if (valueAt < 0) answered == 0 else answered <= valueAt
    }

    private val ACENTOS = Regex("\\p{M}+")
}
