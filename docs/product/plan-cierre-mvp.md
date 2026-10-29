# Plan de cierre del MVP y guía de demostración interna

Complementa [inventario-funcional-mvp.md](inventario-funcional-mvp.md) (estado verificable, matriz por rol y bloqueos B1–B12). No aprueba ninguna decisión
escolar: **D-01 a D-10 siguen PENDIENTES**, ADR 0005 y 0006 siguen PROPUESTOS.

## 1. Orden sugerido para terminar

1. **Ahora (sin depender de la escuela)** — cerrar lo técnico verificable:
   1. Revisar y fusionar la cadena de Draft PR en orden (#2 … #11 y esta rama) **por una persona**; hoy `main` no contiene el MVP.
   2. Ampliar el E2E (B9, B10): administración de cuentas, catálogo, alumnos y asignaciones por Dirección; activación; dos navegadores; móvil de 375 px.
   3. Pantalla/endpoint de **consulta de auditoría** de solo lectura para administración técnica (B2) — sin decidir retención, solo mostrar lo que ya se registra.
   4. Revisión de seguridad dedicada (privacidad de menores, búsqueda de alumnos de Trabajo Social, límites, cabeceras) y registro de hallazgos.
2. **Con la escuela** — responder el documento de decisiones (B4/B5): primero **D-10** (justificantes, reportes, alertas), **D-01** (captura tardía) y
   **D-04** (finalización); después D-02, D-03, D-05 a D-09. Cada respuesta se registra con fecha y responsable y actualiza ADR/estado.
3. **Seguridad de acceso real** — MFA/TOTP (B1) con ADR propio, recuperación y pruebas adversariales; solo entonces datos reales.
4. **Infraestructura de piloto** (B6) — entorno de pruebas de la escuela: servidor, TLS (cookie `__Host-` + `Secure`), servicio de procesos, respaldos programados
   y **restauración probada**, monitoreo, gestión de secretos, procedimiento de migraciones.
5. **Aplicar a un `eta15_dev` de pre-piloto**, con respaldo verificado, ensayo y autorización explícita: migraciones 0011–0013 y privilegios 0006–0007 (B7).
6. **Android** (B3) — con D-01…D-07 resueltas: transporte aprobado, firma, distribución controlada y MDM; antes de eso el release **no** sincroniza.
7. **Después** (si la escuela lo pide): umbrales y alertas (tras D-10), escaneo de credenciales y retardos (B11), exportaciones (B12).

## 2. Demostración interna en sandbox (datos ficticios)

**Veredicto:** la demostración interna es **posible y está verificada** (clasificación A). No es un piloto ni producción.

### Requisitos de ejecución

- Windows 11 nativo, PowerShell, Node.js 24 y pnpm (usar `. .\tools\env.ps1` en cada sesión), **Chrome instalado** (o `E2E_CHANNEL=msedge`).
- `pnpm install` (incluye `@playwright/test`; no descarga navegadores).
- **No** se necesita Docker, WSL, `eta15_dev` ni servicios externos. Todo corre en un PostgreSQL 18 **desechable** en una carpeta temporal.

### Dos formas de verla

1. **Automática (reproducible, la prueba del MVP):**

   ```powershell
   . .\tools\env.ps1
   pnpm test:e2e          # levanta PostgreSQL temporal + API + portal, abre Chrome, ejecuta 27 escenarios y lo destruye todo
   ```

2. **Manual (para mostrar el portal):** el sandbox existente, con cuentas ficticias de contraseña aleatoria que se muestra solo en la terminal:

   ```powershell
   . .\tools\env.ps1
   pnpm dev:sandbox -- --catalog-write --students-write --prefect-write --attendance-write --seed-attendance --justifications-write
   pnpm dev:web           # en otra terminal; abrir http://127.0.0.1:5173 (no localhost)
   ```

   Cuentas ficticias: dirección, prefectura 1 y 2, técnica y trabajo social (esta con `--justifications-write`). Ctrl+C destruye el entorno.

### Datos y cuentas ficticias de la prueba automática

Ciclo «Ciclo E2E ficticio»; grupos 1.º A (Ana Alfa, Beto Beta, Carla Gamma, Diego Delta, Elena Épsilon) y 1.º B (Fabi Foxtrot, Gael Golf), todos **ficticios**; cinco
días hábiles previos con listas (A: 3 finalizadas, 1 borrador con un alumno sin marcar y 1 día sin lista; B: 1 finalizada). Cuentas
`*.e2e@escuela.test` (dirección, técnica, prefectura A y B, trabajo social e inactiva) con una contraseña aleatoria por ejecución que no se guarda.

### Guion de la demostración (≈15 min)

1. **Dirección**: iniciar sesión → _Asistencia_ (listas recientes) → _Reportes de asistencia_ → por grupo (elegir ciclo, grupo y fechas; observar presentes, ausentes,
   **sin marca** y el día **sin lista = «no determinado»**) → por alumno → _Seguimiento de ausencias_ (ordenar, abrir el detalle, volver conservando filtros; leer la
   aclaración «solo ausencias registradas»).
2. **Prefectura**: iniciar sesión → solo su grupo; abrir la lista de hoy (entre semana), marcar, guardar borrador y finalizar; intentar un grupo ajeno por URL → no se muestra nada.
3. **Trabajo Social**: _Justificantes_ → buscar alumno → fecha → **Registrar recepción** → folio → historial y filtros; mostrar que **no** puede ver asistencia ni seguimiento y que la
   recepción **no cambia** ninguna falta.
4. **Cerrar** sesión y mostrar que la sesión anterior ya no sirve.

### Limitaciones conocidas que hay que decir en voz alta

- Es un **sandbox con datos ficticios**; MFA está diferido (solo loopback); no hay despliegue, TLS ni respaldos.
- Justificantes: **solo recepción** (no aprueba, no justifica, no cambia faltas; D-10 pendiente). No hay alertas, umbrales, exportaciones ni escaneo de credenciales/retardos.
- La captura por el portal es para pruebas; la captura prevista es Android, cuyo **transporte existe solo en debug/sandbox**: el release **no** puede sincronizar y **no se distribuye ningún APK**.
- La captura tardía, los conflictos, la corrección y la finalización definitiva dependen de decisiones de la escuela.

### Prohibiciones (producción)

No usar alumnos ni cuentas reales; no publicar el portal ni la API; no habilitar `NODE_ENV=production` con estos interruptores; no aplicar migraciones ni privilegios a `eta15_dev`
sin autorización; no distribuir APK; no tratar el resultado de la demo como aprobación institucional.

## 3. Riesgos del despliegue (resumen)

Sin entorno ni respaldos probados; MFA ausente; decisiones de retención y responsabilidad sin tomar; una sola persona/equipo; dependencia de un transporte Android aún propuesto (ADR 0006);
exposición de nombres a Trabajo Social por la búsqueda mínima (sin ratificar); y la cadena de PR sin fusionar (el trabajo no está en `main`). Ver bloqueos B1–B12.
