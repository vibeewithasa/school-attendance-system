# App Android de prefectura (etapa 1 captura local + etapa 2A almacenamiento cifrado)

Estado (2026-10-27): **app nativa funcional, solo con datos SINTÉTICOS**, compilada, instalada y probada en el emulador. La etapa 2A agregó **cifrado en reposo real** (Room + SQLCipher, clave protegida por Android Keystore). Sigue sin ser un cliente de la escuela: **cifrar la base no la hace apta para datos de menores** (faltan inicio de sesión, autorización, revocación, sincronización y decisiones institucionales).

## Qué es y qué NO es

| Es                                                                                                 | No es                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App Kotlin + Jetpack Compose + Room que muestra grupos **ficticios** y captura Presente/Ausente    | Un cliente de la API: no hay inicio de sesión, ni descarga de grupos reales, ni envío de asistencia              |
| Captura local persistente (sobrevive al cierre de la app y funciona sin internet)                  | Un registro oficial de asistencia: lo capturado es un **borrador local** y nunca se finaliza                     |
| Modo demostración **solo en debug**, rotulado en todas las pantallas                               | Distribuible: no hay firma release ni se entrega ningún APK a la escuela                                         |
| Preparación de la arquitectura (fuente local, puerto remoto vacío, `requestId` local por borrador) | Un protocolo de sincronización (no se inventó; ver [ADR 0005](../decisions/0005-android-autenticacion-movil.md)) |

- Los datos son sintéticos (`Alumno 01 Ficticio 1A`…), generados localmente. No se usaron datos de menores ni se conectó con `eta15_dev`. No se alteró PostgreSQL.
- Room guarda **solo en este dispositivo**, ahora **cifrada**. No hay sincronización ni login escolar. No existe registro oficial de asistencia desde Android.

## Versiones y compatibilidad

Criterio: últimas versiones **estables compatibles** con el Gradle 8.13 y el SDK 36.1 instalados (no las más nuevas por serlo). Fuente: tabla oficial de AGP (AGP 8.13 requiere Gradle 8.13 y admite API 36.1; AGP 9.x exige Gradle 9.1+), metadatos de Maven y el conjunto ya resuelto por Android Studio en esta máquina. Se **comprobó compilando y probando**, no solo por tabla. `gradle/libs.versions.toml` es la fuente.

| Componente                        | Versión                     | Nota                                                                |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| Gradle (wrapper)                  | 8.13 (SHA-256 verificado)   | Se generó con la distribución en caché; no se instaló Gradle global |
| Android Gradle Plugin             | 8.13.2                      | 9.x queda para una etapa con Gradle 9                               |
| Kotlin / Compose plugin           | 2.3.10                      | Compose Compiler = plugin `org.jetbrains.kotlin.plugin.compose`     |
| KSP                               | 2.3.12                      | Versionado independiente de Kotlin; requiere AGP ≥ 8.12             |
| Compose BOM                       | 2026.02.01 (Material 3 1.4) | Más nuevos (2026.09) pueden exigir compileSdk 37, no instalado      |
| Room                              | 2.8.5                       | KSP; esquemas exportados                                            |
| Lifecycle / Navigation / Activity | 2.10.0 / 2.9.7 / 1.12.4     | Estables                                                            |
| Coroutines                        | 1.10.2                      | `kotlinx-serialization-core` 1.9.0 fijado (lo exige `room-testing`) |
| JDK                               | 21 (JBR de Android Studio)  | `jvmToolchain(21)`, bytecode Java 17                                |

Decisiones técnicas (provisionales, cambiables antes de distribuir):

- `compileSdk` 36, `targetSdk` 36, **`minSdk` 26** (Android 8.0): cubre equipos modestos y trae `java.time` sin desugaring. **No se afirma qué dispositivos tiene la escuela.**
- `namespace` y `applicationId`: `mx.edu.eta15.prefectura` (debug añade `.debug`). Identificador provisional.
- `cmdline-tools` **no hizo falta** y no se instaló nada.

## Estructura

```
apps/android-prefectura/
  settings.gradle.kts · build.gradle.kts · gradle.properties · gradlew(.bat) · gradle/{libs.versions.toml, wrapper/}
  app/
    build.gradle.kts · proguard-rules.pro · schemas/ (esquema Room exportado, versionado)
    src/main      código y recursos comunes (domain, data, data/secure = cifrado y claves, ui, AppContainer)
    src/debug     DemoMode (datos ficticios), DevHealthCheck, INTERNET y red HTTP solo hacia 10.0.2.2
    src/release   DemoMode y DevHealthCheck VACÍOS (no existen datos ficticios ni red)
    src/test      pruebas JVM (dominio, ViewModels, política de seguridad, formato de la clave)
    src/androidTest  pruebas en emulador (Room, Keystore y SQLCipher reales, conversión, esquema, interfaz)
```

