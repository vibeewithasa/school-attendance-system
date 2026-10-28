# App Android de prefectura (etapa 1 captura local + 2A almacenamiento cifrado + 3 caché offline SANDBOX)

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

## Room (esquema v1 de la etapa 1; v2 en la etapa 3 añade la caché offline; v3 en la etapa 4 añade la outbox local, ver sus secciones; `exportSchema=true`, sin migración destructiva)

| Tabla               | Contenido                                                                              | Integridad                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `profiles`          | Perfil local (en debug, el perfil ficticio)                                            | PK                                                                                    |
| `school_groups`     | Grupos del perfil                                                                      | FK → perfil (cascada); único (id, perfil)                                             |
| `students`          | Datos mínimos: nombre y apellido sintéticos (sin CURP, tutores, foto ni datos médicos) | FK → grupo; único (id, grupo)                                                         |
| `attendance_drafts` | **Un borrador** por perfil + grupo + fecha; `requestId` estable (futuro idempotente)   | FK compuesta (grupo, perfil); únicos (perfil, grupo, fecha), `requestId`, (id, grupo) |
| `attendance_marks`  | Una marca por alumno en cada borrador; `NULL` = pendiente                              | PK (borrador, alumno); FK compuestas al borrador y al alumno **del mismo grupo**      |

Reglas en la base (disparadores en `onOpen`, `IF NOT EXISTS`): la marca solo puede ser `NULL`, `PRESENT` o `ABSENT`; no se crean borradores en sábado/domingo ni con fecha inválida; la identidad del borrador es inmutable. El padrón del borrador se **congela** al abrirlo. En la etapa 1 no había tablas de sincronización ni de operaciones pendientes; la etapa 4 añade la outbox local (`sync_operations`, `sync_operation_marks`, solo perfiles SANDBOX) sin enviar nada.

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

Todo dato lleva `profileId` con llaves foráneas compuestas (grupo→perfil, borrador→grupo del mismo perfil, marca→borrador y alumno del mismo grupo); el repositorio está atado a un perfil y no ve ni modifica datos de otro (probado también sobre la base cifrada). `CatalogDao.deleteProfile(id)` borra un solo perfil en cascada sin tocar los demás. **No hay gestión de cuentas** ni cambio de perfil en la interfaz; un cambio de titular implicará borrar el perfil anterior (ADR 0005). La etapa 2A no requirió migraciones de Room; la etapa 3 añade la migración aditiva 1→2.

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

## Caché offline de grupos autorizados (etapa 3, solo SANDBOX, rama `feat/android-offline-cache`)

