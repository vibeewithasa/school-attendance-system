# ADR 0006 — Protocolo de sincronización de asistencia (Android offline → servidor)

**Estado: PROPUESTO (2026-10-28). No aceptado.** Nada de lo que aquí se describe está aprobado por la institución ni por una revisión de seguridad. Depende del [ADR 0005](0005-android-autenticacion-movil.md), que también sigue **propuesto**. Este ADR **no aprueba ninguna política escolar**.

Documento detallado (contratos, outbox, matriz de conflictos, pruebas, plan por fases): [protocolo-sincronizacion-asistencia.md](../architecture/protocolo-sincronizacion-asistencia.md). Este ADR solo registra las decisiones y sus consecuencias; no lo duplica.

## Motivación

La app de prefectura ya captura asistencia sin internet en una base cifrada, pero esas marcas son **borradores locales**. Para que lleguen a la lista oficial sin duplicar eventos, sin sobrescribir en silencio y sin perder borradores hace falta un protocolo explícito entre el cliente y el servicio de asistencia ya existente (`/school/attendance`, una lista por grupo y fecha, `revision`, `requestId`, historial solo-agregar).

## Alternativas técnicas consideradas

| Alternativa                                                                | Decisión propuesta | Motivo                                                                                                     |
| -------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Reutilizar el servicio de asistencia del portal también por el canal móvil | **Sí**             | Una sola implementación de alcance, fecha y revisión; sin endpoints duplicados.                            |
| Endpoint de sincronización por lotes que decida conflictos                 | No                 | Fija una semántica de conflicto que la escuela no ha decidido; un guardado por grupo cabe en una petición. |
| Resolver conflictos por _last-write-wins_ o por reloj del dispositivo      | **No**             | Sobrescribiría marcas de otra persona y confiaría en un reloj no confiable.                                |
| `Idempotency-Key` HTTP en lugar de `requestId`                             | No (por ahora)     | Es un borrador del IETF (la última versión encontrada es la 07, vencida; sin RFC) y `requestId` ya existe. |
| Un `requestId` por borrador                                                | No                 | El servidor liga el `requestId` a un contenido; un borrador cambia.                                        |
| Un `requestId` **por operación inmutable**                                 | **Sí**             | Reintento seguro; reutilizarlo con otro contenido se rechaza (`IDEMPOTENCY_MISMATCH`).                     |

## Decisiones propuestas

1. **`requestId` por operación.** Cada envío es una operación inmutable con su `opId` = `requestId`. Si el contenido cambia, se crea una operación nueva (la anterior queda `SUPERSEDED`); `expectedRevision` es un parámetro de transporte, no parte del contenido.
2. **`requestId` ≠ `jti` de DPoP.** El `jti` es una prueba criptográfica de **una sola petición** (anti-repetición compartida en PostgreSQL); el `requestId` es la idempotencia **de negocio**. Una petición que llegó pero cuya respuesta se perdió se reenvía con el **mismo** `requestId` y un `jti` **nuevo**.
3. **El servidor es la autoridad de la fecha escolar** (`America/Mazatlan`). El reloj del teléfono es informativo; una captura de un día que ya no es «hoy» no se «mueve» a hoy: queda conservada y señalada.
4. **Revisión optimista.** La escritura futura envía `expectedRevision`; un conflicto de revisión no escribe nada y se resuelve mostrando las diferencias, nunca con «gana el último».
5. **Sin sobrescritura automática.** Solo se reenvía sin intervención cuando el servidor no tiene marcas distintas; cualquier diferencia la decide la persona. Una lista finalizada no se modifica.
6. **Conservación de borradores.** Ningún fallo de envío borra, mueve ni modifica un borrador; no hay borrado remoto.
7. **Revalidación de autorizaciones en cada petición** (sesión, dispositivo, cuenta, rol, asignación vigente, grupo y ciclo). La autorización con la que se descargó el padrón no se reutiliza.
8. **Separación lectura y escritura.** Primero **lecturas** móviles (consultar el estado de las listas), después escrituras. Cada fase se publica detrás de un interruptor explícito, apagado por omisión y solo en sandbox. El token móvil no tiene `attendance:capture`.
9. **Finalizar es una operación aparte y humana**, nunca encadenada al envío.

## Estado de implementación (fase 1)

**Implementado en el sandbox (rama `feat/mobile-attendance-read`)**: solo `GET /mobile/school/attendance/{today,days,days/:id}`, detrás de `mobile.attendanceRead` (apagado por omisión; `pnpm dev:sandbox -- … --mobile-auth --mobile-attendance-read`), con el mismo servicio del portal, una **foto consistente** (REPEATABLE READ) por respuesta y una proyección mínima sin nombres. **No implementado**: ningún `POST`/`PATCH`/`PUT`/`DELETE` de asistencia móvil, sincronización, outbox, WorkManager, finalización móvil ni correcciones históricas.

## Restricciones institucionales (no se deciden aquí)

Vigencia offline real; capturas que llegan al día siguiente; qué ocurre con lo capturado por quien perdió el grupo; resolución de conflictos de contenido; conservación local tras confirmar; correcciones de listas finalizadas; pérdida y robo de dispositivos; retención de IP; MFA para datos reales. Las alternativas están en el documento detallado (§16) y **ninguna se escoge como oficial**.

## Riesgos y consecuencias

- **Superficie nueva en el canal móvil**: el token pasa a incluir `attendance:read` (solo `assigned_groups`) cuando el interruptor está encendido. Requiere revisión de seguridad antes de cualquier uso fuera del sandbox; el canal móvil sigue prohibido con `NODE_ENV=production`.
- **Lecturas con efecto lateral mínimo**: cada consulta de una lista registra `attendance.day_viewed` en la auditoría (con canal, dispositivo e IP gruesa); un teléfono que sondea mucho genera volumen de auditoría.
- **Condición de carrera en el portal web** (descubierta al probar las lecturas móviles): `GET /school/attendance/{today,days,days/:id}` arma cada respuesta con varias consultas en READ COMMITTED y puede mezclar conteos y renglones de revisiones distintas si un guardado se confirma entre ellas. Las lecturas móviles ya usan una foto consistente; el portal **requiere un arreglo separado**.
- **El servidor no tiene versión de padrón**: se propone una huella calculada (`rosterDigest` v1, solo ids); no sustituye a una versión real.
- **Brechas conocidas del servicio actual** (caracterizadas con pruebas, sin cambiarlas): un guardado sin cambios no registra su `requestId`; una marca guardada no puede quitarse; `finalize` no distingue quién finalizó; un borrador de ayer no tiene vía ordinaria de cierre. Ver el documento detallado.
- **Si se rechaza o cambia el ADR 0005**, este protocolo debe revisarse: su autenticación depende de él.