Ubicación: se conservó `apps/android-prefectura` (ya prevista en `CLAUDE.md`). No es un paquete pnpm; se compila con `gradlew.bat`.

## Arquitectura

```
UI (Compose, ViewModels + StateFlow)  →  Dominio (modelos, reglas, puertos)  →  Datos
                                                                                ├─ LocalDataSource: Room (fuente de verdad de la UI, Flow)
                                                                                ├─ DemoDataSource: DemoMode (solo debug)
                                                                                └─ FutureRemoteDataSource: RemoteDataSource (hoy: "no implementada")
```

- Sin frameworks de inyección: `AppContainer` manual. La UI **solo observa Room** (vía `AttendanceRepository`); nada depende de internet.
- `LocalAttendanceRepository` filtra todo por `profileId` (aislamiento por perfil) y escribe en transacciones de Room. `AppContainer` abre el almacenamiento de forma asíncrona y **fail closed**: la UI muestra "Abriendo…", los datos o la pantalla de fallo (nunca una base vacía de respaldo).
- La fecha escolar replica la regla del servidor (`America/Mazatlan`, lunes a viernes) **solo como fecha de demostración**: el reloj del dispositivo no es autoridad escolar. Sábado/domingo no abren listas nuevas; un borrador de otro día ya no se modifica; cambiar el reloj hacia atrás no reabre borradores ajenos al día.

## Room (esquema v1, `exportSchema=true`, sin migración destructiva)

| Tabla               | Contenido                                                                              | Integridad                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `profiles`          | Perfil local (en debug, el perfil ficticio)                                            | PK                                                                                    |
| `school_groups`     | Grupos del perfil                                                                      | FK → perfil (cascada); único (id, perfil)                                             |
| `students`          | Datos mínimos: nombre y apellido sintéticos (sin CURP, tutores, foto ni datos médicos) | FK → grupo; único (id, grupo)                                                         |
| `attendance_drafts` | **Un borrador** por perfil + grupo + fecha; `requestId` estable (futuro idempotente)   | FK compuesta (grupo, perfil); únicos (perfil, grupo, fecha), `requestId`, (id, grupo) |
| `attendance_marks`  | Una marca por alumno en cada borrador; `NULL` = pendiente                              | PK (borrador, alumno); FK compuestas al borrador y al alumno **del mismo grupo**      |

Reglas en la base (disparadores en `onOpen`, `IF NOT EXISTS`): la marca solo puede ser `NULL`, `PRESENT` o `ABSENT`; no se crean borradores en sábado/domingo ni con fecha inválida; la identidad del borrador es inmutable. El padrón del borrador se **congela** al abrirlo. No hay tablas de sincronización ni de operaciones pendientes: se evita fijar una semántica sin decidir.

## Pantallas

1. **Inicio**: marca provisional "ETA 15" (espacio reservado, **no** es el logotipo oficial), perfil ficticio, fecha de demostración y avisos.
2. **Mis grupos**: tarjetas con alumnos y avance de hoy.
3. **Padrón del grupo** y botón "Pasar lista de hoy" (deshabilitado en fin de semana).
4. **Captura local**: Presente/Ausente por alumno (con icono y texto, no solo color), "Quitar marca" (Pendiente), contadores como región viva, distintivo permanente **GUARDADA EN ESTE DISPOSITIVO**.
5. **Resumen del borrador**: conteos, pendientes y aviso de que **no** equivale a finalizar la lista de la escuela.
6. **Conectividad y sincronización**: "Sincronización no implementada" (siempre), red solo informativa, comprobación opcional de `/health` y restablecimiento de la demostración (debug).

Nunca se muestra "Sincronizada", "Enviada correctamente" ni "Registrada en la escuela" (hay una prueba que lo verifica). No hay botón de finalizar.

Tema tinto y blanco (Material 3), tipografía de 16 sp o más, controles táctiles ≥ 48 dp, textos en español (es-MX).

## Modo demostración

