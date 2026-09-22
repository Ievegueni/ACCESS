package com.comunica.access.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.comunica.access.data.RulesStore
import com.comunica.access.isServiceEnabled
import com.comunica.access.model.AutomationRule
import com.comunica.access.model.Sequence
import com.comunica.access.webhook.WebhookConfig
import com.comunica.access.webhook.WebhookQueue
import com.comunica.access.webhook.WebhookSender

@Composable
fun MainScreen(onOpenSettings: () -> Unit, onRun: (Sequence) -> Unit) {
    val context = LocalContext.current
    var serviceOn by remember { mutableStateOf(isServiceEnabled(context)) }
    var rules by remember { mutableStateOf(RulesStore.load(context)) }
    var sequences by remember { mutableStateOf(RulesStore.loadSequences(context)) }
    var editing by remember { mutableStateOf<Int?>(null) }
    var history by remember { mutableStateOf(RulesStore.history(context)) }

    // Reavalia o estado ao voltar das Definições.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                serviceOn = isServiceEnabled(context)
                history = RulesStore.history(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    fun update(newRules: List<AutomationRule>) {
        rules = newRules
        RulesStore.save(context, newRules)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text("Access", style = MaterialTheme.typography.headlineMedium)
            Text(
                if (serviceOn) "Serviço ativo" else "Serviço inativo — ativar em Definições > Acessibilidade",
                color = if (serviceOn) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
            Button(onClick = onOpenSettings, modifier = Modifier.padding(top = 8.dp)) {
                Text("Abrir Definições de Acessibilidade")
            }
        }

        item { HorizontalDivider() }
        item { Text("Regras", style = MaterialTheme.typography.titleMedium) }

        itemsIndexed(rules) { index, rule ->
            RuleCard(
                rule = rule,
                onToggle = { update(rules.toMutableList().also { it[index] = rule.copy(enabled = !rule.enabled) }) },
                onDelete = { update(rules.toMutableList().also { it.removeAt(index) }) },
            )
        }

        item { NewRuleForm(onAdd = { update(rules + it) }) }

        item { HorizontalDivider() }
        item { Text("Sequências USSD", style = MaterialTheme.typography.titleMedium) }

        itemsIndexed(sequences) { index, sequence ->
            if (editing == index) {
                SequenceForm(
                    initial = sequence,
                    onSave = {
                        sequences = sequences.toMutableList().also { list -> list[index] = it }
                        RulesStore.saveSequences(context, sequences)
                        editing = null
                    },
                    onCancel = { editing = null },
                )
            } else {
                SequenceCard(
                    sequence = sequence,
                    onRun = { onRun(sequence) },
                    onEdit = { editing = index },
                    onDelete = {
                        sequences = sequences.toMutableList().also { it.removeAt(index) }
                        RulesStore.saveSequences(context, sequences)
                        editing = null
                    },
                )
            }
        }

        if (editing == null) {
            item {
                SequenceForm(
                    initial = null,
                    onSave = {
                        sequences = sequences + it
                        RulesStore.saveSequences(context, sequences)
                    },
                    onCancel = null,
                )
            }
        }

        item { HorizontalDivider() }
        item { WebhookCard() }

        item { HorizontalDivider() }
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Histórico", style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = {
                    RulesStore.clearHistory(context)
                    history = emptyList()
                }) { Text("Limpar") }
            }
        }
        if (history.isEmpty()) {
            item { Text("Sem execuções registadas.", style = MaterialTheme.typography.bodySmall) }
        } else {
            items(history) { line ->
                Text(line, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Endpoint do painel e estado da fila de confirmações por entregar. */
@Composable
private fun WebhookCard() {
    val context = LocalContext.current
    val prefs = RulesStore.prefs(context)
    var url by remember { mutableStateOf(prefs.getString(WebhookConfig.KEY_URL, "").orEmpty()) }
    var token by remember { mutableStateOf(prefs.getString(WebhookConfig.KEY_TOKEN, "").orEmpty()) }
    var numero by remember { mutableStateOf(prefs.getString(WebhookConfig.KEY_NUMERO, "").orEmpty()) }
    var pendentes by remember { mutableStateOf(WebhookQueue.size(context)) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Painel (webhook)", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = url,
                onValueChange = {
                    url = it
                    prefs.edit().putString(WebhookConfig.KEY_URL, it.trim()).apply()
                },
                label = { Text("URL do endpoint") },
                singleLine = true,
                isError = url.isNotBlank() && !url.trim().startsWith("https://"),
                supportingText = { Text("Tem de ser https:// — leva dados de transações") },
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token,
                onValueChange = {
                    token = it
                    prefs.edit().putString(WebhookConfig.KEY_TOKEN, it.trim()).apply()
                },
                label = { Text("Token (enviado como Bearer)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = numero,
                onValueChange = {
                    numero = it
                    prefs.edit().putString(WebhookConfig.KEY_NUMERO, it.trim()).apply()
                },
                label = { Text("Número deste telemóvel") },
                singleLine = true,
                supportingText = { Text("É por ele que o painel sabe de quem é a transferência") },
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Phone,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (pendentes == 0) "Nada por entregar" else "$pendentes por entregar",
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = {
                    WebhookSender.flush(context)
                    pendentes = WebhookQueue.size(context)
                }) { Text("Enviar agora") }
            }
        }
    }
}

@Composable
private fun RuleCard(rule: AutomationRule, onToggle: () -> Unit, onDelete: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(rule.targetPackage, style = MaterialTheme.typography.bodyLarge)
                Text("\"${rule.buttonText}\"", style = MaterialTheme.typography.bodySmall)
            }
            Switch(checked = rule.enabled, onCheckedChange = { onToggle() })
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Remover regra")
            }
        }
    }
}

