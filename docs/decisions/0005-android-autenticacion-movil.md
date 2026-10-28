# ADR 0005 — Autenticación y sesiones de la app Android de prefectura

- Estado: **propuesta (NO aceptada)**; el endurecimiento anti-replay (estado compartido en PostgreSQL) está implementado y probado solo en entornos desechables, sin aplicar a `eta15_dev`. Revisada el 2026-10-27 con una comparación de dos opciones y una recomendación técnica; la aceptación requiere decisiones de la institución (ver al final). Desde la etapa 2B existe un **prototipo aislado** de la Opción A (solo sandbox, rama `feat/android-mobile-auth`, sin confirmar, migración 0011 y privilegios 0006 **sin aplicar** a `eta15_dev`): sirve para validar el diseño, **no equivale a aprobarlo** ni habilita datos reales (ver «Prototipo aislado de la Opción A»).
- Fecha: 2026-10-27
- Relacionados: [ADR 0004](0004-auth-sesiones-servidor-argon2id.md), [auth-rbac.md](../architecture/auth-rbac.md), [propuesta-android-asistencia.md](../architecture/propuesta-android-asistencia.md), [android-prefectura.md](../architecture/android-prefectura.md).

## Contexto

La API actual autentica **navegadores**: cookie de sesión `HttpOnly` + `SameSite=Strict` (`__Host-` y `Secure` en producción), token CSRF por cabecera en toda mutación autenticada y validación de `Origin`. La sesión caduca a los 60 min de inactividad o 12 h absolutas para el personal general (menos para Dirección y `admin_tecnico`), con un máximo de 5 sesiones simultáneas por usuario. MFA/TOTP está **pospuesto** y solo se tolera en desarrollo local con datos sintéticos.

Una app nativa no es un navegador: no tiene `Origin` confiable, el modelo de cookie con CSRF no encaja, y su uso offline choca con una sesión de 60 min. Además, el dispositivo guardará nombres de menores, de modo que su pérdida o robo es un riesgo propio.

En la etapa 1 la app **no se conecta a la escuela**: solo opera con datos ficticios en modo demostración (debug). Este ADR define la dirección para la etapa siguiente.

## Opciones comparadas (revisión del 2026-10-27)

**A. Dispositivo registrado a nombre de la persona + credenciales protegidas por Keystore + sesiones móviles propias.** El servidor actual sigue siendo el único proveedor de identidad. El dispositivo prueba su identidad con una clave que no sale del Keystore (firma de un reto) además de las credenciales de la persona; la sesión móvil es corta, opaca y se guarda solo como hash en el servidor.

**B. Autorización externa estándar (OAuth 2.0 / OIDC con Authorization Code + PKCE, navegador del sistema).** Un servidor de autorización emite los tokens; la app no maneja la contraseña. Estándar maduro y con buenas bibliotecas.

| Criterio                        | A: dispositivo registrado                                                                                                             | B: OIDC + PKCE                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relación con el Auth actual     | Extiende lo existente (cuentas, roles, asignaciones, auditoría, argon2id) con una tabla de dispositivos y sesiones móviles            | El Auth actual **no es** un servidor OAuth/OIDC: habría que construir uno (grande y delicado) o adoptar uno externo y migrar la identidad                                               |
| Dependencias externas           | Ninguna nueva                                                                                                                         | Un IdP (propio o de terceros): hospedaje, mantenimiento, cuentas escolares dentro de él, disponibilidad                                                                                 |
| Complejidad de implementación   | Media: enrolamiento, reto firmado, renovación, revocación                                                                             | Media-alta si se construye el servidor; media si se adopta uno, pero con migración y doble administración de usuarios                                                                   |
| Seguridad                       | Clave ligada al dispositivo (no exportable) + titular + revocación por dispositivo; superficie nueva que revisar                      | Flujo auditado por la industria; sin contraseña en la app; **no ata por sí mismo al dispositivo**: un token robado funciona en otro equipo salvo que se agregue vinculación (DPoP/mTLS) |
| MFA                             | Hoy pospuesto; el dispositivo registrado + bloqueo de pantalla es un factor de posesión, no TOTP                                      | El IdP puede imponer MFA, pero la institución aún no definió política; el aplazamiento actual se arrastra igual                                                                         |
| Captura prolongada sin red      | Se controla con el paquete del día y la caducidad definidos por la escuela; la clave local permite reanudar sin red dentro del límite | El token de acceso caduca pronto; sin red no se renueva: igual hay que definir caducidad offline y qué pasa al vencer                                                                   |
| Pérdida o robo                  | Revocación del dispositivo en el servidor; la clave del Keystore no sale del equipo                                                   | Revocar el token/sesión en el IdP; el token robado puede usarse desde otro equipo hasta revocarlo                                                                                       |
| Recuperación                    | Reenrolar con la autoridad (código de un solo uso en persona)                                                                         | Recuperación de cuenta del IdP                                                                                                                                                          |
| Identidad de la prefecta        | Cuenta escolar existente + asignaciones actuales                                                                                      | Cuenta del IdP, que habría que mapear a las cuentas y asignaciones de ETA 15                                                                                                            |
| Coste operativo para la escuela | Bajo: sin servicios nuevos; la autoridad administra dispositivos                                                                      | Mayor: operar o contratar un IdP, y capacitar                                                                                                                                           |
| Autorización institucional      | Quién autoriza el enrolamiento y cómo se verifica a la persona                                                                        | Además: elegir y aprobar un proveedor de identidad                                                                                                                                      |

