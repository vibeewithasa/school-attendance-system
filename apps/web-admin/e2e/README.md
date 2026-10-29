# E2E web real (Playwright + Chrome + API + PostgreSQL desechable)

```powershell
. .\tools\env.ps1
pnpm test:e2e            # desde la raíz; también: pnpm --filter @eta15/web-admin test:e2e
```

- Levanta (en `playwright.config.ts`) la pila `apps/api/scripts/e2e-stack.ts` (PostgreSQL 18 temporal con todas las migraciones y las propuestas de
  privilegios 0002–0005 y 0007 **solo en ese clúster**; **no** se aplica la 0006 de autenticación móvil, que no interviene en el portal web), API real en
  `127.0.0.1:3000`, datos ficticios deterministas) y el portal Vite (`127.0.0.1:5173`). Los puertos 3000 y 5173 deben estar libres.
- Usa el Chrome instalado (`channel: 'chrome'`; `E2E_CHANNEL=msedge` para Edge). No descarga navegadores.
- **No toca `eta15_dev`**, no usa mocks ni intercepta respuestas (salvo una avería de red inyectada y declarada en `05-estados-y-seguridad`).
- La contraseña de las cuentas ficticias se genera al azar en cada ejecución (variable de entorno del proceso; no se guarda ni se imprime). El archivo de
  estado (sin secretos) se escribe en la carpeta temporal del sistema. Sin trazas ni video.
- Los escenarios se ejecutan en orden (`01`…`13`, un solo trabajador) porque comparten la base desechable y cada archivo deja el estado que usa el siguiente.
  Cada archivo es **autosuficiente respecto de la siembra**; los que dependen de otro lo declaran en su comentario inicial.
- `support.ts` consulta la base **desechable** solo para verificar lo que hizo el navegador.

| Archivo                   | Qué prueba                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `01`–`06`                 | Dirección, Prefectura y Trabajo Social (Prompt 50): reportes, seguimiento, justificantes, captura web, estados y seguridad.                    |
| `07-usuarios`             | Alta de cuenta pendiente, roles, escalamiento, roles sin permiso, **activación completa con control dual** (dos navegadores), deshabilitar.    |
| `08-catalogo`             | Ciclos (alta, validación, traslape, edición, activar/desactivar, histórico) y grupos (alta, duplicado por turno, edición, activar/desactivar). |
| `09-alumnos-matriculas`   | Alumnos, matrícula, pertenencia a grupo, traslado, baja, desactivar/reactivar y alcance por rol.                                               |
| `10-cadena-funcional`     | Asignación de grupo → prefecta consulta solo su grupo → captura → reporte y seguimiento → recepción de justificante → revocación inmediata.    |
| `11-sesiones-simultaneas` | Cuentas distintas y la misma cuenta en `BrowserContext` independientes, deshabilitación, cierre de sesión y tope de sesiones.                  |
| `12-responsive-375`       | Todas las pantallas a 375 × 812 (toque, densidad 2): desbordes, objetivos táctiles, superposiciones, texto, foco y diálogos.                   |
| `13-seguridad-acceso`     | Rutas protegidas sin sesión, cookie falsificada, cambio de cuenta, CSRF/Origin, `no-store`, privilegios del clúster.                           |

## Fixtures frente a interfaz (qué se hizo por la UI y qué no)

- **Fixture** (precondición, `apps/api/scripts/e2e-stack.ts`): el ciclo «Ciclo E2E ficticio», los grupos 1.º A/1.º B con sus alumnos y listas anteriores,
  la cuenta de Dirección, la **segunda autoridad** (`direccion2`, necesaria para el control dual) y las cuentas de prefectura A/B/baja/inactiva,
  Trabajo Social y administración técnica.
- **Por la interfaz**: la cuenta «Prefecta Nueva Ficticia» (alta, rol, activación, asignación y revocación), los ciclos «siguiente» y «anterior»,
  los grupos 1.º C, 1.º D y 2.º A, los alumnos Hugo e Irma con su matrícula y pertenencia, la activación del ciclo vigente y toda la cadena de 10.
- La captura de la lista de **hoy** solo existe de lunes a viernes (hora de la escuela): en fin de semana esos pasos se omiten y se declara.

Detalle y alcance: `docs/product/inventario-funcional-mvp.md` §4.