- Solo en **debug** (`BuildConfig.DEMO_MODE`); en release es `false` y el código de datos ficticios **no se compila** (`src/release` es un no-op). Se verificó con el APK: la cadena `Ficticio`, `demo-prefecta` y `10.0.2.2` están en el dex de debug y **no** en el de release.
- Datos: una prefecta ficticia, 5 grupos (9–30 alumnos) con identificadores UUID generados localmente. Sin contraseñas, tokens ni sesión fingida; no se conecta a `eta15_dev`.
- Banner permanente **MODO DEMOSTRACIÓN**. "Restablecer demostración" borra todo y vuelve a cargar con identificadores nuevos.
- Release sin perfil: la app dice que no hay inicio de sesión escolar y no ofrece grupos.

## Almacenamiento cifrado (etapa 2A)

### Solución elegida y compatibilidad

**SQLCipher for Android, edición Community** (`net.zetetic:sqlcipher-android` **4.20.0**, publicada en Maven Central) integrada con Room mediante `SupportOpenHelperFactory`. Reemplaza al paquete antiguo `net.zetetic:android-database-sqlcipher`, abandonado en la 4.5.4 (2023). Se eligió por ser la solución reconocida y mantenida para Room/SQLite, con cifrado AES-256 de **toda la página** (base, WAL y journal), sin criptografía propia.

