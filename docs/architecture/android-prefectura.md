# App Android de prefectura (etapa 1: captura local con datos ficticios)

Estado (2026-10-27): **primera app nativa funcional, solo con datos SINTÉTICOS**, compilada, instalada y probada en el emulador. Es una base para la etapa siguiente; **no** es todavía un cliente de la escuela.

## Qué es y qué NO es

| Es                                                                                                 | No es                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App Kotlin + Jetpack Compose + Room que muestra grupos **ficticios** y captura Presente/Ausente    | Un cliente de la API: no hay inicio de sesión, ni descarga de grupos reales, ni envío de asistencia              |
| Captura local persistente (sobrevive al cierre de la app y funciona sin internet)                  | Un registro oficial de asistencia: lo capturado es un **borrador local** y nunca se finaliza                     |
| Modo demostración **solo en debug**, rotulado en todas las pantallas                               | Distribuible: no hay firma release ni se entrega ningún APK a la escuela                                         |
| Preparación de la arquitectura (fuente local, puerto remoto vacío, `requestId` local por borrador) | Un protocolo de sincronización (no se inventó; ver [ADR 0005](../decisions/0005-android-autenticacion-movil.md)) |

- Los datos son sintéticos (`Alumno 01 Ficticio 1A`…), generados localmente. No se usaron datos de menores ni se conectó con `eta15_dev`. No se alteró PostgreSQL.
- Room guarda **solo en este dispositivo**. No hay sincronización ni login escolar. No existe registro oficial de asistencia desde Android.

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
    src/main      código y recursos comunes (domain, data, ui, AppContainer)
    src/debug     DemoMode (datos ficticios), DevHealthCheck, INTERNET y red HTTP solo hacia 10.0.2.2
    src/release   DemoMode y DevHealthCheck VACÍOS (no existen datos ficticios ni red)
    src/test      pruebas JVM (dominio, ViewModels, política de seguridad)
    src/androidTest  pruebas en emulador (Room, esquema, interfaz)
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
- `LocalAttendanceRepository` filtra todo por `profileId` (aislamiento por perfil) y escribe en transacciones de Room.
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

## Seguridad móvil (qué hay y qué falta)

Hay: `allowBackup=false` + reglas de `fullBackupContent` y `dataExtractionRules` que excluyen **todos** los dominios en copia en la nube y transferencia entre dispositivos; `usesCleartextTraffic=false` (HTTPS obligatorio en release); release **sin permiso INTERNET**; HTTP solo en debug y solo hacia `10.0.2.2`; `FLAG_SECURE` en release; sin credenciales ni tokens en código o recursos (prueba automática); sin `fallbackToDestructiveMigration`; sin firma ni llaves en el repositorio; logs del proceso sin secretos ni nombres.

**Falta (a diseñar antes de datos reales)**: cifrado de Room en reposo y llaves en Android Keystore, autenticación del dispositivo y de la persona, sesiones móviles, revocación, caducidad del paquete offline, procedimiento de pérdida/robo y actualización forzada. Room **no cifra** por sí solo; por eso solo se permiten datos sintéticos. Diseño propuesto: [ADR 0005](../decisions/0005-android-autenticacion-movil.md).

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

## Resultados de pruebas (2026-10-27)

| Prueba                                                                           | Resultado                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `testDebugUnitTest` y `testReleaseUnitTest` (dominio, ViewModels, seguridad)     | 30 + 30, 0 fallos                                   |
| `connectedDebugAndroidTest` (Room, esquema, interfaz) en `Medium_Phone_API_36.1` | 31, 0 fallos                                        |
| `lintDebug` / `lintRelease`                                                      | 0 errores (avisos informativos de versiones nuevas) |
| Prueba manual en emulador (ver abajo)                                            | Completada                                          |

La prueba manual cubrió: arranque, pantalla inicial, grupos ficticios, abrir lista, marcar presentes y ausentes, contadores, cerrar el proceso (`force-stop`) y reabrir con las marcas intactas, modo avión con captura sin red, restablecimiento de la red sin afirmar sincronización, `/health` (sin red, con red sin servidor y con el API local), rotación, botón atrás, pantalla pequeña (720×1280 a 240 dpi) y revisión de logs. La rotación mostró que el botón de resumen fijo ocupaba demasiado espacio en horizontal; se movió al final de la lista en ese modo.

## Pendientes (no implementados a propósito)

Autenticación real y registro de dispositivos; descarga de grupos autorizados y del padrón; sincronización y resolución de conflictos; finalización oficial; cifrado en reposo; firma release y distribución del APK; logotipo oficial; calendario no lectivo; reglas de captura tardía y correcciones (decisiones institucionales en [diseno-asistencia-diaria.md](diseno-asistencia-diaria.md)).