> **Dependencia de ramas**: esta rama parte de `feat/android-mobile-auth` (PR #2, borrador, sin fusionar) porque usa su canal `/mobile/*`. Su Draft PR tiene como base esa rama, **no** `main`; si el PR #2 cambia, esta rama debe actualizarse sobre él. Nada de esto está aprobado: el [ADR 0005](../decisions/0005-android-autenticacion-movil.md) sigue **PROPUESTO**.

### Qué hace

Con el dispositivo vinculado al servidor de PRUEBAS (`pnpm dev:sandbox -- ... --mobile-auth`, cuentas y alumnos ficticios) la app descarga **solo** lo que el servidor autoriza a esa persona y lo guarda en la misma base Room/SQLCipher de la etapa 2A. Después se pueden abrir grupos y padrón y marcar Presente/Ausente/Pendiente **sin internet**, también tras cerrar y reabrir el proceso. La captura es un **borrador local**: no se envía nada de asistencia al servidor (no existe ninguna petición `/attendance` en el código de debug ni en el de release; hay pruebas estáticas que lo verifican).

### Descarga mínima y autorizada

1. Con sesión móvil abierta: `GET /mobile/school/me/groups` (grupos asignados vigentes) y, por cada grupo, `GET /mobile/school/groups/:id/roster`. No se agregaron rutas ni permisos; no se descarga «todo» para filtrar en el teléfono.
2. Proyección mínima: id remoto, nombre y apellido del alumno, grupo, grado, turno y ciclo. Sin código escolar, expediente, CURP, tutores, fotografía ni datos médicos.
3. `ResponseValidator` (solo debug) rechaza la descarga entera si hay identificadores que no son UUID, duplicados, más de 50 grupos o 1000 alumnos, fecha escolar ausente o un padrón que no corresponde al grupo pedido.
4. **Todo o nada**: `OfflineCacheStore.commit` escribe en **una transacción** de Room. Si algo falla (red, validación, proceso detenido) queda el último estado válido y la interfaz dice «descarga incompleta»; nunca se declara completa una descarga parcial.
5. Un `404` al pedir el padrón de un grupo significa «ya no está asignado» y es un resultado válido (grupo revocado), no un error de red. `401 DEVICE_REVOKED` y `403/NOT_ELIGIBLE` bloquean el perfil.

### Modelo local (Room v2, migración aditiva `MIGRATION_1_2`, sin `fallbackToDestructiveMigration`)

- `profiles` +`source` (`DEMO` o `SANDBOX`); `school_groups` +`remoteId`, ciclo, turno, `authState` (`ACTIVE`/`REVOKED`); `students` +`remoteId`, `active`; `attendance_drafts` +`rosterDigest`, `needsReview`, `reviewReason`.
- Tablas nuevas: `roster_snapshots` (padrón usado por grupo: fecha, huella SHA-256 y conteo) y `profile_sync` (dispositivo, último contacto con el servidor, fecha escolar confirmada, vigencia, estado de autorización y marca de agua del reloj).
- Esquema exportado en `app/schemas/.../2.json`. La migración conserva datos (prueba `SchemaMigrationTest`) y la conversión de la base v1 sin cifrar acepta las versiones 1 y 2.
- Se usa `@Upsert`, nunca `REPLACE` (que borraría en cascada borradores y marcas); una prueba estática lo vigila. Los alumnos que desaparecen del padrón pasan a `active = 0`, **no se borran**.

### Cuenta ↔ caché (aislamiento)

- La identidad sale del servidor: el perfil SANDBOX es `sbx.<deviceId>` con el `deviceId` devuelto al aprobar/abrir sesión, nunca de un campo de la interfaz. El grupo local es `<perfil>.<grupoRemoto>` y el alumno `<grupoLocal>.<alumnoRemoto>`, de modo que dos cuentas no comparten filas aunque coincidan los identificadores remotos.
- Todas las consultas filtran por perfil. Demostración y SANDBOX no se mezclan (`source`). «Borrar caché de este perfil» (`purgeSandboxProfile`) solo elimina perfiles `SANDBOX`.
- Al vincular otra cuenta en el mismo teléfono, la caché anterior sigue cifrada pero **no es visible** desde la nueva identidad (prueba E2E de aislamiento).

### Fecha escolar y reloj

- Regla de la escuela: `America/Mazatlan`, lunes a viernes; el servidor decide «hoy». La app guarda la **fecha escolar confirmada por el servidor** y la hora del último contacto; el reloj del teléfono no es autoridad.
- Sin red se usa la fecha del dispositivo **solo para abrir el borrador de hoy**, y la pantalla avisa «fecha no confirmada por el servidor» (`offline-date-unconfirmed`). En fin de semana no se abren listas nuevas.
- `ProfileAccessGate` mantiene una marca de agua (`highWater`) del reloj: si `ahora < marca - 2 min` el perfil queda bloqueado por **reloj sospechoso** (`CLOCK_SUSPECT`). Adelantar el reloj puede **agotar** la vigencia (bloquea antes), pero no la alarga. Cambiar la hora manualmente hacia atrás no reabre borradores de otros días ni extiende la vigencia; se corrige reconectando. No hay corrección histórica de días pasados.

### Vigencia offline provisional (SANDBOX)

- Vigencia corta configurable solo en debug (`-Peta15.offlineValidityMinutes`, 30 min por defecto; release = 0 porque no existe la función). Es una **simulación de pruebas**, no una política: la duración real es una decisión institucional pendiente.
- Al vencer se **bloquean las consultas protegidas** (grupos, padrón, apertura y marcas) y se muestra «Acceso offline vencido: se requiere reconexión». **No se borran los borradores**; no se confunde con la sesión móvil ni con la vinculación del dispositivo (son controles independientes). El cifrado y el aislamiento siguen activos.

### Revocaciones y cambios de padrón

| Evento                                        | Con red                                                                                                                                            | Sin red                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Grupo desasignado / grupo o ciclo desactivado | Al descargar, el grupo pasa a `REVOKED`: padrón oculto, no se captura                                                                              | **No se puede saber**: la caché sigue válida hasta vencer la vigencia |
| Rol revocado o cuenta deshabilitada           | `403`/`NOT_ELIGIBLE`: perfil bloqueado (`ACCOUNT_BLOCKED`)                                                                                         | Igual: sin conocimiento hasta reconectar                              |
| Dispositivo revocado                          | `401 DEVICE_REVOKED`: perfil bloqueado                                                                                                             | Igual                                                                 |
| Traslado, baja, alumno nuevo, cambio de ciclo | Nueva huella del padrón; los borradores con otra huella quedan `needsReview` (`ROSTER_CHANGED`) sin tocar sus marcas; las bajas pasan a `active=0` | —                                                                     |
| Descarga repetida / interrumpida              | Idempotente por `@Upsert`; la interrumpida no deja estado parcial                                                                                  | —                                                                     |

En todos los casos los borradores se **conservan** (se marcan para revisión) y la app **no ordena borrado remoto**: no existe borrado remoto. Revocar no puede alcanzar a un teléfono apagado o sin red; el límite real de exposición es la vigencia offline (a definir). Un grupo cuya asignación se pierde conserva el borrador local, pero la captura queda bloqueada hasta que Dirección decida qué hacer con él.

### Identificadores de operación (preparación, sin envío)

Cada borrador conserva su `requestId` estable (ya existente) y ahora la huella del padrón usado, para poder repetir un envío idempotente en el futuro. **No** se implementó `POST` de asistencia, reintentos, WorkManager, resolución de `409`, finalización remota ni reglas de captura tardía.

### Interfaz

Aviso permanente «DATOS DE PRUEBA DESCARGADOS (SANDBOX)», última actualización, vigencia, fecha no confirmada, grupos con etiqueta de «revocado» o «padrón por revisar», pantalla de acceso bloqueado por motivo (vigencia vencida, dispositivo revocado, cuenta bloqueada, reloj inconsistente) con «Volver», botones de descarga/«abrir sin conexión»/«borrar caché» en la pantalla de vinculación. La demostración local sigue separada y no muestra nada de la caché. No hay un inicio de sesión escolar falso. Nunca se usan los textos «Sincronizada», «Enviada», «Finalizada oficialmente» ni «Registrada por la escuela».

### FUNCIONA / NO FUNCIONA TODAVÍA / NO APROBADO

- **Funciona (solo debug + sandbox con datos ficticios)**: descarga mínima autorizada en una transacción; caché cifrada que sobrevive al reinicio del proceso; apertura de grupos/padrón y captura Presente/Ausente/Pendiente en modo avión; bloqueo por vigencia vencida, reloj sospechoso, dispositivo revocado y cuenta bloqueada; grupos revocados detectados al reconectar; padrón cambiado marcado para revisión; aislamiento entre cuentas; el release sigue sin `INTERNET` ni cliente de red.
- **No funciona todavía**: envío/sincronización de asistencia, reintentos, finalización oficial, correcciones, captura tardía, borrado remoto, detección de revocaciones sin red, actualización forzada, MFA y atestación del dispositivo, programación automática de descargas.
- **No aprobado**: la autenticación móvil (ADR 0005 propuesto), la vigencia offline de la escuela, la retención de la caché tras revocar, el uso con datos reales y cualquier distribución de APK.

### Resultados de pruebas (2026-10-27)

| Prueba                                                                                     | Resultado                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `testDebugUnitTest` / `testReleaseUnitTest`                                                | 82 / 44, 0 fallos                          |
| `connectedDebugAndroidTest` (emulador `Medium_Phone_API_36.1`)                             | 105 ejecutadas, 0 fallos, 2 omitidas (E2E) |
| `lintDebug`, `lintRelease`, `assembleDebug`, `assembleRelease`                             | compilan, sin errores                      |
| E2E offline contra el sandbox (`-e e2e offline`, guion externo con modo avión y reinicios) | 17/17                                      |

Las instrumentadas nuevas cubren: persistencia tras reabrir la base cifrada, ausencia de texto claro en el archivo, clave perdida y base corrupta que **fallan cerrado**, conversión de v1 plana, migración 1→2 con datos, y los estados de interfaz. Las JVM cubren validación de la descarga (UUID, duplicados, límites, grupo ajeno, 404), cuenta equivocada, sesión vencida, vigencia vencida, reloj atrasado, fin de semana y cambios de grupo/ciclo. El E2E verifica: vinculación y descarga de 2 grupos, red apagada + proceso reiniciado + captura, persistencia en otro proceso nuevo, reconexión sin perder el borrador, revocación del grupo A desde el portal y su detección, segunda cuenta con un grupo y aislamiento, y **cero peticiones `/attendance`** en el registro del servidor.

Limitaciones: un solo emulador (x86_64, API 36), sin dispositivo físico, sin StrongBox; el ajuste manual del reloj del dispositivo se cubre con pruebas de unidad (reloj inyectado), no moviendo el reloj del emulador.

### Contratos que faltan en el backend (para el futuro protocolo de sincronización)

Versión o ETag del padrón (hoy se calcula una huella en el cliente), fecha escolar en cada respuesta (hoy `asOf` del padrón), `POST` idempotente de asistencia por `requestId` con control de revisión, política para listas ya finalizadas por otra prefecta, reglas de captura tardía, canal para avisar revocaciones en la próxima conexión y límites del tamaño de lote. Ninguno se implementó.

## Outbox local persistente (etapa 4, esquema Room v3, solo SANDBOX, rama `feat/android-offline-outbox`)

Apilada sobre el PR #6 (escritura móvil de asistencia en el backend de sandbox), #5, #4, #3 y #2 (todos Draft; ninguno fusionado). Prepara **localmente** las operaciones de asistencia de una futura sincronización. **En esta etapa Android no envía nada**: no hay cliente HTTP de escritura, `WorkManager`, reintentos ni finalización; el release sigue sin `INTERNET`. «Preparar para sincronizar» solo sella datos en la base cifrada del dispositivo. (El transporte manual, solo debug y sandbox, es la etapa 5, más abajo.) El diseño completo de transporte está en [protocolo-sincronizacion-asistencia.md](protocolo-sincronizacion-asistencia.md) §21.

### Cuatro cosas que no se mezclan

1. **Borrador local editable** (`attendance_drafts` + `attendance_marks`): lo que la prefecta ve y cambia; `NULL` = Pendiente. Nunca se bloquea por haber preparado.
2. **Intención de sincronizar** (`sync_operations`, `SAVE_MARKS` en `LOCAL_ONLY`): se crea/retira sola, **en la misma transacción** que cambia una marca, si las marcas explícitas difieren de lo ya sellado. No tiene `requestId`: es desechable.
3. **Operación sellada** (inmutable): al pulsar «Preparar para sincronizar» se asigna un `requestId` (UUID en minúscula), el payload mínimo (`studentId` en minúscula + `present`/`absent`; los Pendientes **no viajan** ni significan «borrar»), el hash canónico (SHA-256 de `studentId:status` ordenado y unido con `|`, idéntico al del backend), la fecha escolar y su procedencia, y la huella del padrón. La identidad sellada **no incluye** `dayId` ni `expectedRevision`.
4. **Recibo del servidor** (futuro): `ackRevision`, `ackedAt`, `ackChanged`, `ackReplayed`, `serverDayId`. Hoy solo se llenan en pruebas, simulando el transporte.

### Esquema v3 (migración aditiva `MIGRATION_2_3`, sin `fallbackToDestructiveMigration`; `3.json` versionado)

| Tabla                  | Contenido                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_operations`      | Perfil, dispositivo, grupo local y remoto, fecha escolar, borrador, `kind` (`OPEN`/`SAVE_MARKS`), `seq` por (perfil, grupo, fecha), estado, motivo, dependencia, reemplazo, identidad sellada, contexto remoto, ciclo de vida (intentos, último HTTP/código), recibo |
| `sync_operation_marks` | Payload sellado: PK (operación, alumno remoto), `present`/`absent`                                                                                                                                                                                                   |

Índices y UNIQUE: `requestId` único; (perfil, grupo, fecha, `seq`) único; FK compuestas al grupo y al borrador (cascada solo al borrar el perfil de forma explícita). **No** se guarda ningún token de acceso/renovación, prueba DPoP, clave privada, contraseña ni dato de otro perfil. Las tablas viven en la misma base SQLCipher (clave envuelta por Android Keystore); no se tocó el cifrado.

Se descartaron `sync_day_state` y `sync_acked_marks` del diseño del Prompt 39: el estado confirmado por día se deriva de las operaciones `ACKNOWLEDGED` del propio grupo y fecha (menos tablas, una sola fuente de verdad).

La integridad crítica vive **también en la base** (disparadores `IF NOT EXISTS` en `onOpen`, junto a los de v1/v2): inserción de intenciones solo para perfiles SANDBOX, identidad sellada inmutable, payload inmutable tras sellar, estados terminales inmutables, máquina de estados, `READY`/`SENDING` exigen `requestId`, sellado y contexto remoto, `READY` exige dependencia `ACKNOWLEDGED`, una sola operación `READY`/`SENDING` por grupo y fecha, recibo completo para `ACKNOWLEDGED`, y solo se pueden borrar intenciones `LOCAL_ONLY` (o todo al borrar el perfil).

### OPEN y SAVE_MARKS

El servidor exige abrir la lista del día (`POST …/days`, fecha escolar) antes de guardar marcas (`POST …/days/:id/marks`, con `dayId` y `expectedRevision`). Se modelan **dos operaciones** con dependencia explícita: `OPEN` (por perfil, grupo y fecha; sin payload ni `requestId` propio en esta etapa) y `SAVE_MARKS` (depende de `OPEN` o de la `SAVE_MARKS` anterior). Cuando `dayId` y `expectedRevision` **se desconocen** (siempre, mientras no exista transporte) la operación queda en `WAITING_REMOTE_CONTEXT`; **no se inventan** ni se marca `READY` con un payload inválido ni se calcula un hash con campos provisionales. Resolución futura: al confirmarse `OPEN` (o la `SAVE_MARKS` previa) el transporte llama a `resolveContext(serverDayId, expectedRevision)`, que solo llena esas dos columnas y mueve a `READY`; `requestId`, hash, cantidad de marcas y fecha de sellado **no cambian** (verificado por prueba).

### Estados y transiciones

`LOCAL_ONLY → WAITING_REMOTE_CONTEXT | READY | NEEDS_REVIEW | SUPERSEDED | DISCARDED`; `WAITING_REMOTE_CONTEXT → READY | NEEDS_REVIEW | AUTH_REQUIRED | SUPERSEDED | DISCARDED`; `READY → SENDING | NEEDS_REVIEW | AUTH_REQUIRED | SUPERSEDED | DISCARDED`; `SENDING → ACKNOWLEDGED | RETRYABLE_ERROR | AUTH_REQUIRED | CONFLICT | NEEDS_REVIEW`; `RETRYABLE_ERROR`/`AUTH_REQUIRED` vuelven a `READY` o `NEEDS_REVIEW`; `CONFLICT → NEEDS_REVIEW | DISCARDED`; terminales: `ACKNOWLEDGED`, `SUPERSEDED`, `DISCARDED`. Un `SENDING` persistido tras un reinicio es un resultado **desconocido**: pasa a `RETRYABLE_ERROR` con motivo `RESULT_UNKNOWN_AFTER_RESTART`, nunca a éxito ni a «nunca salió». Descartar exige confirmación de la persona y conserva la fila. Los estados de red (`SENDING`, `ACKNOWLEDGED`, `RETRYABLE_ERROR`, `CONFLICT`) solo se alcanzan en pruebas con los métodos de «transporte futuro» de `OutboxStore`, que ningún código de producción llama (prueba estática).

### Inmutabilidad

Tras sellar, una edición posterior **conserva** la operación sellada intacta, **conserva** la edición local y registra una **nueva intención** `LOCAL_ONLY`. Preparar de nuevo sella otra operación con **otro** `requestId`; la anterior, si no pudo llegar al servidor, queda `SUPERSEDED` (y enlazada con la que la reemplaza) y se **conserva**; si pudo haber llegado (`SENDING`, `RETRYABLE_ERROR`, `ACKNOWLEDGED`…) la nueva depende de ella en lugar de reemplazarla. Nunca se reutiliza un `requestId` con otro contenido, nunca hay dos `READY` incompatibles sobre la misma revisión. Una marca ya confirmada por el servidor no puede volver a Pendiente (`UnmarkAfterAck`): sólo cambia entre Presente y Ausente.

### Identidad, fecha y padrón

- Todo se filtra por perfil (`sbx.<deviceId>`); la demostración local (DEMO) **no tiene outbox** (el disparador lo impide aun por SQL directo). La cuenta B del mismo teléfono no ve ni sella operaciones de la cuenta A; la revocación del dispositivo/cuenta pasa lo `READY` a `AUTH_REQUIRED` sin borrar nada; recuperar la sesión no amplía el alcance (la autorización se evalúa en cada llamada, no con lo que declare la interfaz).
- La fecha escolar es la del borrador (`America/Mazatlan`) y se **conserva**: una captura de ayer nunca se convierte en la de hoy, y nunca queda `READY` (queda `NEEDS_REVIEW`, motivo `DATE_HISTORIC`; las capturas tardías no están aprobadas por la escuela). El reloj del teléfono no es autoridad: si la última fecha validada por el servidor no coincide, la procedencia es `DEVICE_UNCONFIRMED` y la operación queda esperando (`DATE_UNCONFIRMED`). Tras un reinicio no se afirma que la fecha esté validada.
- Un padrón distinto al del sellado, un alumno que ya no está en el padrón (inactivo) o un grupo revocado pasan las operaciones sin enviar a `NEEDS_REVIEW` (`ROSTER_CHANGED`, `STUDENT_INACTIVE`, `GROUP_REVOKED`) **sin modificar marcas ni payload**. Más de 200 marcas o identificadores no válidos se rechazan sin crear nada.

### Interfaz mínima

En el resumen de la lista (solo perfiles descargados): título «Preparación para sincronizar», aviso «Preparar guarda la operación solo en este dispositivo. No se envía nada al servidor», marcas locales, «Hay cambios sin preparar», operaciones preparadas y su estado («Requiere contexto del servidor para poder enviarse», «Preparado para envío futuro (aún no se envía)», «Necesita revisión», «Requiere volver a autenticar el dispositivo»), el botón **Preparar para sincronizar** y mensajes de resultado (incluido «Error local… El borrador no se modificó»). No hay botón «Enviar al servidor» ni los textos «Enviado», «Sincronizado» o «Registrado oficialmente» (prueba estática).

### Pruebas y resultados

| Prueba                                                                         | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testDebugUnitTest` / `testReleaseUnitTest`                                    | 106 / 68, 0 fallos (21 de dominio de la outbox: hash idéntico al del backend, normalización, planificador, transiciones; 3 estáticas nuevas)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `connectedDebugAndroidTest` (emulador `Medium_Phone_API_36.1`)                 | 149 ejecutadas, 0 fallos, 2 omitidas (E2E, solo con `-e e2e …`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OutboxStoreTest` (Room real)                                                  | 30: intención atómica, sellado, inmutabilidad por SQL directo, reversión ante fallo de sellado, dependencias y contexto remoto, recuperación de `SENDING`, fecha histórica o no confirmada, padrón cambiado, alumno inactivo, grupo y dispositivo revocados, más de 200 marcas, dos perfiles, varias fechas y grupos, borrado del perfil; fallos inyectados con disparadores (al guardar una marca, al retirar la intención, en el último paso del sellado) que no dejan marca, `OPEN`, payload ni sellado a medias                                                                                                                                                                                                                                                                                                                                                        |
| `SchemaMigrationTest`                                                          | v3 limpia, 2→3 y 1→2→3 con datos (dos perfiles, grupo revocado, alumno inactivo, borradores incompletos), cierre y reapertura tras migrar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OfflineCacheEncryptedTest`                                                    | outbox persistente tras reiniciar sobre SQLCipher, sin `requestId`, estados ni identificadores en claro; conversión de la base anterior v1 y v2 a v3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OutboxUiTest`                                                                 | 7: textos, botón, estados y ausencia de «Enviado», «Sincronizado» y «Registrado oficialmente»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lintDebug`, `lintRelease`, `assembleDebug`, `assembleRelease`                 | compilan; 0 errores                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Manifiesto release                                                             | sin `INTERNET` (solo `ACCESS_NETWORK_STATE`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| E2E offline contra el sandbox (`-e e2e offline`, guion externo con modo avión) | 22/22 (con la lectura y la ESCRITURA móvil de asistencia habilitadas en el servidor: si Android enviara algo, llegaría y se vería): descarga de 2 grupos; red apagada + proceso reiniciado + captura; «Preparar para sincronizar» sin red; outbox intacta en otro proceso; reconexión; revocación del grupo A (operaciones a `NEEDS_REVIEW` con `GROUP_REVOKED`, nada borrado); segunda cuenta y aislamiento (la outbox de A está en el mismo archivo cifrado y B no la ve ni la sella); **0 peticiones con «attendance» en la URL** en el registro del servidor, con control positivo (una lectura del portal sí se cuenta: antes 0, después 1); además **muerte real del proceso** (`am force-stop`) con una transacción SQL abierta y una marca sin confirmar: al reabrir, `integrity_check` = ok, lo no confirmado no existe, lo confirmado sí y la app sigue operando |

Limitaciones: un solo emulador (x86_64, API 36), sin dispositivo físico ni StrongBox; la medianoche y el reloj se prueban con reloj inyectado, no moviendo el reloj del emulador; no existió una base SQLCipher v2 de campo, así que la migración 2→3 se prueba con Room sobre base plana y la conversión de la base anterior v1/v2 hacia la cifrada v3.

### Riesgos residuales (auditoría de cierre)

- **`NEEDS_REVIEW` no tiene salida.** Ninguna acción limpia hoy la marca de revisión del borrador ni la operación (la política de revisión no está decidida): estas operaciones se conservan pero el transporte no podrá enviarlas hasta definirla.
- **Procedencia de la fecha.** `SERVER_CONFIRMED` significa que la fecha escolar del teléfono coincide con la que informó el servidor en la última descarga; no es una validación en vivo. La autoridad real es el servidor al enviar (`attendanceDate`).
- **Sin deduplicación entre dispositivos.** Dos dispositivos de la misma cuenta pueden preparar operaciones distintas para el mismo grupo y fecha; el servidor las ordena con `expectedRevision` (se resuelve en la fase de transporte).
- **Pruebas de recuperación.** La muerte del proceso a mitad de transacción se probó con `am force-stop` en un solo emulador; no hay prueba en dispositivo físico ni con apagado del sistema.

### FUNCIONA / NO FUNCIONA / NO APROBADO

- **Funciona (debug + sandbox, datos ficticios)**: migración 1→2→3 y 2→3 con datos; outbox cifrada que sobrevive a cierre y reinicio del proceso; intenciones atómicas con la marca; sellado atómico con reversión completa ante fallo; operaciones inmutables (también ante SQL directo); máquina de estados con disparadores; aislamiento por perfil y dispositivo; fechas históricas, padrón cambiado, alumno inactivo y grupo revocado a revisión; sin ninguna petición de asistencia desde Android (E2E).
- **No funciona todavía**: transporte (abrir/guardar contra el servidor), resolución real de `dayId`/`expectedRevision`, reintentos, `WorkManager`, resolución de `409`/conflictos, finalización móvil, capturas históricas y correcciones, atestación del dispositivo, aviso de revocación sin red.
- **No aprobado**: ADR 0005 y ADR 0006 siguen PROPUESTOS; políticas de captura tardía y conservación local; uso con datos reales; distribución de APK.

## Transporte manual de asistencia (etapa 5, solo SANDBOX debug, rama `feat/android-manual-sync-sandbox`)

Apilada sobre el PR #7 (outbox Room v3) → #6 → #5 → #4 → #3 → #2 (todos Draft; ninguno fusionado). **Primer circuito de sincronización, exclusivamente en el servidor de pruebas y solo en el build debug**: una prefecta toma lista sin internet, la prepara y, al recuperar la conexión, **pulsa «Sincronizar ahora»** para enviarla. ADR 0005 y 0006 siguen **propuestos**; nada de esto está aprobado por la escuela ni habilita datos reales.

### Dónde vive y cómo se activa

- **Solo en debug.** El motor (`ManualSyncEngine`), el cliente HTTP con DPoP (`HttpMobileApi` + `AttendanceApi`), la sesión de un ciclo (`DeviceSyncSessions`), el adaptador a la outbox (`RoomSyncStore`) y la política de validación y errores (`SyncPolicy`) están en `src/debug`. En `main` solo hay el **puerto** `ManualSync` y `NoManualSync`; en release `MobileFeature.manualSync` devuelve `NoManualSync`: sin red, sin permiso `INTERNET` y sin el botón. Pruebas estáticas lo verifican (rutas de asistencia solo en `HttpMobileApi.kt`, exactamente cuatro; nada de WorkManager, receptores de red, temporizadores ni arranque).
- **Requisitos para que exista el botón**: dispositivo vinculado (registro local), clave en el Keystore, perfil `sbx.<deviceId>` del **mismo** dispositivo, y que el servidor de pruebas tenga `--mobile-attendance-read` y `--mobile-attendance-write` (si no, `NOT_ENABLED`). La identidad sale del registro local de vinculación, nunca de la interfaz; un perfil DEMO no tiene motor.
- **Solo una persona lo inicia**: «Sincronizar ahora» en el resumen de la lista. No se inicia al abrir la app, al recuperar la conexión, al reiniciar el proceso, al iniciar sesión, al navegar, al preparar ni por un temporizador. **Un solo ciclo a la vez** (cerrojo en el motor y un solo motor por perfil), **cancelable** sin perder lo persistido.

### Contrato HTTP real (verificado en el backend)

| Operación | Ruta                                  | Cuerpo                                                               | Éxito                                                                                                                | Errores usados                                                                                                                              |
| --------- | ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Hoy       | `GET /mobile/school/attendance/today` | —                                                                    | `schoolToday`, `isSchoolDay`, grupos asignados hoy con su lista o `null`                                             | 401, 403, 404 (ruta deshabilitada)                                                                                                          |
| Lista     | `GET …/days/:id`                      | —                                                                    | `day` (id, grupo, fecha, `status` draft/finalized, `revision`), `rosterDigest` v1, `records` (`studentId`, `status`) | 404                                                                                                                                         |
| Abrir     | `POST …/days`                         | `{groupId, attendanceDate}` (fecha obligatoria)                      | 201 creada / 200 existente                                                                                           | 400 `DATE_NOT_TODAY`, 404, 409 `NOT_SCHOOL_DAY`, `GROUP_INACTIVE`, `OUT_OF_YEAR`, `EMPTY_ROSTER`, `ROSTER_CHANGED`, `CONCURRENT`            |
| Guardar   | `POST …/days/:id/marks`               | `{expectedRevision, requestId, marks[]}` (≤ 200; `present`/`absent`) | 200 `{day, changed, replayed}`                                                                                       | 400 `STUDENT_NOT_IN_LIST`, 404, 409 `REVISION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `DAY_FINALIZED`, `DAY_NOT_CURRENT`, `CONCURRENT`; 429; 503 |

No existen finalizar, borrar, corregir ni historial por este canal, y el cliente no los conoce. Cada petición lleva `Authorization: DPoP` y una **prueba DPoP nueva** (`jti` aleatorio, método, URL y hash del token); el `requestId` de la operación viaja solo en el cuerpo y es **estable en los reintentos** (no es el `jti`).

### Un ciclo (qué hace y en qué orden)

1. **Identidad**: el dispositivo vinculado es el del perfil; un `SENDING` que quedó a medias pasa a resultado desconocido (`RETRYABLE_ERROR`).
2. **Sellado local** de cambios pendientes del borrador de hoy (acción local; sin red).
3. **«Hoy» según el servidor** (`GET today`): fecha escolar, día lectivo y grupos asignados. Sin red → `OFFLINE` sin cambiar nada.
4. **OPEN**: si la lista de hoy existe se reutiliza su `dayId` y revisión **sin escribir**; si no, se abre. El recibo (`dayId`, revisión) se guarda en Room. Si se pierde la respuesta, el siguiente ciclo consulta primero «hoy»: no se abre dos veces.
5. **SAVE_MARKS**: lista fresca (`GET day`), validación (fecha, grupo, estado, padrón por conjunto y por huella v1, revisión confirmada y marcas ajenas), **completar el contexto remoto** (`dayId`, `expectedRevision` reales; no son parte de la identidad sellada), persistir `SENDING` **antes** de la petición y enviar **exactamente** la operación sellada.
6. **ACK durable**: se verifica que el recibo corresponde a lo enviado (lista, grupo, fecha, revisión, marcas) y se guarda en **una sola sentencia atómica**; solo entonces la operación es `ACKNOWLEDGED` y la interfaz dice «Confirmado por el servidor».

### Decisiones ante lo que dice el servidor

| Situación                                                                   | Resultado                                                                                                                                                                  | Se envía        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Fecha del servidor ≠ fecha de la operación / otro día                       | `NEEDS_REVIEW` (`DATE_MISMATCH`)                                                                                                                                           | No              |
| Grupo ya no asignado hoy, día sin clases                                    | `NEEDS_REVIEW`                                                                                                                                                             | No              |
| Padrón del servidor ≠ padrón congelado del borrador                         | `NEEDS_REVIEW` (`ROSTER_CHANGED`)                                                                                                                                          | No              |
| Lista finalizada                                                            | `CONFLICT` (`DAY_FINALIZED`)                                                                                                                                               | No              |
| Revisión distinta de la última confirmada por este dispositivo              | `CONFLICT` (`REVISION_CHANGED`)                                                                                                                                            | No              |
| Otra persona marcó distinto a un alumno que este dispositivo nunca escribió | `CONFLICT` (`DIVERGENT_MARKS`); nada se sobrescribe                                                                                                                        | No              |
| Operación de otra fecha                                                     | `NEEDS_REVIEW`; solo se **verifica** un envío anterior de resultado desconocido repitiendo la MISMA operación (el servidor la reconoce o la rechaza; jamás crea una nueva) | Solo repetición |

Errores HTTP: `401` → `AUTH_REQUIRED` (una renovación, sin bucle); `403` `DEVICE_REVOKED`/`NOT_ELIGIBLE` → `AUTH_REQUIRED` y se bloquea el perfil; otro `403` y `404` → `NEEDS_REVIEW` sin enumerar; `409 REVISION_CONFLICT`/`DAY_FINALIZED` → `CONFLICT`; `409 IDEMPOTENCY_MISMATCH`, `NOT_SCHOOL_DAY`, `DAY_NOT_CURRENT`, `400 DATE_NOT_TODAY`/`STUDENT_NOT_IN_LIST` → `NEEDS_REVIEW` (nunca se muta el payload); `429` (respeta `Retry-After`, 1–10 s) y `503`/`409 CONCURRENT` → hasta **2 reintentos** con el mismo `requestId` y luego `RETRYABLE_ERROR`; timeout o red caída durante un envío → resultado **desconocido** (`RETRYABLE_ERROR`). No se resuelve ningún conflicto ni se descarta ningún borrador; **`NEEDS_REVIEW` y `CONFLICT` bloquean el envío y no se limpian solos** (política conservadora de sandbox; la política institucional queda pendiente de la escuela).

### Resultado desconocido y reintento idempotente

Si se pierde la respuesta (o muere el proceso, o falla Room al guardar el recibo) la operación queda con su `requestId`, payload y huella **sin cambios**. En el siguiente ciclo **manual** se reenvía exactamente lo mismo con prueba DPoP nueva y el servidor responde `replayed: true` sin repetir nada (una sola aplicación efectiva); el recibo se guarda una vez. Si cambió el día escolar no se crea una operación histórica nueva.

### Interfaz

Sección «Preparación para sincronizar»: botón **Sincronizar ahora** (solo en sandbox; deshabilitado durante un ciclo, con **Cancelar**), estados por operación (Guardada en este dispositivo, Listo para sincronizar, Sincronizando…, **Confirmado por el servidor**, Error temporal, Requiere volver a autenticar, Conflicto, Necesita revisión) y un mensaje por resultado del ciclo. Los errores de red no se presentan como pérdida de datos. Nunca se muestra «Sincronizado» ni «Enviado».

### Pruebas y resultados

| Prueba                                                                                                                                                                        | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testDebugUnitTest` / `testReleaseUnitTest`                                                                                                                                   | 159 / 70, 0 fallos. Nuevas en debug: `ManualSyncEngineTest` 36 (motor con servidor y almacén falsos con la semántica del backend), `SyncPolicyTest` 11 y `DeviceSyncSessionsTest` 4; estáticas de seguridad actualizadas (4 rutas, 2 POST, sin WorkManager ni red, `syncNow` solo desde el botón)                                                                                                                                                              |
| `connectedDebugAndroidTest` (emulador `Medium_Phone_API_36.1`)                                                                                                                | 172 ejecutadas, 0 fallos, 3 omitidas (los E2E, que corren aparte)                                                                                                                                                                                                                                                                                                                                                                                              |
| `ManualSyncRoomTest` (Room real + servidor falso)                                                                                                                             | 14: ciclo completo con recibos durables, edición posterior con otro `requestId` y la revisión confirmada, fallo REAL de Room al guardar el recibo (disparador) con recuperación sin duplicar, respuesta perdida, conflicto con otra prefecta, grupo revocado, grupo no asignado, captura de ayer, padrón cambiado, sesión expirada, dos perfiles e identidad ajena, edición concurrente durante el envío, cancelación con petición en vuelo, JSON del contrato |
| `OutboxUiTest`                                                                                                                                                                | 13 (7 previas + 6: sin botón sin transporte, botón solo por pulsación, deshabilitado y cancelable durante un ciclo, solo el recibo dice «Confirmado por el servidor», ningún resultado dice «Sincronizado» ni «Enviado»)                                                                                                                                                                                                                                       |
| `OfflineCacheEncryptedTest` / `SchemaMigrationTest`                                                                                                                           | +1 (recibo `ACKNOWLEDGED` persistente sobre SQLCipher y sin datos en claro) / +1 (un disparador desactualizado se reinstala y, sin cambios, abrir no escribe)                                                                                                                                                                                                                                                                                                  |
| `lintDebug`, `lintRelease`, `assembleDebug`, `assembleRelease`                                                                                                                | compilan; 0 errores                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Manifiesto release y APK release                                                                                                                                              | sin `INTERNET` (solo `ACCESS_NETWORK_STATE`); el `classes.dex` de release no contiene `ManualSyncEngine`, `HttpMobileApi`, `DpopProofBuilder` ni rutas `mobile/school`                                                                                                                                                                                                                                                                                         |
| **E2E del transporte manual** (`-e e2e sync`, guion externo, PostgreSQL 18 desechable, API local con lectura y escritura móvil habilitadas, emulador, DPoP y Keystore reales) | **51/51** (ver abajo)                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**E2E contra el servidor, con evidencia de ambos lados** (cuentas A «dos grupos» y B «un grupo», alumnos ficticios): vincular y descargar sin tocar la asistencia (0 peticiones); tomar lista sin red, preparar, matar el proceso y reabrir; **recuperar la conexión durante 25 s sin pulsar nada: 0 peticiones**; «Sincronizar ahora» (la ruta real del botón) → `CONFIRMED`, el servidor tiene la lista con revisión 2, 1 evento de apertura y 2 cambios, y la outbox local `OPEN`+`SAVE_MARKS` `ACKNOWLEDGED`; repetir → `NOTHING_TO_SEND` sin ningún POST; editar y **perder la respuesta** del guardado (el servidor sí lo aplicó: revisión 3) → `RESULT_UNKNOWN` y `RETRYABLE_ERROR`; tras matar el proceso, el siguiente ciclo manual recupera con el **mismo `requestId`**: recibo `replayed=1`, revisión 3, cero duplicados; otra prefecta guarda desde el portal y Android responde `CONFLICT` **sin enviar** (lo ajeno intacto, captura local completa, bloqueo persistente); grupo revocado → `NEEDS_REVIEW` sin escrituras y borrador conservado; cambio de cuenta y aislamiento (las 6 operaciones de A idénticas antes y después). **Canal móvil de asistencia, total: 9 GET y 4 POST (1 OPEN y 3 SAVE_MARKS: el envío, el envío cuya respuesta se perdió y su repetición), 0 respuestas 401 (ningún `jti` repetido), estados 200/201 únicamente.**

No se probó en E2E real (sí con servidor falso en Room real y en JVM): padrón del servidor distinto, fecha histórica por reloj, aperturas concurrentes (el servidor lo cubre en el PR #6 con PostgreSQL desechable) y sesión vencida por expiración natural. Limitaciones: un solo emulador (x86_64, API 36), sin dispositivo físico ni StrongBox; el reloj se prueba inyectado.

### FUNCIONA / NO FUNCIONA / NO APROBADO

- **Funciona (debug + sandbox con datos ficticios)**: tomar lista sin internet, preparar, cerrar y reabrir, recuperar conexión **sin que nada se envíe solo**, y enviar con «Sincronizar ahora» (OPEN + SAVE_MARKS) con DPoP real; ACK durable; repetición sin duplicados; recuperación tras respuesta perdida por `requestId`; conflicto con otra prefecta sin sobrescribir; grupo revocado, fecha, padrón y cuenta distinta bloquean o aíslan; cancelación segura.
- **No funciona / no existe**: sincronización automática, WorkManager, finalización móvil, capturas históricas y correcciones, resolución de conflictos y de `NEEDS_REVIEW`, atestación del dispositivo, producción, datos reales.
- **No aprobado**: ADR 0005 y 0006; la política de la escuela para capturas tardías, conflictos y conservación local; cualquier uso con alumnos reales o distribución de APK.

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

Aprobación de la autenticación móvil (ADR 0005, hoy prototipo aislado) y su paso a producción; exigir PIN/huella a la clave y atestación; vigencia offline y retención institucionales (la descarga de grupos y padrón existe solo como prototipo SANDBOX, ver arriba); sincronización y resolución de conflictos; finalización oficial; verificación de dependencias de Gradle y aviso de terceros del binario nativo; firma release y distribución del APK; logotipo oficial; calendario no lectivo; reglas de captura tardía y correcciones (decisiones institucionales en [diseno-asistencia-diaria.md](diseno-asistencia-diaria.md)). El transporte **manual** (OPEN y SAVE_MARKS por el canal móvil sandbox, recibos y manejo de `409`) existe solo en debug (etapa 5, [protocolo-sincronizacion-asistencia.md](protocolo-sincronizacion-asistencia.md) §22). **Sigue pendiente**: política institucional para `NEEDS_REVIEW` y conflictos, sincronización automática (con `WorkManager`, ADR y pruebas propias), finalización móvil, capturas tardías y la aprobación de los ADR 0005 y 0006.