| Aspecto        | Resultado                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatibilidad | Room 2.8.5 + `androidx.sqlite` 2.7.0 (el que declara su POM); `minSdk` del AAR 23 (el proyecto usa 26); compilado y probado con AGP 8.13.2/Kotlin 2.3.10                                                                         |
| ABIs           | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` (~7,5 MB de bibliotecas nativas). Medido: APK debug de 12,1 a 19,6 MB y release (R8) de 1,2 a 8,6 MB; al distribuir se podrán filtrar ABIs                                           |
| R8/release     | El AAR trae reglas de consumidor (`-keep net.zetetic.database.**`); se **probó en ejecución** un release con R8 (ver pruebas en emulador)                                                                                        |
| Licencia       | BSD de 3 cláusulas (© ZETETIC LLC). **Exige reproducir el aviso y la licencia en un lugar accesible del producto**: la app muestra el aviso y el texto completo (`res/raw/license_sqlcipher.txt`) en la pantalla de Conectividad |
| Mantenimiento  | Versión 4.20.0 publicada el mismo día de esta revisión; la edición comercial no se usa                                                                                                                                           |
| Pendiente      | Revisar los avisos de terceros que incluya el binario nativo (p. ej. biblioteca criptográfica) antes de cualquier distribución; verificación de dependencias de Gradle (`verification-metadata.xml`)                             |

### Gestión de claves (Android Keystore)

- La **clave de la base** son 256 bits de `SecureRandom`; no está en el código, no se deriva de ningún identificador, no va a `SharedPreferences` ni a logs. A SQLCipher se le entrega en su formato binario `x'<64 hex>'` (sin derivación, ya es aleatoria) y los arreglos se ponen a cero tras usarlos.
- Se **envuelve** con una clave **AES-256-GCM no exportable** de Android Keystore (en StrongBox si el equipo la tiene y es Android 9+; en Android 8.x se usa el Keystore normal). El blob guardado (`versión + IV + texto cifrado + etiqueta GCM`, con AAD = alias y versión) vive en `noBackupFilesDir`, fuera de copias de seguridad y de transferencia entre dispositivos.
- Un solo almacenamiento y una sola clave **por instalación** (un dispositivo = un titular, según el [ADR 0005](../decisions/0005-android-autenticacion-movil.md)); el aislamiento entre perfiles lo imponen la base y el repositorio, no claves distintas.
- La clave de Keystore **no exige todavía autenticación del usuario** (la demostración no tiene sesión). Cuando exista el login seguro se le podrá exigir PIN/huella (ADR 0005); hoy ese control **no existe**.

| Momento                                      | Qué ocurre                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primer arranque                              | Se crean la clave de Keystore y el blob, y luego la base cifrada (si había una base anterior sin cifrar, se convierte)                                                        |
| Apertura de Room                             | `SecureStorage.open()` descifra la clave, abre la base con ella y fuerza la apertura: una clave equivocada o un archivo dañado fallan **ahí**                                 |
| Cierre de la base                            | La clave solo vive en memoria durante la apertura; se pone a cero. Room cierra y hace checkpoint del WAL                                                                      |
| Reinicio del proceso                         | Se repite la apertura con la clave guardada; no se regenera nada (hay prueba)                                                                                                 |
| Falla de Keystore o clave perdida/invalidada | **Fail closed**: error `KeyMissing`/`KeyInvalidated`/`KeystoreUnavailable`; no se crea clave ni base nueva y **no se borra nada**                                             |
| Blob alterado                                | `KeyCorrupt` (falla la autenticación GCM); la base queda intacta                                                                                                              |
| Pérdida del dispositivo                      | La base cifrada sin la clave del Keystore (que no sale del equipo) no se puede leer; la revocación remota y el borrado diferido dependen del servidor y quedan en el ADR 0005 |
| Migración futura de esquema                  | Migraciones de Room escritas y probadas (nunca destructivas); un cambio de cifrado se haría con una conversión verificada como la de abajo                                    |
| Borrado local autorizado                     | `SecureStorage.wipeAll()` elimina base, claves y restos. Solo se ofrece en debug con confirmación; en release no existe hasta definir un borrado autorizado por el servidor   |

### Apertura segura (tabla de decisión)

| Base cifrada | Clave envuelta | Clave Keystore | Resultado                                                                           |
| ------------ | -------------- | -------------- | ----------------------------------------------------------------------------------- |
| sí           | sí             | sí             | Se abre; si no abre (clave equivocada o archivo dañado) → `DatabaseUnreadable`      |
| sí           | falta alguna   | -              | `KeyMissing`: **no** se crea clave ni base nueva y **no** se borra nada             |
| no           | cualquiera     | cualquiera     | Se crea (o se rehace) la clave —aún no hay nada cifrado con ella— y se crea la base |

### Conversión de la base anterior (instalaciones debug de la etapa 1)

La base `eta15_local.db` (sin cifrar, solo datos ficticios) se **convierte** a `eta15_secure.db` sin pérdida: se verifica `integrity_check`, versión de esquema 1 y cabecera SQLite; se copian las filas en una transacción a un archivo temporal **cifrado**; se reabre ese archivo con la clave y se comprueban `foreign_key_check`, `integrity_check`, **conteos por tabla y una huella SHA-256 del contenido** idénticos a los de origen; solo entonces se renombra de forma atómica y se retira la copia sin cifrar.

| Situación                                                | Resultado                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Base nueva                                               | Se crea cifrada y vacía (en debug se carga la demostración)                                |
| Base anterior con registros                              | Se convierten los borradores; la copia sin cifrar se elimina tras verificar                |
| Interrupción **antes** del renombrado                    | La base anterior sigue intacta; el temporal se descarta y la conversión se repite al abrir |
| Interrupción **después** del renombrado                  | Se conserva la cifrada y solo se retira la copia sin cifrar sobrante                       |
| Base anterior desconocida (versión distinta o no SQLite) | `UnknownLegacyFormat`: no se toca y **no** se crea una base vacía                          |
| Fallo al copiar o verificar                              | `ConversionFailed`: la base anterior queda intacta y no se crea base cifrada               |

Esta conversión es solo para datos de demostración sintéticos; **nunca** se usaría sobre información escolar real. La copia sin cifrar se **sobrescribe con ceros y se elimina** (incluidos `-wal`, `-shm` y `-journal`), pero eso es de **mejor esfuerzo**: en almacenamiento flash (wear-leveling, journaling del sistema de archivos, copias internas del controlador) borrar o sobrescribir un archivo **no garantiza** que sus bloques anteriores sean irrecuperables. Por eso la conversión solo se admite con datos ficticios y la protección real es el cifrado de la base nueva; con datos reales no habría copia en claro que borrar. No hay borrado automático ante errores criptográficos; el reinicio explícito (debug) pide confirmación.

### Aislamiento de perfil

Todo dato lleva `profileId` con llaves foráneas compuestas (grupo→perfil, borrador→grupo del mismo perfil, marca→borrador y alumno del mismo grupo); el repositorio está atado a un perfil y no ve ni modifica datos de otro (probado también sobre la base cifrada). `CatalogDao.deleteProfile(id)` borra un solo perfil en cascada sin tocar los demás. **No hay gestión de cuentas** ni cambio de perfil en la interfaz; un cambio de titular implicará borrar el perfil anterior (ADR 0005). No se requirieron migraciones de Room (el esquema sigue en la versión 1).

### Errores y pantalla de fallo

La pantalla "No se pudo abrir el almacenamiento protegido" explica la causa en español, declara que no se borró nada ni se creó una base vacía y ofrece **Reintentar** (sin efectos destructivos). En debug añade "Borrar demostración y empezar de nuevo" con confirmación.

## Seguridad móvil (resumen)

Hay: **base cifrada en reposo (SQLCipher) con clave en Keystore**; `allowBackup=false` + reglas de `fullBackupContent` y `dataExtractionRules` que excluyen **todos** los dominios en copia en la nube y transferencia entre dispositivos; clave y blob en `noBackupFilesDir`; `usesCleartextTraffic=false` (HTTPS obligatorio en release); release **sin permiso INTERNET**; HTTP solo en debug y solo hacia `10.0.2.2`; `FLAG_SECURE` en release; sin credenciales, tokens ni claves literales en código o recursos (pruebas automáticas, incluida la ausencia de cadenas hexadecimales largas y de llamadas de registro); sin `fallbackToDestructiveMigration`; sin firma ni llaves en el repositorio; logs del proceso sin secretos ni nombres.

**Etapa 2B (prototipo aislado, solo debug)**: vinculación experimental del dispositivo con el servidor de PRUEBAS (ver la sección siguiente). El APK de release no cambia: sin `INTERNET`, sin cliente de red y sin código de claves de dispositivo (pruebas automáticas y verificación del manifiesto y del dex).

**Falta (a diseñar antes de datos reales)**: aprobación institucional de la autenticación del dispositivo y de la persona, exigir PIN/huella a la clave, atestación, borrado remoto, caducidad del paquete offline, procedimiento de pérdida/robo, actualización forzada, verificación de dependencias y aviso de terceros del binario nativo. Diseño propuesto y comparación de opciones: [ADR 0005](../decisions/0005-android-autenticacion-movil.md).

## Vinculación experimental de dispositivo (etapa 2B, solo debug)

Pantalla «Vincular dispositivo (entorno de pruebas)» en Inicio, con el aviso **ENTORNO DE PRUEBAS** y separada de la demostración local. Código en `src/debug/java/.../mobile/` (en `src/release` solo hay un objeto `MobileFeature` vacío con `AVAILABLE = false`):

- `Dpop.kt` (Kotlin puro, probado en la JVM con vectores calculados por el servidor): JWK, huella RFC 7638, huella corta, conversión DER → P1363 y pruebas DPoP ES256.
- `DeviceKey.kt`: par EC P-256 en Android Keystore (solo firma, no exportable). Solo se crea al pulsar «Vincular»; si ya existe se reutiliza y **nunca se regenera en silencio**. Informa el nivel de protección real (StrongBox, entorno seguro o software; en el emulador: software).
- `HttpMobileApi.kt`: `HttpURLConnection` hacia `http://10.0.2.2:3000` (único destino HTTP permitido en debug), sin cookies, credencial en `Authorization: DPoP` + prueba, sin redirecciones, respuestas con límite de tamaño.
- `MobileLinkController.kt`: estados No vinculado → Emparejamiento (clave de solicitud, código y huella en pantalla; sondeo) → Vinculado (titular, huella, protección, sesión en memoria, lectura en línea de grupos y padrón) y Clave perdida; «Olvidar» borra clave y registro (no revoca en el servidor: lo hace Dirección en el portal).
- `LinkStore.kt`: solo identificadores y etiqueta en `noBackupFilesDir`; la sesión nunca se guarda y los datos escolares leídos no se almacenan en Room.

