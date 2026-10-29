# E2E web real (Playwright + Chrome + API + PostgreSQL desechable)

```powershell
. .\tools\env.ps1
pnpm test:e2e            # desde la raíz; también: pnpm --filter @eta15/web-admin test:e2e
```

- Levanta (en `playwright.config.ts`) la pila `apps/api/scripts/e2e-stack.ts` (PostgreSQL 18 temporal con todas las migraciones y las propuestas de
  privilegios 0002–0005 y 0007 **solo en ese clúster**, API real en `127.0.0.1:3000`, datos ficticios deterministas) y el portal Vite (`127.0.0.1:5173`).
  Los puertos 3000 y 5173 deben estar libres.
- Usa el Chrome instalado (`channel: 'chrome'`; `E2E_CHANNEL=msedge` para Edge). No descarga navegadores.
- **No toca `eta15_dev`**, no usa mocks ni intercepta respuestas (salvo una avería de red inyectada y declarada en `05-estados-y-seguridad`).
- La contraseña de las cuentas ficticias se genera al azar en cada ejecución (variable de entorno del proceso; no se guarda ni se imprime). El archivo de
  estado (sin secretos) se escribe en la carpeta temporal del sistema. Sin trazas ni video.
- Los escenarios se ejecutan en orden (`01`…`06`, un solo trabajador) porque comparten la base desechable: `03` registra recepciones y `04` comprueba que no
  cambian las ausencias; `06` captura la lista de hoy (se omite en fin de semana).
- `support.ts` consulta la base **desechable** solo para verificar lo que hizo el navegador.
- Detalle y alcance: `docs/product/inventario-funcional-mvp.md` §4.
