import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Apoyo del E2E web real. Todo es FICTICIO. La contrasena sale del entorno de esta ejecucion (E2E_PASSWORD) y nunca se escribe ni
 * se imprime. La base se consulta con el rol propietario del clúster DESECHABLE (puerto del archivo de estado), solo para VERIFICAR
 * lo que hizo el navegador contra los registros reales; jamas contra eta15_dev.
 */
export interface E2eState {
  dbPort: number;
  today: string;
  /** Cinco dias habiles anteriores a hoy (w1 el mas antiguo ... w5 el mas reciente). */
  weekdays: [string, string, string, string, string];
  year: string;
  groups: { A: string; B: string };
  students: Record<'ana' | 'beto' | 'carla' | 'diego' | 'elena' | 'fabi' | 'gael', string>;
  accounts: Record<
    | 'tecnico'
    | 'direccion'
    | 'direccion2'
    | 'prefecturaA'
    | 'prefecturaB'
    | 'trabajoSocial'
    | 'inactiva'
    | 'prefecturaBaja',
    string
  >;
}

export const state = (): E2eState =>
  JSON.parse(readFileSync(process.env.E2E_STATE_FILE!, 'utf8')) as E2eState;
export const password = (): string => process.env.E2E_PASSWORD!;

// `pg` ya es dependencia de apps/api: se resuelve desde alli (no se agrega al portal).
const requireFromApi = createRequire(join(process.cwd(), '..', 'api', 'package.json'));
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  end(): Promise<void>;
}
/** Consulta de SOLO verificacion contra el clúster desechable (rol propietario del clúster, sin contrasena: autenticacion de confianza local). */
export async function db<T>(run: (q: PgClient['query']) => Promise<T>): Promise<T> {
  const { Client } = requireFromApi('pg') as { Client: new (cfg: object) => PgClient };
  const client = new Client({
    host: '127.0.0.1',
    port: state().dbPort,
    user: 'eta15_app',
    database: 'eta15_dev',
  });
  await client.connect();
  try {
    return await run(client.query.bind(client));
  } finally {
    await client.end();
  }
}

/** Contrasena que elige POR LA INTERFAZ la cuenta que se activa durante la ejecucion (derivada de la de la ejecucion; no se guarda). */
export const chosenPassword = (): string => `${password()}-Elegida1`;
export const ORIGIN = 'http://127.0.0.1:5173';
/** Cuenta que se crea, activa y asigna por la interfaz en 07/10 (no existe en la siembra). */
export const NEW_PREFECT = {
  email: 'prefectura.nueva.e2e@escuela.test',
  name: 'Prefecta Nueva Ficticia',
};

/** Inicia sesion POR LA INTERFAZ (cookie, CSRF y Origin reales) y espera el panel autenticado. */
export async function loginAs(page: Page, email: string, pass: string = password()): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
}

export const NOTICE_FOLLOWUP =
  'Los conteos reflejan únicamente ausencias registradas. No incluyen reglas de justificantes ni representan alertas oficiales.';
export const NOTICE_RECEIPT =
  'El registro de recepción no modifica la asistencia ni acredita la justificación de una falta.';

/** Huella de TODA la asistencia (listas, renglones y eventos): debe ser identica tras registrar justificantes. */
export const attendanceFingerprint = () =>
  db(async (q) =>
    JSON.stringify([
      (await q(`select id, status, revision from attendance_days order by id`)).rows,
      (await q(`select id, status, marked_by, marked_at from attendance_records order by id`)).rows,
      (await q(`select id, event_type, old_status, new_status from attendance_events order by id`))
        .rows,
    ]),
  );

