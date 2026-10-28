# Propuesta: aplicación Android de asistencia para prefectura (offline-first)

Estado: **propuesta de arquitectura, SIN protocolo de sincronización definido**. Redactada el 2026-10-27 sobre `main` = `2cd4614`. **La etapa 1 (app local con datos ficticios, sin red ni login) ya existe y desde la etapa 2A su base local está cifrada**: ver [android-prefectura.md](android-prefectura.md) y el [ADR 0005](../decisions/0005-android-autenticacion-movil.md) (autenticación móvil propuesta, no aceptada). El resto de este documento sigue siendo la propuesta para las etapas 2 a 5.
(asistencia diaria aplicada en `eta15_dev`, sin datos). Todo lo marcado como _decisión pendiente_ requiere acuerdo de la institución o una revisión de seguridad
propia antes de implementarse. La comprobación del entorno (sección 1) se hizo antes de crear el proyecto; en la etapa 1 no hizo falta instalar `cmdline-tools`.

## 1. Entorno Windows (comprobaciones de solo lectura)

| Elemento                  | Estado encontrado                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Android Studio            | Instalado en `C:\Program Files\Android\Android Studio`                                                         |
| JDK                       | OpenJDK 21.0.9 (JBR de Android Studio); `tools\env.ps1` fija `JAVA_HOME`                                       |
| Android SDK               | `ANDROID_HOME` definido; plataformas `android-36` y `android-36.1`, build-tools 35.0.0 y 36.1.0, sources       |
| ADB                       | `platform-tools` 36.0.2 (`adb version` correcto)                                                               |
| Emulador                  | Carpeta `emulator` presente; AVD `Medium_Phone` (imagen de sistema `android-36.1`)                             |
| Gradle                    | Distribución `gradle-8.13-bin` en caché de `~\.gradle`; sin `gradle` global (se usará el wrapper del proyecto) |
| Kotlin                    | Sin `kotlinc` global; lo aporta el plugin de Gradle                                                            |
| `cmdline-tools`           | **Ausente** (`sdkmanager`/`avdmanager` no disponibles): hace falta para gestionar el SDK por línea de comandos |
| `apps/android-prefectura` | (Al redactar) solo `.gitkeep`; ahora contiene el proyecto de la etapa 1                                        |

Pendiente (no instalado): `cmdline-tools` (instalación global, requiere autorización); versiones exactas de AGP, Kotlin, Compose BOM y Room se fijarán al crear el proyecto.
Un dispositivo físico de prueba no se ha comprobado (`adb devices` no se ejecutó).

## 2. Arquitectura prevista

- Kotlin + Jetpack Compose + Room (ya fijado en `CLAUDE.md`), módulo `apps/android-prefectura`, un solo módulo Gradle al inicio.
- Capas: UI (Compose) → ViewModel → repositorio → Room (fuente de verdad local) + cliente HTTP (OkHttp/Retrofit o Ktor) contra Fastify.
- La **API sigue siendo la autoridad**: el dispositivo nunca decide permisos, fecha escolar ni identidad. Lo que captura offline son _propuestas_ que el servidor valida.
- Distribución por APK firmado fuera de Play Store (instalación controlada por la escuela). Requiere definir quién guarda la llave de firma y cómo se actualiza (_decisión pendiente_).

## 3. Lo que el backend actual ya aporta

- Sesión de servidor con cookie `HttpOnly` + `SameSite=Strict` (`__Host-` y `Secure` en producción), CSRF por cabecera y `Origin` permitido en toda mutación.
- Vigencia de sesión: **60 min de inactividad / 12 h absolutas** para el personal general (menor para Dirección y `admin_tecnico`); máximo 5 sesiones por usuario.
- `GET /school/me/groups` (grupos asignados hoy) y `GET /school/groups/:id/roster` (padrón mínimo sin expediente).
- `/school/attendance/*`: abrir o recuperar la lista de hoy (una por grupo y fecha), detalle con renglones y `revision`, guardar marcas con `expectedRevision` + `requestId` (idempotente, reintento seguro), finalizar, historial.
- Fecha escolar decidida por el servidor (`America/Mazatlan`, lunes a viernes); 404 indistinguible fuera de alcance; padrón congelado al abrir; lista finalizada inmutable; `attendance:correct` bloqueado.

## 4. Contratos que FALTAN para un cliente offline-first

