package mx.edu.eta15.prefectura.mobile

import androidx.compose.runtime.Composable

/** Release: la vinculacion experimental no existe (ni claves de dispositivo, ni cliente de red, ni permiso de red). */
object MobileFeature {
    const val AVAILABLE = false

    @Composable
    fun HomeEntry(onOpen: () -> Unit) = Unit

    @Composable
    fun Screen(onBack: () -> Unit) = Unit
}
