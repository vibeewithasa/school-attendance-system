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

    /** Prototipo de vinculacion movil (ADR 0005, propuesta): UNICO lugar donde pueden aparecer las palabras "token" y "authorization". */
    private val mobileDir = "src/debug/java/mx/edu/eta15/prefectura/mobile"

    @Test
    fun `no hay credenciales ni tokens en el codigo ni en los recursos`() {
        val forbidden = Regex("(password|contrase[nñ]a|secret|bearer|authorization|api[_-]?key|token)", RegexOption.IGNORE_CASE)
        val offenders = sourceFiles("src/main", "src/debug", "src/release")
            // El prototipo de vinculacion movil (solo debug) maneja cabeceras y credenciales de SESION en memoria; ver la prueba
            // siguiente: ahi siguen prohibidas las contrasenas, los secretos y los esquemas "bearer".
            .filterNot { it.invariantSeparatorsPath.contains(mobileDir) }
            // `SecretKey` es el tipo estandar de javax.crypto (API de Keystore), no un secreto.
            .filter { forbidden.containsMatchIn(it.readText().replace("SecretKey", "")) }
            .map { it.path }
        assertTrue("Archivos con palabras de credenciales: $offenders", offenders.isEmpty())
    }

    @Test
    fun `el prototipo movil no maneja contrasenas ni secretos y no guarda credenciales en disco`() {
        val forbidden = Regex("(password|contrase[nñ]a|secret|bearer|api[_-]?key)", RegexOption.IGNORE_CASE)
        val files = sourceFiles(mobileDir, "src/debug/res/values").filter { it.name.startsWith("mobile") || it.invariantSeparatorsPath.contains(mobileDir) }
        assertTrue(files.isNotEmpty())
        assertTrue(files.filter { forbidden.containsMatchIn(it.readText().replace("SecretKey", "")) }.map { it.path }.isEmpty())
        // lo unico que se escribe en disco es el registro de vinculacion (identificadores y etiqueta), sin credenciales ni claves
        val store = file("$mobileDir/LinkStore.kt").readText()
        assertTrue(store.contains("noBackupFilesDir"))
        assertFalse(Regex("(token|access|refresh|private|pairingCode|code)", RegexOption.IGNORE_CASE).containsMatchIn(store.substringAfter("data class LinkRecord").substringBefore("interface LinkStore")))
        val writers = sourceFiles(mobileDir).filter { Regex("""writeText|writeBytes|FileOutputStream|openFileOutput""").containsMatchIn(it.readText()) }.map { it.name }
        assertEquals(listOf("LinkStore.kt"), writers)
    }

    @Test
    fun `el codigo de red y de claves de dispositivo solo existe en debug`() {
        val shipped = sourceFiles("src/main", "src/release").filter { it.extension == "kt" }
        val network = Regex("""java\.net\.|HttpURLConnection|okhttp|retrofit|ktor|WebView|DownloadManager""")
        val deviceKeys = Regex("""KeyPairGenerator|ECGenParameterSpec|secp256r1|SHA256withECDSA|DPoP|Dpop""")
        assertTrue("Red en main/release: ${shipped.filter { network.containsMatchIn(it.readText()) }.map { it.path }}", shipped.none { network.containsMatchIn(it.readText()) })
        assertTrue("Claves de dispositivo en main/release: ${shipped.filter { deviceKeys.containsMatchIn(it.readText()) }.map { it.path }}", shipped.none { deviceKeys.containsMatchIn(it.readText()) })
        // el unico simbolo compartido es el interruptor de la funcion: en release vale false y no contiene nada
        val release = file("src/release/java/mx/edu/eta15/prefectura/mobile/MobileFeature.kt").readText()
        assertTrue(release.contains("const val AVAILABLE = false"))
        assertTrue(shipped.none { it.invariantSeparatorsPath.contains("/mobile/") && !it.name.startsWith("MobileFeature") })
    }

    @Test
    fun `la clave del dispositivo no sale del Keystore ni se regenera en silencio`() {
        val key = file("$mobileDir/DeviceKey.kt").readText()
        assertTrue(key.contains("AndroidKeyStore"))
        assertTrue(key.contains("PURPOSE_SIGN"))
        assertFalse("sin PURPOSE_DECRYPT/ENCRYPT: solo firma", key.contains("PURPOSE_DECRYPT") || key.contains("PURPOSE_ENCRYPT"))
        assertFalse("la clave privada no se exporta", Regex("""getEncoded|\.encoded\b|PKCS8EncodedKeySpec|KeyStore\.PrivateKeyEntry""").containsMatchIn(key))
        // crear una clave exige que no exista otra (sin regeneracion silenciosa)
        assertTrue(key.contains("Ya existe una clave de dispositivo: no se reemplaza"))
        val all = sourceFiles(mobileDir).joinToString("\n") { it.readText() }
        assertFalse("sin Log ni registros", Regex("""\bLog\.\w+\(|println\(""").containsMatchIn(all))
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

    @Test
    fun `la cache offline no usa red, no sincroniza solo y no envia asistencia`() {
        // El codigo comun (debug Y release) no tiene cliente de red ni programadores de envio en segundo plano.
        val common = sourceFiles("src/main").filter { it.extension == "kt" }.joinToString("\n") { it.readText() }
        assertFalse(
            "sin cliente HTTP en el codigo comun",
            Regex("""HttpURLConnection|java.net.URL|OkHttp|Retrofit|openConnection""").containsMatchIn(common),
        )
        assertFalse(
            "sin sincronizacion automatica",
            Regex("""WorkManager|JobScheduler|AlarmManager|SyncAdapter|PeriodicWorkRequest""").containsMatchIn(common),
        )
        // El cliente de PRUEBAS (solo debug) solo conoce las dos lecturas autorizadas: ninguna ruta ni metodo de asistencia.
        val debug = sourceFiles("src/debug").filter { it.extension == "kt" }.joinToString("\n") { it.readText() }
        assertFalse("el cliente de pruebas no conoce ninguna ruta de asistencia", Regex("""/attendance|school/attendance""").containsMatchIn(debug))
        val api = file("src/debug/java/mx/edu/eta15/prefectura/mobile/MobileApi.kt").readText()
        assertFalse("la interfaz del servidor de pruebas no tiene operaciones de asistencia", api.contains("ttendance"))
        assertTrue(api.contains("suspend fun myGroups") && api.contains("suspend fun roster"))
    }

    @Test
    fun `REPLACE nunca se usa en la cache porque borraria en cascada borradores y marcas`() {
        val daos = file("src/main/java/mx/edu/eta15/prefectura/data/local/Daos.kt").readText()
        assertFalse(daos.contains("OnConflictStrategy.REPLACE"))
        assertTrue("la cache usa @Upsert", daos.contains("@Upsert"))
        // el unico borrado de datos descargados es explicito y solo de perfiles SANDBOX
        assertTrue(daos.contains("DELETE FROM profiles WHERE id = :profileId AND source = 'SANDBOX'"))
    }

    @Test
    fun `la interfaz de la cache nunca dice enviada ni sincronizada`() {
        val strings = file("src/main/res/values/strings.xml").readText()
        val offline = Regex("""<string name="(offline_|mobile_download|mobile_open_offline|mobile_purge)[^"]*">([^<]*)</string>""")
            .findAll(strings).joinToString("\n") { it.groupValues[2] }
        assertTrue(offline.isNotBlank())
        // se permite negar ("no se envia"); nunca afirmar un envio, una sincronizacion o un registro oficial
        assertFalse(Regex("""(?i)sincronizad[ao]|enviad[ao]|registrad[ao] por la escuela|finalizad[ao] oficialmente""").containsMatchIn(offline))
        assertTrue(strings.contains("GUARDADA EN ESTE DISPOSITIVO"))
    }

    @Test
    fun `la outbox no usa red ni programadores y su transporte futuro solo lo llaman las pruebas`() {
        val base = "src/main/java/mx/edu/eta15/prefectura"
        val outboxFiles = listOf("$base/data/OutboxStore.kt", "$base/data/local/OutboxEntities.kt", "$base/data/local/OutboxSql.kt", "$base/domain/Outbox.kt")
        val text = outboxFiles.joinToString("\n") { file(it).readText() }
        assertFalse(
            "la outbox no conoce ninguna red ni programador",
            Regex("""java\.net|okhttp|retrofit|HttpURLConnection|WorkManager|JobScheduler|AlarmManager|ConnectivityManager|/attendance|school/attendance""", RegexOption.IGNORE_CASE).containsMatchIn(text),
        )
        // Los metodos que representan el transporte (SENDING, recibo, contexto remoto, descarte) existen solo para simularlo en pruebas:
        // ningun codigo de produccion (fuera de OutboxStore) los invoca.
        val others = sourceFiles("src/main", "src/debug").filter { it.name != "OutboxStore.kt" }.joinToString("\n") { it.readText() }
        for (method in listOf("resolveContext", "beginSending", "acknowledge(", "outbox.fail(", "discard(")) {
            assertFalse("el codigo de produccion no debe llamar a $method", others.contains(method))
        }
        // La outbox solo se crea para perfiles descargados del servidor de pruebas (nunca para la demostracion local).
        val repo = file("$base/data/LocalAttendanceRepository.kt").readText()
        assertTrue(repo.contains("if (access != null) OutboxStore(db, clock, ids) else null"))
    }

    @Test
    fun `la outbox nunca guarda credenciales ni pruebas de posesion y su esquema no tiene columnas de secretos`() {
        val entities = file("src/main/java/mx/edu/eta15/prefectura/data/local/OutboxEntities.kt").readText()
        assertFalse(
            Regex("""(?i)token|password|secret|jwk|dpop|privateKey|cookie|csrf""").containsMatchIn(entities),
        )
        // la sincronizacion futura exige un estado explicito: sin REPLACE (borraria en cascada) ni migracion destructiva
        assertFalse(entities.contains("OnConflictStrategy.REPLACE"))
    }

    @Test
    fun `los textos de la outbox nunca afirman un envio ni un registro oficial`() {
        val strings = file("src/main/res/values/strings.xml").readText()
        val outbox = Regex("""<string name="(outbox_|capture_msg_cannot_unmark)[^"]*">([^<]*)</string>""")
            .findAll(strings).joinToString("\n") { it.groupValues[2] }
        assertTrue(outbox.isNotBlank())
        // se permite negar ("no se envia", "aun no se envia"); nunca afirmar un envio, una sincronizacion o un registro oficial
        assertFalse(Regex("""(?i)sincronizad[ao]|(?<!no se )enviad[ao]|registrad[ao] oficialmente|registrad[ao] por la escuela|finalizad[ao] oficialmente""").containsMatchIn(outbox))
        assertFalse("sin boton de envio al servidor", Regex("""(?i)enviar al servidor""").containsMatchIn(outbox))
        assertTrue(outbox.contains("Preparar para sincronizar"))
    }
}
