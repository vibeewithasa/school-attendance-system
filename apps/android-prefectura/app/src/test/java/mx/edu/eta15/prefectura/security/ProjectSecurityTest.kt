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
            // `SecretKey` es el tipo estandar de javax.crypto (API de Keystore), no un secreto.
            .filter { forbidden.containsMatchIn(it.readText().replace("SecretKey", "")) }
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

    @Test
    fun `la app real solo abre Room cifrada con SQLCipher y no usa la base en claro`() {
        val builders = sourceFiles("src/main", "src/debug", "src/release")
            .filter { it.extension == "kt" && it.readText().contains("Room.databaseBuilder") }
            .map { it.name }
        assertEquals("Room.databaseBuilder solo en SecureStorage", listOf("SecureStorage.kt"), builders)
        val secure = file("src/main/java/mx/edu/eta15/prefectura/data/secure/SecureStorage.kt").readText()
        assertTrue(secure.contains("openHelperFactory(factory)"))
        assertTrue(secure.contains("SupportOpenHelperFactory"))
        // el contenedor de produccion abre mediante SecureStorage, no con una base en memoria ni sin cifrar
        val container = file("src/main/java/mx/edu/eta15/prefectura/AppContainer.kt").readText()
        assertTrue(container.contains("SecureStorage("))
        assertFalse(container.contains("inMemory"))
        assertFalse(file("src/main/java/mx/edu/eta15/prefectura/data/local/EtaDatabase.kt").readText().contains("databaseBuilder"))
    }

    @Test
    fun `la clave se guarda solo envuelta y en el directorio excluido de las copias`() {
        val vault = file("src/main/java/mx/edu/eta15/prefectura/data/secure/KeystoreKeyVault.kt").readText()
        assertTrue(vault.contains("noBackupFilesDir"))
        assertFalse("no usa filesDir normal", Regex("""(?<![A-Za-z])filesDir""").containsMatchIn(vault))
        assertFalse(vault.contains("getSharedPreferences"))
        assertTrue(vault.contains("AES/GCM/NoPadding"))
        assertTrue(vault.contains("AndroidKeyStore"))
        assertTrue(vault.contains("SecureRandom"))
        assertTrue(vault.contains("setRandomizedEncryptionRequired(true)"))
    }

    @Test
    fun `no hay claves ni constantes hexadecimales largas en el codigo`() {
        val hexRun = Regex("""[0-9a-fA-F]{32,}""")
        val offenders = sourceFiles("src/main", "src/debug", "src/release")
            .filter { it.extension == "kt" && hexRun.containsMatchIn(it.readText()) }
            .map { it.path }
        assertTrue("Posibles claves literales: $offenders", offenders.isEmpty())
    }

    @Test
    fun `el codigo de almacenamiento no escribe en logs`() {
        val offenders = sourceFiles("src/main", "src/debug", "src/release")
            .filter { it.extension == "kt" }
            .filter { Regex("""\bLog\.\w+\(|println\(|Timber\.""").containsMatchIn(it.readText()) }
            .map { it.path }
        assertTrue("Sin registros en el codigo de la app: $offenders", offenders.isEmpty())
    }

    @Test
    fun `la base cifrada tiene un nombre distinto al de la base anterior sin cifrar`() {
        val secure = file("src/main/java/mx/edu/eta15/prefectura/data/secure/SecureStorage.kt").readText()
        assertTrue(secure.contains("SECURE_NAME = \"eta15_secure.db\""))
        assertTrue(secure.contains("LEGACY_NAME = \"eta15_local.db\""))
    }
}