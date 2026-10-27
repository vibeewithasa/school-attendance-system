package mx.edu.eta15.prefectura

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import mx.edu.eta15.prefectura.ui.EtaApp
import mx.edu.eta15.prefectura.ui.theme.EtaTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Release: sin capturas de pantalla ni vista previa en recientes (hay nombres de menores). En debug se permiten
        // para poder documentar y probar la interfaz con datos ficticios.
        if (!BuildConfig.DEBUG) window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val container = (application as EtaApplication).container
        setContent { EtaTheme { EtaApp(container) } }
    }
}
