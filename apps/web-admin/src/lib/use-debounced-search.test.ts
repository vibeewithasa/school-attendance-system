import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchMinTwo, useDebouncedSearch } from './use-debounced-search';

/**
 * Regresion de la prueba intermitente de paginacion de Personal: el temporizador inicial (texto vacio) vencia 300 ms despues del
 * montaje y mandaba a la pagina 1 aunque la persona ya hubiera pedido la 2. Con relojes simulados el orden es determinista.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useDebouncedSearch', () => {
  it('un temporizador que no cambia el valor aplicado NO avisa (no reinicia la paginacion)', () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch('', searchMinTwo, onApplied));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe('');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('aplica el texto despues del retraso, exige 2 caracteres y avisa una vez por cambio', () => {
    const onApplied = vi.fn();
    const { result, rerender } = renderHook(
      ({ text }) => useDebouncedSearch(text, searchMinTwo, onApplied),
      { initialProps: { text: '' } },
    );
    rerender({ text: 'm' });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe('');
    expect(onApplied).not.toHaveBeenCalled();

    rerender({ text: 'ma' });
    rerender({ text: 'mar' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(''); // el retraso se reinicia con cada tecla
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('mar');
    expect(onApplied).toHaveBeenCalledTimes(1);

    rerender({ text: 'mar ' }); // mismo valor normalizado
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onApplied).toHaveBeenCalledTimes(1);

    rerender({ text: '' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe('');
    expect(onApplied).toHaveBeenCalledTimes(2);
  });
});
