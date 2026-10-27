import { Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { ActivationPage } from '../features/activation/ActivationPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { StudentsPage } from '../features/alumnos/StudentsPage';
import { CatalogPage } from '../features/catalogo/CatalogPage';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from '../features/home/NotFoundPage';
import { PersonalPage } from '../features/personal/PersonalPage';
import { PrefectAssignmentsPage } from '../features/prefectura/PrefectAssignmentsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activar" element={<ActivationPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="personal" element={<PersonalPage />} />
          <Route path="catalogo" element={<CatalogPage />} />
          <Route path="alumnos" element={<StudentsPage />} />
          <Route path="prefectura" element={<PrefectAssignmentsPage />} />
        </Route>
      </Route>
      {/* Fuera de la zona protegida: una ruta desconocida no revela nada de la aplicacion. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