### Recomendación técnica

**Opción A**, por etapas y sin implementar ambas: reutiliza el modelo de cuentas, roles y asignaciones ya probado, no agrega dependencias ni un servidor de identidad, y da revocación por dispositivo. B solo se justifica si la institución decide adoptar un IdP común para varios sistemas; en ese caso el diseño de dispositivos de A sigue siendo útil como segundo factor de posesión. Ninguna opción habilita datos reales por sí sola: faltan MFA, bootstrap escolar y decisiones de privacidad.

### Decisiones que requieren autorización institucional

1. ¿La escuela aprueba la Opción A (o prefiere adoptar un IdP común, Opción B)?
2. ¿Quién autoriza el enrolamiento de un dispositivo y cómo se verifica a la persona titular?
3. ¿Qué duración máxima de sesión móvil, de paquete offline y de días sin conexión se acepta?
4. ¿Qué ocurre con marcas capturadas offline que llegan tarde, tras medianoche o tras una revocación?
5. ¿Qué dispositivos se usarán (propios de la escuela o personales) y cuál es el procedimiento de pérdida/robo?
6. ¿Cómo se distribuyen, firman y actualizan los APK?
7. ¿Cuándo se exige MFA y qué política de datos de menores aplica antes de cargar datos reales?

## Estado del almacenamiento local (etapa 2A)

La protección en reposo ya existe en la app de demostración (Room + SQLCipher con clave en Android Keystore; ver [android-prefectura.md](../architecture/android-prefectura.md)). Eso **reduce** el riesgo de la pérdida del dispositivo pero **no sustituye** a esta decisión: sigue sin haber autenticación, autorización, revocación ni sincronización.

## Prototipo aislado de la Opción A (etapa 2B, 2026-10-27)

Implementado y probado **solo** en entornos desechables (PGlite, clústeres PostgreSQL temporales, `pnpm dev:sandbox -- … --mobile-auth` y el emulador). Nada se aplicó a `eta15_dev`; el prototipo **sigue siendo una propuesta** y no se declara listo para producción.

### Modelo de amenaza considerado

| Amenaza                                                           | Respuesta del prototipo                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credencial de acceso robada (log, copia, intercepción)            | DPoP (RFC 9449): cada petición lleva una prueba firmada con la clave del dispositivo ligada al credencial (`ath`), a método y URL (`htm`/`htu`), con `jti` de un solo uso. Sin la clave privada no sirve.                         |
| Repetición de una prueba                                          | `jti` único por clave registrado en **PostgreSQL** (UNIQUE atómico, compartido entre instancias y vigente tras un reinicio), ventana de `iat` corta y nonce de un solo uso por operación. Ver «Anti-replay, nonces y saturación». |
| Enrolar una clave ajena o suplantar a otra persona                | La solicitud la crea el dispositivo (solo clave pública), la **reclama la persona titular con su sesión web** y la **aprueba otra persona con autoridad tecleando la huella** que ve en el dispositivo.                           |
| Auto-aprobación                                                   | Prohibida en base de datos (`mdr_not_self_approved`) y en la API; el permiso de aprobar no lo tiene prefectura.                                                                                                                   |
| Cookie web usada como credencial móvil, o credencial móvil en web | Guardas separados: las rutas `/mobile/*` ignoran cookies y rechazan `Origin`; las rutas web ignoran `Authorization: DPoP`. CSRF y `Origin` globales **no se tocaron**.                                                            |
| Dispositivo perdido o robado                                      | Revocación inmediata por la titular o por Dirección (sesiones revocadas en la misma transacción); la clave revocada no se vuelve a registrar nunca (`md_thumbprint_key`).                                                         |
| Renovación robada                                                 | Rotación en cada uso, detección de reuso (revoca toda la sesión) y prueba de posesión en cada renovación.                                                                                                                         |
| Cuenta que pierde el rol, se desactiva o gana un rol con MFA      | Revalidación en **cada** petición (cuenta activa, rol vigente concedido antes de registrar el dispositivo, sin ningún rol que exija MFA).                                                                                         |
| Fuerza bruta de códigos                                           | 5 intentos fallidos cancelan la solicitud; límites por IP, por cuenta y por clave; códigos de 8 símbolos que solo viven minutos.                                                                                                  |

