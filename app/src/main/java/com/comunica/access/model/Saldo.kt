package com.comunica.access.model

/**
 * Lê o saldo da caixa (ou do SMS) da consulta de saldo da carteira, ex.
 * "O seu saldo Afrimoney e: 2440.0 Kz". Devolve o número como vem no texto: quem
 * o interpreta (pontos de milhares, vírgula decimal) é o painel, como no SMS.
 */
object Saldo {
    fun parse(text: String): String? =
        (APOS_SALDO.find(text) ?: ANTES_KZ.find(text))
            ?.groupValues?.get(1)
            ?.trimEnd('.', ',')
            ?.takeIf { it.any(Char::isDigit) && it.length <= 20 }

    private val APOS_SALDO = Regex("""saldo\D{0,40}?(\d[\d.,]*)""", RegexOption.IGNORE_CASE)
    private val ANTES_KZ = Regex("""(\d[\d.,]*)\s*(?:Kz|AOA)\b""", RegexOption.IGNORE_CASE)
}
