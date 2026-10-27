package mx.edu.eta15.prefectura.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Paleta tinto y blanco. Los colores NO son el unico canal de informacion: siempre hay texto o icono. */
val Tinto = Color(0xFF7A1F3D)
val TintoOscuro = Color(0xFF55122A)
val TintoClaro = Color(0xFFF6E3E9)
val Blanco = Color(0xFFFFFFFF)
val VerdePresente = Color(0xFF1B6B3A)
val VerdePresenteClaro = Color(0xFFDDF1E4)

private val Scheme = lightColorScheme(
    primary = Tinto,
    onPrimary = Blanco,
    primaryContainer = TintoClaro,
    onPrimaryContainer = TintoOscuro,
    secondary = Color(0xFF6B4A55),
    onSecondary = Blanco,
    secondaryContainer = Color(0xFFF1E2E7),
    onSecondaryContainer = Color(0xFF3A1F29),
    tertiary = VerdePresente,
    onTertiary = Blanco,
    tertiaryContainer = VerdePresenteClaro,
    onTertiaryContainer = Color(0xFF0A3A1E),
    background = Blanco,
    onBackground = Color(0xFF201A1C),
    surface = Blanco,
    onSurface = Color(0xFF201A1C),
    surfaceVariant = Color(0xFFF4EDEF),
    onSurfaceVariant = Color(0xFF4F4347),
    outline = Color(0xFF857377),
    error = Color(0xFFB3261E),
    onError = Blanco,
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

// Tipografia legible: cuerpo de 16 sp como minimo en la captura.
private val AppTypography = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun EtaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, typography = AppTypography, content = content)
}
