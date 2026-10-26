import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section>
      <h1 className="text-2xl font-bold text-tinto-700">Página no encontrada</h1>
      <Link to="/" className="mt-4 inline-block text-tinto-700 underline">
        Volver al inicio
      </Link>
    </section>
  );
}
