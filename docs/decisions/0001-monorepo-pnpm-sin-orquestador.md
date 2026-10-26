# ADR 0001 — Monorepo con pnpm workspaces, sin orquestador

- Estado: aceptada
- Contexto: un equipo pequeño, pocos paquetes, tiempos de build cortos.
- Decisión: pnpm workspaces con scripts `pnpm -r`. No se agrega Turborepo ni Nx.
- Consecuencias: configuración mínima. Reevaluar si los builds o el CI superan tiempos aceptables (registrar un nuevo ADR).
