package mx.edu.eta15.prefectura.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import mx.edu.eta15.prefectura.BuildConfig
import mx.edu.eta15.prefectura.R

private val EsMx: Locale = Locale.forLanguageTag("es-MX")

/** Ejemplo: "martes, 27 de octubre de 2026". */
fun formatSchoolDate(date: LocalDate): String =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(EsMx).format(date)

/** Marco comun: barra superior tinto, aviso de demostracion (solo debug) y contenido con margenes comodos. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EtaScaffold(
    title: String,
    onBack: (() -> Unit)? = null,
    snackbarHostState: SnackbarHostState? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(title, modifier = Modifier.semantics { heading() }) },
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        titleContentColor = MaterialTheme.colorScheme.onPrimary,
                        navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                )
                if (BuildConfig.DEMO_MODE) DemoBanner()
            }
        },
        snackbarHost = { if (snackbarHostState != null) SnackbarHost(snackbarHostState) },
        containerColor = MaterialTheme.colorScheme.background,
        content = content,
    )
}

@Composable
fun DemoBanner(modifier: Modifier = Modifier) {
    Surface(color = Color(0xFFFFF0C2), modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(
                stringResource(R.string.demo_banner_title),
                style = MaterialTheme.typography.labelLarge,
                color = Color(0xFF4A3B00),
            )
            Text(
                stringResource(R.string.demo_banner_detail),
                style = MaterialTheme.typography.labelMedium,
                color = Color(0xFF4A3B00),
            )
        }
    }
}

/** Distintivo permanente de captura local: NO significa registrada en la escuela ni sincronizada. */
@Composable
fun LocalSaveBadge(modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary),
        modifier = modifier.semantics(mergeDescendants = true) {},
    ) {
        Text(
            stringResource(R.string.badge_saved_locally),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

/**
 * ESPACIO RESERVADO para el logotipo oficial de la escuela (aun no disponible). No es un logotipo: es una caja neutra
 * con las siglas del nombre del proyecto. Sustituir por el recurso oficial cuando exista.
 */
@Composable
fun BrandMarkPlaceholder(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(88.dp)
            .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(20.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "ETA 15",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    }
}

@Composable
fun LoadingView(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

/** Mensaje central para estados vacios, bloqueos y errores. */
@Composable
fun MessageView(
    title: String,
    detail: String? = null,
    isError: Boolean = false,
    modifier: Modifier = Modifier,
    actions: @Composable (() -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            if (isError) Icons.Filled.Warning else Icons.Filled.Info,
            contentDescription = null,
            tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(40.dp),
        )
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp),
        )
        if (detail != null) {
            Text(
                detail,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (actions != null) {
            Row(Modifier.padding(top = 16.dp)) { actions() }
        }
    }
}

/** Aviso informativo en linea (por ejemplo, "sin sincronizacion"). */
@Composable
fun InfoNotice(text: String, modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
    }
}