1. **Credencial de dispositivo / sesión para app nativa.** Hoy solo hay cookie de sesión de navegador. Hace falta decidir cómo se autentica la app (cookie jar con CSRF y `Origin` fijo, o un token de dispositivo de larga vida con alcance reducido). Un token de larga vida cambia el modelo de amenazas: requiere revisión de seguridad, registro y revocación por dispositivo (tabla de dispositivos), y respetar la política de sesión (MFA sigue pospuesto, solo desarrollo local).
2. **Registro y revocación de dispositivos.** Listar, bloquear y borrar remotamente la sesión de un dispositivo perdido; hoy solo existe revocar sesiones por usuario.
3. **Descarga mínima del día ("paquete del día").** Un endpoint que entregue, para los grupos asignados hoy, el padrón mínimo necesario (id opaco, nombre y apellidos, sin código escolar ni expediente), la lista abierta (si existe) y metadatos: fecha escolar del servidor, `schoolToday`, versión del padrón/asignación y caducidad del paquete. Debe respetar el alcance `assigned_groups` y la proyección mínima de prefectura.
4. **Apertura offline.** Hoy abrir la lista exige el servidor (crea el padrón congelado). Opciones, _a decidir_: (a) solo se captura offline una lista ya abierta con conexión; (b) la app abre al conectar y captura después; (c) captura local con padrón propio y reconciliación posterior (la más riesgosa, rompe el padrón congelado).
5. **Envío por lotes con resultado por elemento.** Hoy hay un guardado por lista con una `revision` global. Una cola offline necesita aceptar varios guardados y devolver el resultado de cada uno (aplicado, ya aplicado por `requestId`, conflicto de revisión, acceso revocado, día vencido) sin perder el resto.
6. **Marca de tiempo del dispositivo vs. del servidor.** Los triggers fijan `marked_at` con el reloj del servidor. Para offline sería útil registrar _cuándo se capturó_ en el dispositivo (campo informativo, nunca autoritativo) — requiere migración y nueva decisión de privilegios.
7. **Reglas de caducidad.** Qué pasa con marcas capturadas offline que llegan después de medianoche (`DAY_NOT_CURRENT`), con la lista finalizada por otra persona o con la asignación revocada. Hoy esos casos devuelven 409/404 y la app no tendría cómo conservarlos ni resolverlos (_decisión institucional pendiente_: ventana de captura tardía, quién corrige).
8. **Señal de revocación y de cambio de padrón.** Cómo se entera la app de que su asignación se revocó o de que hay `discrepancies` (hoy solo se ven al consultar el detalle).
9. **Versionado de contrato.** Cabecera o ruta de versión mínima soportada y forzado de actualización del APK.
10. **Errores y límites estables para clientes móviles**: códigos ya existentes (`DATE_NOT_TODAY`, `NOT_SCHOOL_DAY`, `DAY_NOT_CURRENT`, `IDEMPOTENCY_MISMATCH`, `REVISION_CONFLICT`, …) deben documentarse como contrato público en `packages/shared-contracts`; hoy son de la web.

## 5. Datos en el dispositivo (protección)

- Almacenar solo el padrón del día de los grupos asignados y las marcas pendientes; borrarlos al finalizar con éxito, al cerrar sesión, al caducar el paquete o al revocarse la asignación.
- Room cifrada (SQLCipher o equivalente) con llave protegida por Android Keystore; sin copias de seguridad automáticas de la app (`allowBackup=false`); `FLAG_SECURE` en pantallas con nombres de menores.
- Bloqueo de pantalla del dispositivo obligatorio; sin capturas de datos en logs ni notificaciones.
- Pérdida del dispositivo: revocación remota de la sesión/dispositivo (contrato 2) y caducidad corta del paquete local; _decisión pendiente_: si la app debe exigir reautenticación periódica y cada cuánto.
- Datos de menores: solo datos sintéticos hasta resolver las decisiones de `modelo-alumnos-matriculas.md`; la excepción MFA-pospuesto no autoriza datos reales.

## 6. Resolución de conflictos (principios, no protocolo)

- El servidor es la autoridad; cada marca viaja con `requestId` estable generado en el dispositivo para que el reintento sea idempotente (semántica ya implementada).
- Conflicto de revisión: la app recarga y **no sobrescribe** lo que otra persona marcó distinto sin avisar a quien captura (misma política que la pantalla web).
- Revocación o día vencido: las marcas pendientes no se aplican; se conservan localmente solo hasta que la persona las vea y se descarten o se resuelvan por el flujo institucional que se defina.
- No inventar aquí el protocolo final: se definirá en un ADR antes de la etapa 3.

## 7. Plan mínimo por etapas

| Etapa | Contenido                                                                                                                                  | Backend requerido        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 0     | Decisiones: autenticación del dispositivo, ventana de captura tardía, apertura offline, firma/distribución del APK; ADR                    | Ninguno                  |
| 1     | Esqueleto Gradle (wrapper, Compose, Room), CI local, pantalla de acceso contra el servidor de desarrollo, datos sintéticos                 | Solo lo existente        |
| 2     | **Cliente en línea**: acceso, mis grupos, abrir lista, marcar y finalizar contra la API actual (equivale a la web, sin cola)               | Contrato 1 (mínimo) y 10 |
| 3     | **Persistencia local y cola**: Room, paquete del día, captura sin red, reenvío con `requestId`, resultados por elemento                    | Contratos 3, 5, 7 y 8    |
| 4     | **Seguridad de dispositivo**: cifrado, Keystore, borrado, revocación remota, reautenticación                                               | Contratos 2 y 9          |
| 5     | Pruebas en emulador y dispositivo (sin red, red intermitente, cambio de medianoche, revocación), distribución por APK, guía de instalación | —                        |

Cada etapa se cierra con pruebas y no habilita datos reales. Las etapas 3 y 4 requieren migraciones, privilegios y revisión de seguridad propias en el backend (mismo flujo: preflight, respaldo, ensayo, verificación).

## 8. Riesgos principales

- Sesión de 60 min de inactividad / 12 h absolutas es incompatible con captura prolongada sin red: la política para dispositivos debe decidirse explícitamente.
- Un token de dispositivo de larga vida amplía el impacto de un robo; sin MFA ni acta institucional no debe usarse con datos reales.
- Sin decisión sobre captura tardía y correcciones, el offline acumulará marcas que el servidor rechaza.
- `cmdline-tools` ausente y ningún dispositivo físico verificado: la reproducibilidad del entorno de compilación aún no está demostrada.