@Composable
private fun SequenceCard(
    sequence: Sequence,
    onRun: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(sequence.name, style = MaterialTheme.typography.bodyLarge)
                Text(
                    "${sequence.dial} → ${sequence.steps.joinToString(", ").ifEmpty { "sem passos" }}",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (sequence.smsTriggerMissing) {
                    Text(
                        "Usa ${sequence.placeholders.joinToString(", ") { "{$it}" }} " +
                            "mas falta o texto do trigger por SMS",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Button(onClick = onRun) { Text("Executar") }
            IconButton(onClick = onEdit) {
                Icon(Icons.Default.Edit, contentDescription = "Editar sequência")
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Remover sequência")
            }
        }
    }
}

/**
 * Cria ([initial] null) ou edita uma sequência. O mesmo formulário serve os dois
 * casos — só mudam o título, o botão e o que acontece depois de guardar.
 */
@Composable
private fun SequenceForm(
    initial: Sequence?,
    onSave: (Sequence) -> Unit,
    onCancel: (() -> Unit)?,
) {
    // Com chave em [initial]: ao trocar de sequência a editar, os campos recarregam.
    var name by remember(initial) { mutableStateOf(initial?.name.orEmpty()) }
    var dial by remember(initial) { mutableStateOf(initial?.dial.orEmpty()) }
    var steps by remember(initial) {
        mutableStateOf(initial?.steps?.joinToString(", ").orEmpty())
    }
    var smsContains by remember(initial) { mutableStateOf(initial?.smsContains.orEmpty()) }
    var smsExtract by remember(initial) { mutableStateOf(initial?.smsExtract.orEmpty()) }

    fun build() = Sequence(
        name = name.trim(),
        dial = dial.trim(),
        steps = steps.split(",").map { it.trim() }.filter { it.isNotEmpty() },
        smsContains = smsContains.trim().ifBlank { null },
        smsExtract = smsExtract.trim().ifBlank { null },
    )

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                if (initial == null) "Nova sequência" else "Editar sequência",
                style = MaterialTheme.typography.titleSmall,
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Nome") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = dial,
                onValueChange = { dial = it },
                label = { Text("Número ou código USSD") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = steps,
                onValueChange = { steps = it },
                label = { Text("Respostas, por ordem (ex: 1, 2, 5000)") },
                supportingText = {
                    Text(
                        "Verificar a caixa: Menu > 1. " +
                            "Campos do SMS pelo nome: {iban}, {valor}"
                    )
                },
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = smsContains,
                onValueChange = { smsContains = it },
                label = { Text("Disparar com SMS que contenha (opcional)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            if (smsContains.isNotBlank()) {
                OutlinedTextField(
                    value = smsExtract,
                    onValueChange = { smsExtract = it },
                    label = { Text("Extrair do SMS (regex, opcional)") },
                    singleLine = true,
                    supportingText = {
                        Text(
                            "Vazio: se o texto acima vier colado ao valor (AO06…), leva o " +
                                "bloco todo; se vier isolado, leva o primeiro número."
                        )
                    },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        onSave(build())
                        if (initial == null) { name = ""; dial = ""; steps = "" }
                    },
                    enabled = build().isValid,
                ) { Text(if (initial == null) "Guardar" else "Guardar alterações") }

                if (onCancel != null) {
                    TextButton(onClick = onCancel) { Text("Cancelar") }
                }
            }
        }
    }
}

@Composable
private fun NewRuleForm(onAdd: (AutomationRule) -> Unit) {
    var pkg by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Nova regra", style = MaterialTheme.typography.titleSmall)
            // Sem autocorreção: o teclado transformava "com.android.settings"
            // em "com. Android. settings" e a regra nunca correspondia.
            OutlinedTextField(
                value = pkg,
                onValueChange = { pkg = it },
                label = { Text("Package da app-alvo") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("Texto do botão") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    onAdd(AutomationRule(pkg.trim(), text.trim()))
                    pkg = ""; text = ""
                },
                enabled = AutomationRule(pkg.trim(), text.trim()).isValid,
            ) { Text("Adicionar") }
        }
    }
}
