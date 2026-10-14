package com.comunica.access

import com.comunica.access.model.Saldo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SaldoTest {

    @Test
    fun `le o saldo da consulta`() {
        assertEquals("2440.0", Saldo.parse("O seu saldo Afrimoney e: 2440.0 Kz. Obrigado"))
        // Caixa final real do *777# → 6 → 1 (Africell, 2026-10-14)
        assertEquals("199011.99", Saldo.parse("Mensagem Africell O teu saldo Afrimoney disponivel e 199011.99 Kz. OK"))
        assertEquals("5.000,00", Saldo.parse("Saldo disponivel: 5.000,00 Kz OK"))
        assertEquals("120", Saldo.parse("Tem 120 Kz na sua conta"))
    }

    @Test
    fun `sem numero nao inventa`() {
        assertNull(Saldo.parse("Servico indisponivel tente mais tarde"))
        assertNull(Saldo.parse("1. Transferir 2. Saldo"))
    }
}
