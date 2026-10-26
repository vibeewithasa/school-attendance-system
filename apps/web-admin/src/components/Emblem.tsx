/**
 * Marcador del emblema institucional.
 * El emblema oficial aun no esta en el repositorio: cuando se entregue, colocarlo en
 * apps/web-admin/src/assets/emblema-eta15.(svg|png) y reemplazar este componente por <img>.
 * No se usa ningun logo sustituto.
 */
export function Emblem() {
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white text-sm font-bold"
    >
      15
    </span>
  );
}