### Identidad de la persona titular y autorización de Dirección

La app **no** pide contraseña. La persona titular se identifica en el **portal web** (cuenta, contraseña existente, CSRF) y reclama la solicitud con la clave de solicitud y el código que muestra el dispositivo; con eso el servidor liga solicitud ↔ cuenta. La autoridad (`mobile_devices:manage`, solo Dirección) aprueba escribiendo la **huella** del dispositivo (`XXXX-XXXX-XXXX`, 48 bits para comparar a simple vista; la prueba criptográfica es la firma). El campo nunca viene relleno. Una persona tiene como máximo 3 dispositivos activos y una vinculación en curso.

### Registro, posesión y credenciales

1. `POST /mobile/enroll/requests` (anónimo, solo JWK público EC P-256) → clave de solicitud, código y huella.
2. Reclamo web → aprobación web → `POST …/activate` con prueba DPoP + nonce (posesión de la clave aprobada).
3. `POST /mobile/auth/token` (prueba + nonce) abre una sesión móvil: acceso de **10 minutos**, renovación por inactividad de **30 minutos**, duración absoluta de **8 horas**, solicitud de vinculación vigente **10 minutos** y ventana de `iat` de 60 s, una sesión activa por dispositivo. Credenciales opacas de 256 bits; en PostgreSQL solo se guardan **hashes SHA-256**; nunca claves privadas, contraseñas ni tokens en claro.
4. Permisos de la sesión móvil acotados a `prefect_assignments:read` y `students:read_basic` (alcance `assigned_groups`/`own`). Lecturas: `GET /mobile/school/me/groups` y `GET /mobile/school/groups/:id/roster`, que **reutilizan los servicios web** (misma proyección mínima y alcance por asignación).

Las duraciones son valores de prueba, **no** una decisión institucional.

### Claves y protección en el dispositivo

Par EC P-256 en **Android Keystore** (`PURPOSE_SIGN`, SHA-256, no exportable; se intenta StrongBox y se informa el nivel real: en el emulador resultó «software»). La clave solo se crea al pulsar «Vincular», **nunca se regenera en silencio**: si falta, la app lo explica y pide olvidar y vincular de nuevo. En disco solo quedan identificadores y la etiqueta (`noBackupFilesDir`); la sesión vive en memoria y las lecturas escolares no se guardan. **Exigir desbloqueo o biometría para firmar** (`setUserAuthenticationRequired`) y la **atestación de claves** quedan **pendientes de decisión**: no se activaron porque el emulador no tiene credencial y darían un falso sentido de seguridad.

### Compatibilidad con MFA y restricciones de la demostración

El canal móvil no tiene segundo factor: las cuentas con **cualquier** rol que exija MFA (`direccion`, `admin_tecnico`) **no son elegibles** y la política de MFA de producción no se modificó. La vinculación móvil existe solo en **debug**: el APK de release no declara `INTERNET`, no contiene cliente de red, claves de dispositivo ni código DPoP (comprobado en el manifiesto y el dex). La red de debug solo permite HTTP a `10.0.2.2`. La interfaz rotula **ENTORNO DE PRUEBAS** y es independiente de la demostración local. No hay sincronización, cola de envío ni escritura de asistencia.

### Anti-replay, nonces y saturación (endurecimiento previo a la revisión de seguridad)

