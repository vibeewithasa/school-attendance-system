# ADR 0005 — Autenticación y sesiones de la app Android de prefectura

- Estado: **propuesta (NO aceptada, NO implementada)**. Documenta el diseño que debe revisarse y aprobarse antes de escribir código de autenticación móvil o endpoints nuevos.
- Fecha: 2026-10-27
- Relacionados: [ADR 0004](0004-auth-sesiones-servidor-argon2id.md), [auth-rbac.md](../architecture/auth-rbac.md), [propuesta-android-asistencia.md](../architecture/propuesta-android-asistencia.md), [android-prefectura.md](../architecture/android-prefectura.md).

## Contexto

La API actual autentica **navegadores**: cookie de sesión `HttpOnly` + `SameSite=Strict` (`__Host-` y `Secure` en producción), token CSRF por cabecera en toda mutación autenticada y validación de `Origin`. La sesión caduca a los 60 min de inactividad o 12 h absolutas para el personal general (menos para Dirección y `admin_tecnico`), con un máximo de 5 sesiones simultáneas por usuario. MFA/TOTP está **pospuesto** y solo se tolera en desarrollo local con datos sintéticos.

Una app nativa no es un navegador: no tiene `Origin` confiable, el modelo de cookie con CSRF no encaja, y su uso offline choca con una sesión de 60 min. Además, el dispositivo guardará nombres de menores, de modo que su pérdida o robo es un riesgo propio.

En la etapa 1 la app **no se conecta a la escuela**: solo opera con datos ficticios en modo demostración (debug). Este ADR define la dirección para la etapa siguiente.

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
