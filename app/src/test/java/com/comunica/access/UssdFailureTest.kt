package com.comunica.access

import com.comunica.access.model.UssdFailure
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UssdFailureTest {

    @Test
    fun `reconhece a caixa de erro do operador, com ou sem acentos`() {
        // O texto que apareceu no teste de 2026-09-24.
        assertTrue(UssdFailure.matches("Serviço indisponível tente mais tarde OK"))
        assertTrue(UssdFailure.matches("SERVICO INDISPONIVEL"))
        assertTrue(UssdFailure.matches("Problema de ligação ou código MMI inválido."))
        assertTrue(UssdFailure.matches("Connection problem or invalid MMI code."))
    }

    @Test
    fun `nao confunde menus e avisos normais com erro`() {
        // "disponível" contém "dispon" mas não "indispon".
        assertFalse(UssdFailure.matches("Saldo disponível: 5000 Kz"))
        assertFalse(UssdFailure.matches("1. Transferir 2. Saldo 3. Pagamentos"))
        assertFalse(UssdFailure.matches("Receberá um SMS mais tarde com o comprovativo"))
    }

    @Test
    fun `seguro repetir so antes de o valor ser escrito`() {
        val steps = listOf("1", "{iban}", "{valor}", "{pin}", "1")
        assertTrue("erro à marcação", UssdFailure.beforeValue(steps, 0))
        assertTrue("iban escrito, valor não", UssdFailure.beforeValue(steps, 2))
        assertFalse("valor já foi", UssdFailure.beforeValue(steps, 3))
        assertFalse("já confirmou", UssdFailure.beforeValue(steps, 5))
    }

    @Test
    fun `sem valor na sequencia so o erro a marcacao e seguro`() {
        val steps = listOf("1", "{sms}", "")
        assertTrue(UssdFailure.beforeValue(steps, 0))
        assertFalse(UssdFailure.beforeValue(steps, 1))
    }
}