Revisión del prototipo antes de integrarlo: la caché de `jti` y los nonces estaban en memoria de un proceso (un reinicio reabría la ventana de repetición y varias instancias no se protegían entre sí) y cualquier clave generada por una persona anónima podía dejar estado, de modo que unos cientos de miles de pruebas firmadas con claves propias saturaban la protección de las personas legítimas. Corregido en la migración 0011 (aún **sin aplicar**) y en el servicio, **sin cambiar** CSRF, Origin ni MFA globales.

**Qué prueba cada campo (RFC 9449):** `jti` identifica UNA prueba (única por clave); `iat` acota su antigüedad (±60 s); `jkt` es la huella RFC 7638 de la clave que firmó y la liga a una solicitud o dispositivo registrado; `ath` liga la prueba al token de acceso; `htm`/`htu` al método y a la URL canónica (`publicBaseUrl`, nunca cabeceras); `nonce` es un valor del servidor. La prevención de repetición es la restricción UNIQUE (jkt, `jti`) y **no depende del nonce**: una prueba repetida se rechaza aunque lleve un nonce válido.

**Estado compartido en PostgreSQL** (sin Redis ni infraestructura nueva), solo hashes: `mobile_proof_jtis` (clave + SHA-256 del `jti`, PRIMARY KEY; solo-agregar, sin UPDATE) y `mobile_nonces` (SHA-256 del nonce, un solo uso con `consumed_at`, vigencia de minutos). Nunca se guardan el JWT, el `jti` ni el nonce en claro, ni claves. La inserción es atómica: dos instancias que reciben la misma prueba compiten por la misma fila y solo una gana. **Falla cerrado:** si PostgreSQL no responde durante la admisión, la petición se rechaza con 503 (`MOBILE_AUTH_UNAVAILABLE`, sin detalles) y nada se acepta sin comprobar la repetición; no hay caché en memoria como mecanismo de seguridad.

**Modelo de nonce y diferencia con el RFC:** el RFC 9449 §8 no exige que un nonce sea de un solo uso (el servidor lo entrega en una respuesta 401 con `DPoP-Nonce`). Este diseño usa un **desafío propio de un solo uso por operación de negocio** (activar, abrir sesión, renovar), pedido a `POST /mobile/auth/challenge`; el consumo es un `UPDATE … WHERE consumed_at IS NULL AND expires_at > now` atómico (sin DELETE) y el nonce solo sirve para la clave a la que se emitió. Para que quien no posee la clave no pueda agotar los nonces de otra, **el desafío exige una prueba DPoP firmada por la propia clave** (sin nonce) y solo se emite a una clave ya ligada a una solicitud abierta o a un dispositivo; la huella del cuerpo debe ser la de la clave firmante. Es un contrato nuevo para el cliente (la app Android firma ahora el desafío) y es una desviación consciente y documentada del RFC; `GET /mobile/enroll/requests/:id` no usa nonce, solo `jti`.

**Saturación por clientes anónimos.** Orden de validación, del más barato al más caro y sin dejar estado antes de conocer la clave: (1) forma, firma y reclamos (CPU; prueba ≤ 2 048 caracteres, `jti` de 16 a 128); (2) la clave debe estar **ligada a algo existente** — la solicitud `:id` con esa clave (consulta y activación), un dispositivo (token y renovación) o cualquiera de las dos (desafío) —; una clave arbitraria se rechaza aquí **sin escribir nada** (la solicitud ajena responde igual que una inexistente: 404 uniforme, sin identificadores ni nombres de otras personas); (3) cupo por clave y rechazo atómico de la repetición; (4) nonce. En las rutas con token de acceso la prueba solo se registra cuando el token y la clave coinciden con una sesión vigente de ese dispositivo. Cupos de ensayo: 300 pruebas vigentes por clave (ventana ≈125 s), 5 nonces sin gastar por clave, 10 solicitudes pendientes por IP y 200 globales, y los límites existentes por IP y por clave; los excesos responden 429 con `Retry-After` y **se recuperan** al vencer su ventana (no hay bloqueos permanentes).

**Limpieza (la API no borra).** `eta15_api` no tiene DELETE ni TRUNCATE sobre estas tablas. Las filas vencidas las retira el **propietario** (`eta15_app`) con un trigger que solo admite borrar filas vencidas hace más de una hora (la limpieza nunca alcanza estado que aún protege): `DELETE FROM mobile_proof_jtis WHERE expires_at < now() - interval '1 hour';` y lo mismo para `mobile_nonces`. **Aún no hay una tarea programada que lo ejecute** (pendiente de decisión operativa); sin ella la tabla crece solo con el uso real (un máximo acotado por clave y ventana) y no afecta la seguridad.