Pruebas: 64 JVM de debug (10 DPoP, 13 máquina de estados, 17 de política) y 41 de release; 75 instrumentadas (7 del Keystore real: creación explícita, no reemplazo, formato del JWK, firma verificada, borrado, clave no exportable; 5 de interfaz con servidor falso) y una prueba de extremo a extremo (`SandboxE2eTest`, solo con `-e e2e sandbox`) contra `pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --mobile-auth`. No hay envío de asistencia, sincronización ni cola.

## Compilar, ejecutar y probar (PowerShell)

```powershell
. .\tools\env.ps1                         # fija JAVA_HOME (JDK 21), ANDROID_HOME y Node
cd apps\android-prefectura
.\gradlew.bat :app:assembleDebug          # APK debug
.\gradlew.bat :app:assembleRelease        # release sin firmar (R8); no instalable hasta definir firma
.\gradlew.bat :app:testDebugUnitTest :app:testReleaseUnitTest   # pruebas JVM
.\gradlew.bat :app:lintDebug :app:lintRelease
# Emulador (AVD "Medium_Phone_API_36.1"); en otra terminal:
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd Medium_Phone_API_36.1
adb devices
.\gradlew.bat :app:connectedDebugAndroidTest    # Room, esquema e interfaz en el emulador
.\gradlew.bat :app:installDebug                 # instala la app en el emulador
adb shell am start -n mx.edu.eta15.prefectura.debug/mx.edu.eta15.prefectura.MainActivity
```

