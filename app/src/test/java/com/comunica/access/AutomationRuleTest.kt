package com.comunica.access

import com.comunica.access.model.AutomationRule
import com.comunica.access.model.rulesFromJson
import com.comunica.access.model.toJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AutomationRuleTest {

    @Test
    fun `round trip preserva as regras`() {
        val rules = listOf(
            AutomationRule("com.exemplo.app", "Continuar"),
            AutomationRule("com.outra.app", buttonText = "Ok", enabled = false),
        )
        assertEquals(rules, rulesFromJson(rules.toJson()))
    }

    @Test
    fun `json invalido ou vazio devolve lista vazia`() {
        assertEquals(emptyList<AutomationRule>(), rulesFromJson(null))
        assertEquals(emptyList<AutomationRule>(), rulesFromJson("lixo"))
    }

    @Test
    fun `matches so para o pacote alvo e regras ativas`() {
        val rule = AutomationRule("com.exemplo.app", "Continuar")
        assertTrue(rule.matches("com.exemplo.app"))
        assertFalse(rule.matches("com.outra.app"))
        assertFalse(rule.matches(null))
        assertFalse(rule.copy(enabled = false).matches("com.exemplo.app"))
    }

    @Test
    fun `regra sem alvo de clique e invalida`() {
        assertFalse(AutomationRule("com.exemplo.app", buttonText = "").isValid)
        assertFalse(AutomationRule("", buttonText = "Ok").isValid)
        assertTrue(AutomationRule("com.exemplo.app", buttonText = "Ok").isValid)
    }
}
