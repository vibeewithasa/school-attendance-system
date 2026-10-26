# ADR 0004 — Auth/RBAC propio: sesiones de servidor, Argon2id nativo, dominios y control de privilegios en la base

- Estado: **propuesta revisada tras auditoría de seguridad, pendiente de aprobación técnica**
- Detalle, evidencias y modelo de datos: [auth-rbac.md](../architecture/auth-rbac.md)

## Contexto

Datos de menores. Cuentas creadas solo por personal autorizado, sin registro público. Clientes: web ahora; Android y PWA después. El administrador técnico no debe poder obtener, conceder ni suplantar acceso a expedientes. Sin proveedor de correo.

## Decisiones

1. **Opción B: sesiones de servidor propias con bibliotecas mantenidas**, no Better Auth ni criptografía propia. Según su documentación oficial, Better Auth no documenta caducidad absoluta/inactividad/tope de sesiones ni política por rol; guarda roles como texto separado por comas con permisos estáticos; su 2FA es opt-in por usuario; y su plugin de administración crea usuarios con contraseña. Habría que reemplazar RBAC, sesiones y altas conservando una dependencia grande dueña de la identidad. Se reevalúa si la etapa MFA lo justificara.
2. **Sesión**: token opaco de 256 bits, solo su SHA-256 en BD, cookie `HttpOnly`; no JWT en la web. **Argon2id** con `node:crypto` (`crypto.argon2`, v24.7.0): m = 64 MiB, t = 3, p = 1 (≈ 99 ms).
3. **Separación de dominios `school`/`technical`** impuesta por FK compuestas y CHECK. Acceso escolar lo concede solo Dirección; el admin técnico solo concede roles técnicos y solo puede **reducir** acceso a otras cuentas. Nadie se concede roles a sí mismo.
4. **Permisos de autoridad** (`users:manage_*`, `roles:grant_*`, `roles:manage_*`) marcados `is_authority`: no se delegan ni se editan por la API; solo por migración/propietario. Ningún UPDATE de `role_permissions`.
5. **Triggers de integridad como última defensa**, independientes del código de la aplicación: concesión y revocación con permiso, actor activo y bloqueo `FOR SHARE`; historial de roles no borrable; auditoría de cambios de roles y de `role_permissions`; revocación de sesiones al cambiar roles, contraseña o estado; tope de sesiones concurrentes atómico; creación de cuentas solo pendientes y con creador autorizado.
6. **Bootstrap y rescate** solo por el **propietario del esquema**, con **acta** (`grant_reference`) y rol que contenga `roles:grant_<dominio>`, bajo bloqueo consultivo y `READ COMMITTED`. El bootstrap se cierra **para siempre** cuando el dominio tiene cualquier historial; la pérdida de todos los titulares se atiende con `recovery`, que solo procede sin titulares activos con autoridad. La ausencia de usuarios **no** otorga capacidad a ningún solicitante.
7. **Activación y recuperación por reclamo en dos partes**: el secreto lo genera el navegador del titular (solo se guarda su hash); una autoridad del dominio (otra persona) verifica la identidad en persona y autoriza; el titular completa. La autoridad no conoce el secreto ni la contraseña, no puede sustituirlo ni obtener sesión; la activación de una cuenta pendiente exige consumir el token **en la misma transacción** (`used_txid`, no `now()`). Sin recuperación remota ni proveedor de correo.
8. **MFA** obligatorio para `admin_tecnico` y `direccion` antes de datos reales; TOTP con biblioteca mantenida; no hay función que lo desactive.
9. **Auditoría**: solo inserción para quien no sea propietario; **no es absolutamente inmutable** (el propietario puede quitar el trigger). La API necesitará un rol de ejecución distinto del propietario (ADR 0003); matriz de privilegios documentada, sin cambiar roles reales.
10. **Alcance** (`all | assigned_groups | own`) con semántica y contratos por recurso y campo; conjunto vacío = cero filas.
11. **Android**: refresh rotativo y concesión offline firmada; sin implementar.

## Alternativas descartadas

Better Auth (arriba); JWT en la web (revocación diferida); IdP externo (dependencia/infraestructura inexistente); TOTP o hash artesanales (prohibido inventar criptografía).

## Consecuencias y límites

- Migraciones 0003–0005 **preparadas, no aplicadas**. Dependencias previstas: `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/helmet` (+ TOTP en la etapa MFA).
- Las guardas "solo propietario" (bootstrap, recovery, permisos de autoridad, creación de cuentas) **solo protegen frente a la API cuando esta usa un rol distinto del propietario**. Mientras compartan rol (desarrollo), esa protección es procedimental.
- Quien posea la credencial del propietario o un superusuario puede deshabilitar triggers y alterar filas: techo de confianza.
- Dirección es punto crítico para cuentas escolares (D7: segundo titular).
- Una autoridad maliciosa puede registrar ella misma una solicitud de otra persona y autorizarla; se mitiga con MFA, control dual entre pares, auditoría y aviso, y por eso las cuentas con MFA obligatorio no se usan con datos reales hasta implementarlo.
- Decisiones institucionales abiertas D1–D8 en auth-rbac.md §18.
