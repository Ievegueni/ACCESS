package com.comunica.access

import com.comunica.access.model.Confirmation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfirmationTest {

    private val real =
        "Tranferencia KWiK de 500 Kz feita com sucesso para  AO060047******10219, " +
            "Sigla: BRDKAOLU, Nome: IEVEGUENI MANUEL DOS SANTOS. Custo: 26.32 Kz.  " +
            "Taxa: 3.68 Kz. O novo saldo Afrimoney e: 2440.0 Kz. " +
            "TID:: MP260921.2313.B09562. Obrigado por usar o Afrimoney."

    @Test
    fun `le a confirmacao real do operador`() {
        val c = Confirmation.parse(real, 1_000L)!!
        assertEquals("MP260921.2313.B09562", c.tid)
        assertEquals("10219", c.ibanUltimos5)
        assertEquals("500", c.valor)
        assertTrue(c.sucesso)
    }

    @Test
    fun `sms sem TID nao e confirmacao`() {
        assertNull(Confirmation.parse("iban: 004700000872365010219\nvalor: 500", 0L))
        assertNull(Confirmation.parse("O seu codigo e 4821", 0L))
    }

    @Test
    fun `sem a palavra sucesso conta como falha`() {
        val falha = Confirmation.parse("Transferencia nao efetuada. TID:: MP1.2.C3.", 0L)!!
        assertFalse(falha.sucesso)
        assertEquals("MP1.2.C3", falha.tid)
    }

    @Test
    fun `nome e saldo nunca entram no payload`() {
        val json = Confirmation.parse(real, 1_000L)!!.toJson()
        assertFalse(json.contains("IEVEGUENI"))
        assertFalse(json.contains("2440"))
        // E o IBAN vai truncado, nunca inteiro.
        assertFalse(json.contains("AO06"))
        assertTrue(json.contains("10219"))
    }

    @Test
    fun `o numero do telemovel vai no payload quando esta configurado`() {
        val json = Confirmation.parse(real, 1_000L)!!.toJson("923 456 789")
        assertTrue(json.contains("\"numero\":\"923 456 789\""))
    }

    @Test
    fun `a ordem da API vai no payload e so quando existe`() {
        // É o que fecha a ordem no painel. Numa transferência disparada por SMS ou
        // à mão o campo não existe, senão fechava uma ordem que não é esta.
        val c = Confirmation.parse(real, 1_000L)!!
        assertTrue(c.toJson(null, 17).contains("\"ordem_id\":17"))
        assertFalse(c.toJson().contains("ordem_id"))
        assertFalse(c.toJson("923 456 789").contains("ordem_id"))
    }

    @Test
    fun `sem numero configurado o campo nao aparece`() {
        // O servidor distingue "não configurado" de "configurado em branco": sem o
        // campo atribui pelo token, com o campo vazio ficaria sem saber a quem dar.
        val c = Confirmation.parse(real, 1_000L)!!
        assertFalse(c.toJson().contains("numero"))
        assertFalse(c.toJson("").contains("numero"))
        assertFalse(c.toJson("   ").contains("numero"))
    }
}