### Limitaciones conocidas del prototipo

- Los límites por IP y por clave de **fallos** (`AttemptLimiter`) siguen en memoria de cada instancia; el cupo de pruebas y nonces por clave, y la protección contra repetición, sí son compartidos. Con varias instancias, los contadores por IP son por instancia.
- Quien posee una clave registrada puede agotar **su propio** cupo de pruebas (solo se afecta a sí misma); 200 solicitudes pendientes globales podrían llenarse desde muchas IP distintas (mitigado por el tope por IP y la caducidad de 10 minutos).
- Un reintento legítimo tras perder la respuesta de una renovación se interpreta como reuso y cierra la sesión (seguro, pero molesto): se vuelve a abrir sesión con la clave del dispositivo.
- La IP de origen se guarda en las solicitudes y sesiones (dato personal): definir retención antes de datos reales.
- `htu` se arma con la URL pública configurada (no con cabeceras); en producción exige HTTPS y un valor fijo por despliegue.
- Reloj del dispositivo: la ventana de `iat` tolera un desfase pequeño; un reloj muy desviado impide iniciar sesión (falla cerrado).
- La huella corta (48 bits) es para comparación humana; no sustituye atestación del hardware.
- El cliente de debug usa `HttpURLConnection`; descubierto en la prueba real: sin cuerpo declara `application/x-www-form-urlencoded` y el servidor responde 415, por lo que todo POST envía JSON (aunque sea `{}`).

### Pruebas (todas con cuentas, dispositivos y datos ficticios)

PGlite: 46 HTTP + 28 de migración + las de DPoP (la suite de la API completa: 907 pruebas, y 162 del portal); clúster PostgreSQL 18 desechable con `eta15_api` no propietaria y privilegios por columna (suite móvil completa con 0006, 21 de ejecución controlada de la propuesta 0006 y carreras con conexiones independientes: misma prueba en dos instancias a la vez, reinicio de instancia, revocación contra renovación, aprobación contra cancelación, falla real de PostgreSQL por retiro de privilegio, agotamiento y recuperación de cupos; 519 pruebas en el clúster desechable en total) y paridad exacta de las rutas web compartidas con y sin el canal móvil (9 rutas × 6 perfiles), CSRF/Origin y revocación web; guion adversarial vivo contra el sandbox (31/31); Android: 64 pruebas JVM de debug (10 de DPoP con vectores calculados por el servidor, 13 de la máquina de estados, 17 de política de seguridad), 41 de release, 75 instrumentadas (7 del Keystore real, 5 de interfaz) y una prueba de extremo a extremo en el emulador (Keystore real + HTTP real a `10.0.2.2` + guion web): vincular, aprobar, abrir sesión, leer grupos y padrón, revocar y olvidar.

## Lo que NO se hará (restricciones)

- No desactivar CSRF ni la validación de `Origin` de la API web, ni falsificar `Origin` desde la app.
- No reutilizar cookies del navegador ni compartir sesiones web con la app.
- No poner tokens en URL, ni contraseñas en Room/SharedPreferences, ni credenciales incrustadas en el APK.
- No crear un inicio de sesión público ni endpoints protegidos sin un modelo de autorización aprobado y pruebas adversariales.
- No cargar datos escolares reales mientras no exista protección en reposo en el dispositivo y decisión institucional.

## Decisión propuesta

### 1. Registro de dispositivos (enrolamiento)

- Un dispositivo se **registra a nombre de una persona** concreta (titular) con rol `prefectura`; lo autoriza Dirección (o la autoridad que defina la institución) y queda auditado.
- Flujo: la autoridad genera un **código de enrolamiento de un solo uso** y corta vida (minutos), entregado en persona. La app genera en **Android Keystore** un par de claves no exportable (StrongBox si existe) y registra solo la clave pública junto con el código.
- El servidor guarda dispositivo, titular, clave pública, fecha, estado y revocación (historial inmutable, sin borrado físico), igual que las demás tablas del proyecto.

### 2. Credenciales y sesión móvil