Notas: los directorios `build/`, `.gradle/` y `local.properties` no se versionan. Si `ANDROID_HOME` no está definido, crea `local.properties` con `sdk.dir=...` (ignorado por Git). Para la comprobación opcional de `/health`, arranca el API de desarrollo (`pnpm --filter @eta15/api start`, escucha en `127.0.0.1`; el emulador lo ve como `10.0.2.2`).

## Resultados de pruebas (2026-10-27, etapa 2A)

| Prueba                                                                                               | Resultado            |
| ---------------------------------------------------------------------------------------------------- | -------------------- |
| `testDebugUnitTest` y `testReleaseUnitTest` (dominio, ViewModels, política de seguridad, clave)      | 38 + 38, 0 fallos    |
| `connectedDebugAndroidTest` en `Medium_Phone_API_36.1` (Room, Keystore y SQLCipher reales, interfaz) | 61, 0 fallos         |
| `lintDebug` / `lintRelease` / `assembleDebug` / `assembleRelease` (R8)                               | 0 errores / compilan |

Las 61 instrumentadas incluyen: 10 de la bóveda de claves (clave aleatoria de 256 bits, no se guarda en claro, no exportable, no regenera, alteración y versión inválidas, clave perdida, blob de otro alias), 18 de almacenamiento (base realmente cifrada incluso con WAL y tras cerrar, SQLite normal no la lee, clave incorrecta rechazada, reinicio, fail closed por clave o blob ausente o alterado, primer arranque interrumpido, conversión con registros, interrupciones, formato desconocido, fallo al copiar, aislamiento de perfiles y borrado por perfil, borrado explícito) y 2 de interfaz con almacenamiento cifrado real (estado del cifrado y licencia; pantalla de fallo cerrado y reinicio explícito). Un control positivo comprueba que la búsqueda de texto claro sí encuentra datos en una base sin cifrar.

### Prueba real en el emulador (etapa 2A)

1. **Actualización real**: se instaló el APK de la etapa 1 (compilado de `main` en un worktree temporal) con la base `eta15_local.db` **sin cifrar** (cabecera `SQLite format 3`) y 3 marcas; al instalar encima la versión nueva, apareció `eta15_secure.db` (sin cabecera SQLite ni texto legible, sin `Ficticio` ni `Alumno`), la copia sin cifrar desapareció, `no_backup/eta15_db_key_v1.blob` (62 bytes) quedó creado y la lista mostró **3 de 12 marcados**.
2. Modo avión + captura de otra marca, cierre forzado del proceso y reapertura: **4 de 12**; al reconectar sigue "Sincronización no implementada".
3. Pantalla de Conectividad: "Cifrado en reposo de la base local: activo (SQLCipher 4.20.0 community)", aviso y texto de la licencia.
4. Rotación (el botón de resumen pasa al final de la lista en horizontal) y navegación atrás: sin pérdida de estado.
5. **Release real**: se firmó una copia **temporal** del APK de release con la llave de depuración pública del SDK (solo para esta prueba; se borró; **no** existe firma release) y se instaló: arranca con R8 + SQLCipher, sin banner de demostración, sin grupos, con el cifrado activo y sin las secciones de debug, sin fallos en el log.
6. Logs de los procesos debug y release: sin claves (`x'…'`), sin cadenas hexadecimales de 64, sin nombres de alumnos y sin excepciones.

Limitaciones de esta verificación: un solo emulador (x86_64, API 36); no se probó en un dispositivo físico, en StrongBox ni en Android 8/9.

## Pendientes (no implementados a propósito)

Aprobación de la autenticación móvil (ADR 0005, hoy prototipo aislado) y su paso a producción; exigir PIN/huella a la clave y atestación; descarga de grupos autorizados y del padrón; sincronización y resolución de conflictos; finalización oficial; verificación de dependencias de Gradle y aviso de terceros del binario nativo; firma release y distribución del APK; logotipo oficial; calendario no lectivo; reglas de captura tardía y correcciones (decisiones institucionales en [diseno-asistencia-diaria.md](diseno-asistencia-diaria.md)).
