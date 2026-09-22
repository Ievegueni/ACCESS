package com.comunica.access.accessibility

import android.view.accessibility.AccessibilityNodeInfo

object NodeFinder {

    /** Procura por texto visível ou contentDescription (case-insensitive, match exato após trim). */
    fun findNodeByText(node: AccessibilityNodeInfo?, text: String): AccessibilityNodeInfo? {
        if (node == null) return null
        val wanted = text.trim()
        if (node.text?.toString()?.trim().equals(wanted, ignoreCase = true) ||
            node.contentDescription?.toString()?.trim().equals(wanted, ignoreCase = true)
        ) {
            return node
        }
        for (i in 0 until node.childCount) {
            findNodeByText(node.getChild(i), wanted)?.let { return it }
        }
        return null
    }

    fun findNodeByViewId(node: AccessibilityNodeInfo?, id: String): AccessibilityNodeInfo? =
        first(node) { it.viewIdResourceName == id }

    /** O campo de resposta de uma caixa USSD. */
    fun findEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? =
        first(node) { it.isEditable }

    private fun first(
        node: AccessibilityNodeInfo?,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        if (node == null) return null
        if (predicate(node)) return node
        for (i in 0 until node.childCount) {
            first(node.getChild(i), predicate)?.let { return it }
        }
        return null
    }
}
