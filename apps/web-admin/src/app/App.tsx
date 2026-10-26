import { Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from '../features/home/NotFoundPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
        </Route>
      </Route>
      {/* Fuera de la zona protegida: una ruta desconocida no revela nada de la aplicacion. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
