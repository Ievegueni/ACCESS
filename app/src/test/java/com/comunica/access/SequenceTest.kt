package com.comunica.access

import com.comunica.access.model.Sequence
import com.comunica.access.model.Step
import com.comunica.access.model.sequencesFromJson
import com.comunica.access.model.smsFields
import com.comunica.access.model.toJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SequenceTest {

    @Test
    fun `round-trip preserva passos, incluindo os vazios`() {
        // Um passo vazio é "só confirmar" — se o JSON o perder, a sequência
        // dessincroniza e as respostas seguintes vão para a caixa errada.
        val original = listOf(
            Sequence("Saldo", "*123#", listOf("1", "", "2")),
            Sequence("Sem passos", "912345678", emptyList()),
        )
        assertEquals(original, sequencesFromJson(original.toJson()))
    }

    @Test
    fun `json invalido ou vazio nao rebenta`() {
        assertEquals(emptyList<Sequence>(), sequencesFromJson(null))
        assertEquals(emptyList<Sequence>(), sequencesFromJson(""))
        assertEquals(emptyList<Sequence>(), sequencesFromJson("isto não é json"))
    }

    @Test
    fun `passo sem separador nao tem verificacao`() {
        assertEquals(Step(null, "1"), Step.parse("1"))
        assertEquals(Step(null, "5000"), Step.parse("  5000  "))
    }

    @Test
    fun `passo com separador extrai texto esperado e resposta`() {
        assertEquals(Step("Menu principal", "1"), Step.parse("Menu principal > 1"))
        // Sem resposta = só confirmar, mas continua a exigir a caixa certa.
        assertEquals(Step("Sucesso", ""), Step.parse("Sucesso >"))
    }

    @Test
    fun `trigger de sms so dispara com o texto configurado`() {
        val seq = Sequence("Levantar", "*777#", listOf("1"), smsContains = "codigo")
        assertTrue(seq.triggeredBy("O seu CODIGO e 4821"))
        assertFalse(seq.triggeredBy("Saldo disponivel: 500"))
        // Sem smsContains a sequência nunca é disparada por SMS.
        assertFalse(seq.copy(smsContains = null).triggeredBy("O seu codigo e 4821"))
    }

    @Test
    fun `marcador isolado extrai o codigo que vem a seguir`() {
        val seq = Sequence("Levantar", "*777#", listOf("1"), smsContains = "codigo")
        // O primeiro grupo de 4 a 8 dígitos — não o "2" solto.
        assertEquals("4821", seq.extractFrom("Op 2: o seu codigo e 4821, valido 5min"))
        assertEquals(null, seq.extractFrom("sem numeros aqui"))
        // Com grupo de captura devolve o grupo, não o match inteiro.
        assertEquals("99", seq.copy(smsExtract = "ref (\\d+)").extractFrom("ref 99 paga"))
    }

    @Test
    fun `marcador colado ao valor traz o bloco inteiro`() {
        // O caso do IBAN: "AO06" é o princípio do valor, não contexto.
        val iban = Sequence("Transferir", "*777#", listOf("1"), smsContains = "AO06")
        assertEquals(
            "AO06004000012345678910157",
            iban.extractFrom("Pague para AO06004000012345678910157 ate sexta"),
        )
        // Não pode arrastar o resto da frase.
        assertFalse(iban.extractFrom("Pague para AO0600400001 obrigado")!!.contains("obrigado"))
        // E o IBAN no fim da mensagem funciona na mesma.
        assertEquals("AO0600400001", iban.extractFrom("IBAN: AO0600400001"))
    }

    @Test
    fun `campos do sms em linhas separadas`() {
        val fields = smsFields("iban: AO06004000012345678910157\nvalor: 5000")
        assertEquals("AO06004000012345678910157", fields["iban"])
        assertEquals("5000", fields["valor"])
    }

    @Test
    fun `campos do sms na mesma linha`() {
        // O valor de um campo não pode engolir a etiqueta seguinte.
        val fields = smsFields("iban: AO0600400001 valor: 5000")
        assertEquals("AO0600400001", fields["iban"])
        assertEquals("5000", fields["valor"])
    }

    @Test
    fun `etiquetas sao insensiveis a maiusculas e ao espaco`() {
        val fields = smsFields("IBAN:AO0600400001\nValor : 250")
        assertEquals("AO0600400001", fields["iban"])
        assertEquals("250", fields["valor"])
    }

    @Test
    fun `sms sem etiquetas nao inventa campos`() {
        assertEquals(emptyMap<String, String>(), smsFields("Pagamento efetuado com sucesso"))
    }

    @Test
    fun `avisa quando passos usam campos do sms sem trigger`() {
        val steps = listOf("1", "{iban}", "{valor}")
        val semTrigger = Sequence("kwik", "*777#", steps)
        assertEquals(listOf("iban", "valor"), semTrigger.placeholders)
        assertTrue(semTrigger.smsTriggerMissing)

        assertFalse(semTrigger.copy(smsContains = "iban").smsTriggerMissing)
        // Sem placeholders não há nada a avisar.
        assertFalse(Sequence("saldo", "*123#", listOf("1")).smsTriggerMissing)
    }

    @Test
    fun `validade exige nome e numero`() {
        assertTrue(Sequence("Saldo", "*123#", emptyList()).isValid)
        assertFalse(Sequence("", "*123#", listOf("1")).isValid)
        assertFalse(Sequence("Saldo", "  ", listOf("1")).isValid)
    }
}
