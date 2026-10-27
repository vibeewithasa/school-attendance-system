package mx.edu.eta15.prefectura.security

import java.io.File
import mx.edu.eta15.prefectura.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pruebas de politica de seguridad de la etapa 1. Se ejecutan en debug Y en release (`testDebugUnitTest` y
 * `testReleaseUnitTest`): leen los archivos fuente del modulo (el directorio de trabajo es `app/`).
 */
class ProjectSecurityTest {
    private fun file(path: String) = File(path).also { assertTrue("No existe $path", it.exists()) }

    private fun sourceFiles(vararg roots: String): List<File> = roots
        .map { File(it) }
        .filter { it.exists() }
        .flatMap { it.walkTopDown().filter { f -> f.isFile && (f.extension == "kt" || f.extension == "xml") }.toList() }

    @Test
    fun `el modo demostracion solo existe en debug`() {
        assertEquals(BuildConfig.DEBUG, BuildConfig.DEMO_MODE)
    }

    @Test
    fun `el codigo de datos ficticios no esta en el source set de release`() {
        val release = sourceFiles("src/release").joinToString("\n") { it.readText() }
        assertTrue(release.contains("const val ENABLED = false"))
        assertFalse(release.contains("Ficticio"))
        assertFalse(release.contains("insertStudents"))
        assertFalse(File("src/main/java/mx/edu/eta15/prefectura/demo/DemoMode.kt").exists())
    }

    @Test
    fun `release no declara INTERNET ni permite trafico sin cifrar`() {
        val main = file("src/main/AndroidManifest.xml").readText()
        assertFalse("INTERNET no debe estar en el manifiesto principal", main.contains("android.permission.INTERNET"))
        assertTrue(main.contains("android:usesCleartextTraffic=\"false\""))
        assertFalse(main.contains("networkSecurityConfig"))
        assertFalse(main.contains("android:debuggable"))
    }

    @Test
    fun `solo debug declara INTERNET y HTTP solo hacia 10_0_2_2`() {
        val debug = file("src/debug/AndroidManifest.xml").readText()
        assertTrue(debug.contains("android.permission.INTERNET"))
        val nsc = file("src/debug/res/xml/network_security_config.xml").readText()
        assertTrue(nsc.contains("<base-config cleartextTrafficPermitted=\"false\""))
        assertEquals(1, Regex("<domain ").findAll(nsc).count())
        assertTrue(nsc.contains(">10.0.2.2</domain>"))
        assertFalse(File("src/main/res/xml/network_security_config.xml").exists())
    }

    @Test
    fun `los datos privados no participan en copias de seguridad ni transferencias`() {
        val manifest = file("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:allowBackup=\"false\""))
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(manifest.contains("android:fullBackupContent=\"@xml/backup_rules\""))
        for (path in listOf("src/main/res/xml/data_extraction_rules.xml", "src/main/res/xml/backup_rules.xml")) {
            val xml = file(path).readText()
            for (domain in listOf("root", "file", "database", "sharedpref", "external")) {
                assertTrue("$path debe excluir $domain", xml.contains("<exclude domain=\"$domain\" />"))
            }
            assertFalse("$path no debe incluir dominios", xml.contains("<include"))
        }
        val rules = file("src/main/res/xml/data_extraction_rules.xml").readText()
        assertTrue(rules.contains("<cloud-backup>") && rules.contains("<device-transfer>"))
    }

    @Test
    fun `no hay credenciales ni tokens en el codigo ni en los recursos`() {
        val forbidden = Regex("(password|contrase[nñ]a|secret|bearer|authorization|api[_-]?key|token)", RegexOption.IGNORE_CASE)
        val offenders = sourceFiles("src/main", "src/debug", "src/release")
            .filter { forbidden.containsMatchIn(it.readText()) }
            .map { it.path }
        assertTrue("Archivos con palabras de credenciales: $offenders", offenders.isEmpty())
    }

    @Test
    fun `Room nunca usa migracion destructiva`() {
        val offenders = sourceFiles("src/main", "src/debug")
            .filter { it.extension == "kt" && Regex("""\.fallbackToDestructiveMigration\w*\(""").containsMatchIn(it.readText()) }
            .map { it.path }
        assertTrue("fallbackToDestructiveMigration prohibido: $offenders", offenders.isEmpty())
    }

    @Test
    fun `no se declara firma release ni hay llaves en el proyecto`() {
        val gradle = file("build.gradle.kts").readText()
        assertFalse(gradle.contains("signingConfigs"))
        assertFalse(gradle.contains("storePassword"))
        val keys = File("..").walkTopDown()
            .onEnter { it.name != "build" && it.name != ".gradle" && it.name != "node_modules" }
            .filter { it.isFile && it.extension in setOf("jks", "keystore", "p12", "pem", "key") }
            .map { it.path }
            .toList()
        assertTrue("Llaves encontradas: $keys", keys.isEmpty())
    }

    @Test
    fun `la autenticacion real no existe todavia (sin autorizacion falsa)`() {
        val code = sourceFiles("src/main", "src/debug", "src/release").filter { it.extension == "kt" }
        val joined = code.joinToString("\n") { it.readText() }
        assertFalse(joined.contains("Cookie"))
        assertFalse(joined.contains("X-CSRF"))
        assertFalse(joined.contains("Origin"))
        assertFalse(joined.contains("SharedPreferences"))
    }
}
