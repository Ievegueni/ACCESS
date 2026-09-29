package com.comunica.access

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import com.comunica.access.accessibility.AutomationService
import com.comunica.access.accessibility.SequenceRunner
import com.comunica.access.data.RulesStore
import com.comunica.access.model.Sequence
import com.comunica.access.ui.MainScreen
import com.comunica.access.webhook.WebhookSender

class MainActivity : ComponentActivity() {

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val sequence = pending
            pending = null
            // RECEIVE_SMS só faz falta ao trigger; para marcar basta CALL_PHONE.
            if (sequence != null && result[Manifest.permission.CALL_PHONE] == true) {
                SequenceLauncher.launch(this, sequence)
            }
        }

    /** Sequência a marcar assim que a permissão CALL_PHONE for concedida. */
    private var pending: Sequence? = null

    override fun onResume() {
        super.onResume()
        // Uma das duas ocasiões em que a fila é esvaziada (a outra é a chegada de
        // um SMS): sem rede na altura da confirmação, é aqui que ela sai.
        WebhookSender.flush(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                MainScreen(
                    onOpenSettings = {
                        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    },
                    onRun = ::run,
                )
            }
        }
    }

    private fun run(sequence: Sequence) {
        // À mão não há SMS nem ordem para preencher `{iban}`, `{valor}`...: a
        // sequência parava nessa caixa e bloqueava as ordens durante 5 minutos.
        if (sequence.placeholders.isNotEmpty()) {
            val campos = sequence.placeholders.joinToString(", ") { "{$it}" }
            aviso("${sequence.name} usa $campos — só corre por ordem da API ou SMS")
            return
        }
        // Reiniciar o runner apagava os campos da ordem em curso, ou a ordem que
        // espera o SMS de confirmação.
        if (SequenceRunner.running) {
            aviso("${SequenceRunner.name} ainda está a correr (${SequenceRunner.progress})")
            return
        }
        if (SequenceRunner.awaitingConfirmation) {
            aviso("${SequenceRunner.name} à espera do SMS de confirmação")
            return
        }

        val needed = buildList {
            if (!granted(Manifest.permission.CALL_PHONE)) add(Manifest.permission.CALL_PHONE)
            // Só pedida para sequências que dependem do trigger por SMS.
            if (!sequence.smsContains.isNullOrBlank() && !granted(Manifest.permission.RECEIVE_SMS)) {
                add(Manifest.permission.RECEIVE_SMS)
            }
        }

        if (needed.isEmpty()) {
            SequenceLauncher.launch(this, sequence)
        } else {
            pending = sequence
            requestPermissions.launch(needed.toTypedArray())
        }
    }

    private fun aviso(texto: String) {
        Toast.makeText(this, texto, Toast.LENGTH_LONG).show()
        RulesStore.log(this, texto)
    }

    private fun granted(permission: String) =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}

/** Verifica se o AutomationService está ativo nas Definições > Acessibilidade. */
fun isServiceEnabled(context: Context): Boolean {
    val expected = ComponentName(context, AutomationService::class.java)
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ).orEmpty()
    // unflattenFromString trata tanto "pkg/pkg.Classe" como a forma abreviada "pkg/.Classe",
    // que alguns fabricantes gravam nesta definição.
    return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
}