- La identidad la prueba el **titular** (correo y contraseña ya existentes) más la **posesión del dispositivo** (firma con la clave del Keystore sobre un reto del servidor). Sin contraseña guardada en el dispositivo.
- Resultado: una **sesión móvil de corta duración** (orden de 15–30 min), token opaco guardado en el servidor solo como hash (como las sesiones web), enviado por `Authorization` y **solo por HTTPS** (en release HTTPS es obligatorio). Sin cookies, por lo que CSRF no aplica; en su lugar el servidor exige token + dispositivo activo + titular activo.
- **Renovación controlada**: se renueva con un nuevo reto firmado (no con un token de refresco estático), con límite absoluto y verificación en cada renovación de que el titular, el rol, la asignación y el dispositivo siguen vigentes.
- El token se guarda cifrado con una llave del Keystore (nunca en `SharedPreferences` en claro).

### 3. Separación web / móvil

- Tabla y tipo de sesión distintos de los de web; una sesión móvil **solo** accede a un prefijo de rutas móviles y a permisos acotados (consultar sus grupos asignados y capturar asistencia de hoy). No puede administrar usuarios, roles, catálogo ni asignaciones.
- La revocación de sesiones web no cambia la móvil, y viceversa; revocar a la persona (cuenta, rol o asignación) invalida ambas.

### 4. Caducidad offline y reautenticación

- Paquete de datos del día con **caducidad explícita** (p. ej. fin del día escolar en `America/Mazatlan` o un máximo de horas); al vencer o al cerrar sesión, la app **borra** padrón y borradores no enviados según la política que se decida (ver decisiones pendientes).
- Reautenticación obligatoria tras un máximo de días sin conexión y tras cualquier error 401/403 de revocación.
- La fecha del dispositivo **no** decide nada: la fecha y los días hábiles los define el servidor.

### 5. Revocación, pérdida o robo

- Dirección/administración revocan el dispositivo y el servidor lo rechaza desde ese momento; la app, al reconectar, borra sus datos locales. **Sin conexión no hay garantía de borrado remoto**: por eso la protección en reposo y la caducidad del paquete son obligatorias.
- Bloqueo de pantalla del dispositivo requerido; llaves del Keystore con autenticación de usuario (PIN/huella) al abrir.
- Procedimiento institucional de aviso inmediato de pérdida (pendiente de definir).

### 6. Datos en reposo

- Room no cifra por sí solo. Antes de datos reales: base cifrada (p. ej. SQLCipher u otra solución revisada) con llave envuelta en Keystore; nada de criptografía casera. Copias de seguridad y transferencia entre dispositivos ya están excluidas.

### 7. MFA diferido (limitación)

- La exigencia de MFA para `direccion` y `admin_tecnico` sigue pospuesta y no se extiende a esta app. Para prefectura, la posesión del dispositivo registrado más el bloqueo del dispositivo funciona como factor de posesión/conocimiento, **pero no equivale a TOTP** ni sustituye la decisión institucional. Usar datos reales exige resolver MFA, el bootstrap escolar y la política de datos de menores.

## Cambios de backend que implicaría (fuera de esta etapa)

Migración (dispositivos, sesiones móviles, auditoría), propuesta de privilegios mínimos por columna, endpoints de enrolamiento/reto/renovación/revocación, endpoints móviles de lectura (grupos, paquete del día) y de envío por lotes con `requestId`, y pruebas adversariales (autoasignación, cruce de titulares, dispositivo revocado, reuso de reto, replay, token filtrado). Cada paso sigue el flujo de migraciones y privilegios del proyecto.

## Decisiones pendientes (institucionales y técnicas)

1. ¿Quién autoriza el enrolamiento y cómo se verifica a la persona titular?
2. Duración de sesión móvil, del paquete offline y de días sin conexión permitidos.
3. Qué pasa con marcas capturadas offline que llegan tarde, tras medianoche o tras una revocación.
4. Cifrado en reposo: biblioteca, manejo de llaves y rotación.
5. Política de pérdida/robo y de devolución de dispositivos.
6. Distribución del APK, firma y actualización forzada.
7. MFA para datos reales.

## Consecuencias

- La etapa 1 queda **honesta**: no hay login, ni tokens, ni sincronización; la UI lo declara.
- El diseño evita debilitar la API web para acomodar al cliente móvil.
- Costo: una superficie de autenticación nueva que requiere revisión de seguridad y pruebas propias antes de tocar datos reales.