/** Contexto de navegador NUEVO e independiente (cookies, almacenamiento y sesion propios) con la misma configuracion de la prueba. */
export async function isolated(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Peticion HTTP con la sesion del navegador, con Origin permitido y token CSRF reales (para comprobar lo que el servidor decide). */
export async function send(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extra: { csrf?: string | null; origin?: string } = {},
) {
  const token =
    extra.csrf === undefined
      ? ((await (await page.request.get('/api/auth/csrf')).json()).csrfToken as string)
      : extra.csrf;
  const headers: Record<string, string> = { origin: extra.origin ?? ORIGIN };
  if (token) headers['x-csrf-token'] = token;
  return page.request.fetch(`/api${path}`, { method, headers, data: body });
}

/** Cantidad de eventos de auditoria de un tipo (solo verificacion contra la base desechable). */
export const auditCount = (type: string, outcome?: string) =>
  db(
    async (q) =>
      (
        await q(
          `select count(*)::int n from audit_events where event_type = $1 and ($2::text is null or outcome = $2)`,
          [type, outcome ?? null],
        )
      ).rows[0]!.n as number,
  );

/** Elige la opcion de un <select> cuyo texto CONTIENE `text` (las opciones suelen llevar datos adicionales: «(vigente)», fechas). */
export async function pickByText(select: Locator, text: string): Promise<void> {
  // las opciones pueden cargarse despues del primer pintado: se espera a que aparezca la que se busca
  await expect
    .poll(
      async () => (await select.locator('option').allTextContents()).some((t) => t.includes(text)),
      {
        message: `opcion con «${text}»`,
      },
    )
    .toBe(true);
  const label = (await select.locator('option').allTextContents()).find((t) => t.includes(text))!;
  await select.selectOption({ label });
}

/**
 * Auditoria de diseno ADAPTABLE de la pantalla actual (se ejecuta en el navegador real). Devuelve una lista de problemas:
 *  - desplazamiento horizontal de toda la pagina;
 *  - controles (enlaces, botones, campos) fuera de la pantalla fuera de un contenedor con desplazamiento horizontal;
 *  - objetivos tactiles menores de 24 x 24 px (WCAG 2.2, 2.5.8; los enlaces dentro de un texto estan exentos);
 *  - controles que se superponen entre si (sin contar los que contiene otro, p. ej. una etiqueta que envuelve una casilla);
 *  - texto visible menor de 12 px.
 * Los contenedores con desplazamiento horizontal deliberado (tablas anchas) no se consideran un problema.
 */
export async function layoutIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1)
      issues.push(
        `la pagina se desplaza horizontalmente (${document.documentElement.scrollWidth} > ${vw})`,
      );
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const scrollParent = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p;
      }
      return null;
    };
    const label = (el: Element) =>
      (el.getAttribute('aria-label') || el.textContent || (el as HTMLElement).id || el.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
    // con un cuadro de dialogo abierto solo cuenta lo que contiene (el resto de la pagina queda cubierto por el fondo)
    const scope: ParentNode = document.querySelector('[role=dialog]') ?? document;
    const controls = [
      ...scope.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, [role=tab]',
      ),
    ].filter(visible);
    const boxes: Array<{ el: Element; r: DOMRect }> = [];
    const undersized: Array<{ el: Element; r: DOMRect }> = [];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const tiny = r.width <= 2 || r.height <= 2; // controles solo-lector (p. ej. el enlace «Saltar al contenido»)
      if (tiny) continue;
      if (!scrollParent(el) && (r.left < -1 || r.right > vw + 1))
        issues.push(
          `control fuera de la pantalla: «${label(el)}» (${Math.round(r.left)}..${Math.round(r.right)})`,
        );
      const inlineLink =
        el.tagName === 'A' &&
        el.closest('p, li, span.block, label') !== null &&
        el.closest('nav') === null;
      const isRadio = el instanceof HTMLInputElement && ['radio', 'checkbox'].includes(el.type);
      if (!inlineLink && !isRadio && (r.height < 24 || r.width < 24)) undersized.push({ el, r });
      boxes.push({ el, r });
    }
    // WCAG 2.2 (2.5.8): un objetivo menor de 24 x 24 px es aceptable si el cuadrado de 24 px centrado en el no toca a otro objetivo
    for (const u of undersized) {
      const cx = (u.r.left + u.r.right) / 2;
      const cy = (u.r.top + u.r.bottom) / 2;
      const near = boxes.find(
        (b) =>
          b.el !== u.el &&
          !b.el.contains(u.el) &&
          !u.el.contains(b.el) &&
          b.r.left < cx + 12 &&
          b.r.right > cx - 12 &&
          b.r.top < cy + 12 &&
          b.r.bottom > cy - 12,
      );
      if (near)
        issues.push(
          `objetivo tactil menor de 24 px y sin separacion: «${label(u.el)}» (${Math.round(u.r.width)}x${Math.round(u.r.height)}) junto a «${label(near.el)}»`,
        );
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // control incrustado a proposito (p. ej. «Mostrar» dentro del campo de contrasena): uno queda por completo dentro del otro
        const inside = (x: DOMRect, y: DOMRect) =>
          x.left >= y.left - 1 &&
          x.right <= y.right + 1 &&
          x.top >= y.top - 1 &&
          x.bottom <= y.bottom + 1;
        if (inside(a.r, b.r) || inside(b.r, a.r)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2)
          issues.push(`controles superpuestos: «${label(a.el)}» y «${label(b.el)}»`);
      }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const small = new Set<string>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || !visible(el)) continue;
      if (el.closest('[role=img]')) continue; // marcador de posicion grafico (p. ej. logotipo), no es contenido de lectura
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) small.add(`${text.slice(0, 30)} (${size}px)`);
    }
    for (const t of small) issues.push(`texto menor de 12 px: ${t}`);
    return [...new Set(issues)];
  });
}

/** Elementos con foco: recorre Tab y devuelve los que quedan fuera de la pantalla o sin ningun indicador de foco visible. */
export async function focusProblems(page: Page, steps: number): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const name = (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      // los campos de fecha/hora tienen sub-controles internos del navegador (selector de calendario) que reciben Tab sin :focus-visible propio
      const nativePart =
        el instanceof HTMLInputElement &&
        ['date', 'time'].includes(el.type) &&
        !el.matches(':focus-visible');
      const ring =
        nativePart ||
        (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) ||
        st.boxShadow !== 'none';
      return { name, inView, ring };
    });
    if (!info) continue;
    if (!info.inView) problems.push(`foco fuera de la pantalla: «${info.name}»`);
    if (!info.ring) problems.push(`sin indicador de foco visible: «${info.name}»`);
  }
  return [...new Set(problems)];
}
