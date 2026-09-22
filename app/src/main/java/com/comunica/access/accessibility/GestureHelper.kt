package com.comunica.access.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

object GestureHelper {

    /**
     * Clica no nó. Se o próprio nó não for clicável, sobe na árvore à procura de
     * um pai clicável; em último caso faz tap nas coordenadas do nó.
     */
    fun clickNode(service: AccessibilityService, node: AccessibilityNodeInfo): Boolean {
        var candidate: AccessibilityNodeInfo? = node
        while (candidate != null) {
            if (candidate.isClickable && candidate.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            candidate = candidate.parent
        }
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        if (bounds.isEmpty) return false
        return tapAt(service, bounds.exactCenterX(), bounds.exactCenterY())
    }

    private fun tapAt(service: AccessibilityService, x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()
        return service.dispatchGesture(gesture, null, null)
    }
}
