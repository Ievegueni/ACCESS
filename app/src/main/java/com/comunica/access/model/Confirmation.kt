package com.comunica.access.model

import org.json.JSONObject

/**
 * Uma confirmação de transferência lida do SMS do operador.
 *
 * Só os campos necessários ao painel: o SMS traz ainda o nome do titular e o
 * saldo da conta, que ficam de fora de propósito — o que não é enviado não pode
 * ser exposto se o servidor for comprometido.
 */
data class Confirmation(
    val tid: String,
    val ibanUltimos5: String?,
    val valor: String?,
    val sucesso: Boolean,
    val momento: Long,
) {
    /**
     * [numero] é o número do SIM deste telemóvel, escrito à mão nas definições.
     *
     * Não se lê do sistema de propósito: `TelephonyManager.getLine1Number()` devolve
     * vazio na maioria dos operadores e exige permissão de telefonia. Um campo de
     * texto funciona sempre e não pede nada.
     *
     * É o que permite ao painel saber de que telemóvel veio a transferência. Em
     * branco, o payload sai sem o campo e o servidor atribui pelo token.
     */
    fun toJson(numero: String? = null, ordemId: Int? = null): String = JSONObject()
        .put("tid", tid)
        .put("iban_ultimos5", ibanUltimos5)
        .put("valor", valor)
        .put("estado", if (sucesso) "sucesso" else "falha")
        .put("momento", momento)
        .apply { numero?.trim()?.takeIf { it.isNotEmpty() }?.let { put("numero", it) } }
        // Só quando a transferência veio de uma ordem da API: é o que a fecha no
        // painel. Omitido, não vazio, nos outros casos.
        .apply { ordemId?.let { put("ordem_id", it) } }
        .toString()

    companion object {
        /**
         * Devolve null se a mensagem não for uma confirmação.
         *
         * O TID é o que a identifica: aparece em todas as confirmações e em mais
         * nenhum SMS. O estado vem da presença de "sucesso" — não conheço ainda o
         * texto exato de uma falha, por isso tudo o que traz TID sem "sucesso" é
         * tratado como falha, que é o lado seguro para um registo.
         */
        fun parse(message: String, momento: Long): Confirmation? {
            val tid = TID.find(message)?.groupValues?.get(1)?.trimEnd('.') ?: return null

            // Do IBAN mascarado (AO060047******10219) só interessam os dígitos finais.
            val iban = IBAN.find(message)?.value
                ?.takeLastWhile { it.isDigit() }
                ?.takeLast(5)
                ?.takeIf { it.length == 5 }

            return Confirmation(
                tid = tid,
                ibanUltimos5 = iban,
                valor = VALOR.find(message)?.groupValues?.get(1),
                sucesso = message.contains("sucesso", ignoreCase = true),
                momento = momento,
            )
        }

        // "TID::" traz dois pontos a dobrar no SMS real, daí o ':+'.
        private val TID = Regex("""TID:+\s*([A-Za-z0-9.\-]+)""")
        private val IBAN = Regex("""AO\d{2}[\d*]+""")
        private val VALOR = Regex("""\bde\s+([\d.,]+)\s*Kz""", RegexOption.IGNORE_CASE)
    }
}
