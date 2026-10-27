import { useEffect, useRef, useState } from 'react';

/**
 * Busqueda con retraso: devuelve el texto YA aplicado (normalizado) despues de `delayMs` sin teclear. Solo cuando el valor aplicado
 * cambia de verdad avisa con `onApplied` (p. ej. para volver a la primera pagina). Un temporizador que no cambia nada NO debe
 * reiniciar la paginacion: si la persona ya pidio la pagina 2 mientras vencia el retraso inicial, perderia su lugar.
 * `normalize` debe ser estable (funcion de modulo).
 */
export function useDebouncedSearch(
  text: string,
  normalize: (text: string) => string,
  onApplied: () => void,
  delayMs = 300,
): string {
  const [applied, setApplied] = useState('');
  const appliedRef = useRef('');
  const onAppliedRef = useRef(onApplied);
  useEffect(() => {
    onAppliedRef.current = onApplied;
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = normalize(text);
      if (next === appliedRef.current) return;
      appliedRef.current = next;
      setApplied(next);
      onAppliedRef.current();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [text, normalize, delayMs]);
  return applied;
}

/** Normalizaciones estables: el servidor exige al menos 2 caracteres en la busqueda de personal y de alumnos. */
export const searchMinTwo = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length >= 2 ? trimmed : '';
};
export const searchTrimmed = (text: string): string => text.trim();
