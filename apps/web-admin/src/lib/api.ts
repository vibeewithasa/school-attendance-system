import type {
  ApproveMobileDeviceBody,
  ClaimMobileDeviceBody,
  MobileDevicesListResponse,
  MobileRequestDto,
  RevokeMobileDeviceBody,
  AttendanceDayDetail,
  AttendanceGroupReport,
  AttendanceGroupReportQuery,
  AttendanceReportOptions,
  AttendanceReportStudentOptions,
  AttendanceStudentReport,
  AttendanceStudentReportQuery,
  CreateJustificationReceiptBody,
  CreateJustificationReceiptResponse,
  JustificationReceiptList,
  JustificationStudentSearch,
  ListJustificationReceiptsQuery,
  AttendanceDayList,
  AttendanceEventList,
  AttendanceTodayResponse,
  FinalizeAttendanceDayBody,
  FinalizeAttendanceDayResponse,
  ListAttendanceDaysQuery,
  OpenAttendanceDayBody,
  OpenAttendanceDayResponse,
  SaveAttendanceMarksBody,
  SaveAttendanceMarksResponse,
  ClosePrefectAssignmentBody,
  CreatePrefectAssignmentBody,
  ListPrefectAssignmentsQuery,
  PrefectAssignmentDto,
  PrefectAssignmentList,
  PrefectCandidateDto,
  RevokePrefectAssignmentBody,
  AssignGroupBody,
  CreateStudentBody,
  EnrollBody,
  EnrollmentDto,
  ListStudentsQuery,
  StudentDto,
  StudentList,
  TransferBody,
  UpdateStudentBody,
  WithdrawBody,
  ActivationRequestList,
  ActivationStatusResponse,
  AdminRole,
  AdminUser,
  AdminUserList,
  ApiErrorBody,
  ApproveActivationBody,
  AuthCsrfResponse,
  AuthLoginResponse,
  AuthMeResponse,
  CreateGroupBody,
  CreateSchoolYearBody,
  CreateUserBody,
  GroupDto,
  GroupList,
  HealthResponse,
  ListUsersQuery,
  SchoolYearDto,
  SchoolYearList,
  Shift,
  UpdateGroupBody,
  UpdateSchoolYearBody,
} from '@eta15/shared-contracts';

/** Base de la API. En desarrollo Vite redirige /api a la API local (ver vite.config.ts). */
const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Motivos de la politica de contrasenas (solo con PASSWORD_POLICY); nunca la contrasena. */
    public readonly reasons: string[] = [],
  ) {
    super(message);
  }
}

/** Fallo de red o respuesta ilegible: la API no pudo contactarse (distinto de un rechazo de la API). */
export class NetworkError extends Error {}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** El proveedor de sesion se registra aqui para volver a login cuando cualquier llamada recibe 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Valor para X-CSRF-Token (solo en memoria; se obtiene de GET /auth/csrf cuando se necesita). */
  csrf?: string;
  /** No avisar al manejador global de 401 (p. ej. la comprobacion inicial de sesion o rutas publicas). */
  quiet401?: boolean;
}

/**
 * La sesion vive en una cookie HttpOnly gestionada por el navegador: este codigo nunca ve, guarda ni envia manualmente el token
 * (nada en localStorage, sessionStorage, URL ni estado persistente). `credentials: 'same-origin'` basta porque en desarrollo
 * Vite hace de proxy y la API queda en el mismo origen (http://127.0.0.1:5173/api).
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    throw new NetworkError('No se pudo contactar con el servidor', { cause });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      (ApiErrorBody & { error: { reasons?: string[] } }) | null;
    if (res.status === 401 && !options.quiet401) onUnauthorized?.();
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.reasons ?? [],
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Mutaciones autenticadas: piden un valor CSRF ligado a la sesion justo antes de cada cambio (no se guarda: no hay estado
 * obsoleto que invalidar) y lo envian en la cabecera. El servidor ademas comprueba Origin y Fetch Metadata.
 */
async function mutate<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const { csrfToken } = await request<AuthCsrfResponse>('/auth/csrf');
  return request<T>(path, { method, body, csrf: csrfToken });
}

const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request<HealthResponse>('/health'),
  /** Comprobacion de sesion: un 401 aqui es el estado normal "sin sesion", no un evento. */
  me: () => request<AuthMeResponse>('/auth/me', { quiet401: true }),
  login: (email: string, password: string) =>
    request<AuthLoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      quiet401: true,
    }),
  /** Cierra la sesion actual: obtiene un valor CSRF ligado a la sesion y lo envia en la cabecera. */
  async logout(): Promise<void> {
    const { csrfToken } = await request<AuthCsrfResponse>('/auth/csrf', { quiet401: true });
    await request<void>('/auth/logout', { method: 'POST', csrf: csrfToken, quiet401: true });
  },

  // --- Administracion de cuentas (el servidor autoriza cada llamada; la interfaz solo adapta lo que muestra) ---
  listUsers: (q: Partial<ListUsersQuery>) =>
    request<AdminUserList>(`/admin/users${query({ ...q })}`),
  getUser: (id: string) => request<AdminUser>(`/admin/users/${id}`),
  createUser: (
    body: Omit<CreateUserBody, 'emailKind'> & { emailKind?: CreateUserBody['emailKind'] },
  ) => mutate<AdminUser>('/admin/users', 'POST', body),
  disableUser: (id: string) => mutate<AdminUser>(`/admin/users/${id}/disable`, 'POST'),
  listRoles: () => request<AdminRole[]>('/admin/roles'),
  assignRole: (id: string, roleKey: string) =>
    mutate<AdminUser>(`/admin/users/${id}/roles`, 'POST', { roleKey }),
  revokeRole: (id: string, roleKey: string) =>
    mutate<AdminUser>(`/admin/users/${id}/roles/${roleKey}`, 'DELETE'),
  listActivations: () => request<ActivationRequestList>('/admin/activation-requests'),
  approveActivation: (id: string, body: ApproveActivationBody) =>
    mutate<{ state: 'authorized' }>(`/admin/activation-requests/${id}/approve`, 'POST', body),
  cancelActivation: (id: string) =>
    mutate<{ state: 'cancelled' }>(`/admin/activation-requests/${id}/cancel`, 'POST'),

  // --- Catalogo escolar (ciclos y grupos). Sin borrado: se desactiva. El servidor autoriza cada llamada. ---
  listSchoolYears: (q: { page?: number; pageSize?: number; isActive?: boolean } = {}) =>
    request<SchoolYearList>(`/catalog/school-years${query({ ...q })}`),
  createSchoolYear: (body: CreateSchoolYearBody) =>
    mutate<SchoolYearDto>('/catalog/school-years', 'POST', body),
  updateSchoolYear: (id: string, body: UpdateSchoolYearBody) =>
    mutate<SchoolYearDto>(`/catalog/school-years/${id}`, 'PATCH', body),
  activateSchoolYear: (id: string) =>
    mutate<SchoolYearDto>(`/catalog/school-years/${id}/activate`, 'POST'),
  deactivateSchoolYear: (id: string) =>
    mutate<SchoolYearDto>(`/catalog/school-years/${id}/deactivate`, 'POST'),
  listGroups: (
    q: {
      page?: number;
      pageSize?: number;
      schoolYearId?: string;
      grade?: number;
      shift?: Shift | 'none';
      isActive?: boolean;
      q?: string;
    } = {},
  ) => request<GroupList>(`/catalog/groups${query({ ...q })}`),
  createGroup: (body: CreateGroupBody) => mutate<GroupDto>('/catalog/groups', 'POST', body),
  updateGroup: (id: string, body: UpdateGroupBody) =>
    mutate<GroupDto>(`/catalog/groups/${id}`, 'PATCH', body),

  // --- Alumnos, matriculas e historial de grupo (datos de menores; el servidor autoriza cada llamada). Sin borrado. ---
  listStudents: (q: Partial<ListStudentsQuery> = {}) =>
    request<StudentList>(`/school/students${query({ ...q })}`),
  getStudent: (id: string) => request<StudentDto>(`/school/students/${id}`),
  createStudent: (body: Omit<CreateStudentBody, 'schoolCode'> & { schoolCode?: string | null }) =>
    mutate<StudentDto>('/school/students', 'POST', body),
  updateStudent: (id: string, body: UpdateStudentBody) =>
    mutate<StudentDto>(`/school/students/${id}`, 'PATCH', body),
  deactivateStudent: (id: string) =>
    mutate<StudentDto>(`/school/students/${id}/deactivate`, 'POST'),
  reactivateStudent: (id: string) =>
    mutate<StudentDto>(`/school/students/${id}/reactivate`, 'POST'),
  listEnrollments: (studentId: string) =>
    request<EnrollmentDto[]>(`/school/students/${studentId}/enrollments`),
  enrollStudent: (studentId: string, body: EnrollBody) =>
    mutate<EnrollmentDto>(`/school/students/${studentId}/enrollments`, 'POST', body),
  withdrawEnrollment: (id: string, body: WithdrawBody = {}) =>
    mutate<EnrollmentDto>(`/school/enrollments/${id}/withdraw`, 'POST', body),
  assignGroup: (enrollmentId: string, body: AssignGroupBody) =>
    mutate<EnrollmentDto>(`/school/enrollments/${enrollmentId}/group-assignments`, 'POST', body),
  transferGroup: (enrollmentId: string, body: TransferBody) =>
    mutate<EnrollmentDto>(`/school/enrollments/${enrollmentId}/transfer`, 'POST', body),

  // --- Asignaciones de grupos a prefectura (administra Direccion; el servidor autoriza cada llamada). Sin borrado. ---
  listPrefectCandidates: (q: { q?: string } = {}) =>
    request<PrefectCandidateDto[]>(`/school/prefect-candidates${query({ ...q })}`),
  listPrefectAssignments: (q: Partial<ListPrefectAssignmentsQuery> = {}) =>
    request<PrefectAssignmentList>(`/school/prefect-assignments${query({ ...q })}`),
  createPrefectAssignment: (body: CreatePrefectAssignmentBody) =>
    mutate<PrefectAssignmentDto>('/school/prefect-assignments', 'POST', body),
  closePrefectAssignment: (id: string, body: ClosePrefectAssignmentBody = {}) =>
    mutate<PrefectAssignmentDto>(`/school/prefect-assignments/${id}/close`, 'POST', body),
  revokePrefectAssignment: (id: string, body: RevokePrefectAssignmentBody) =>
    mutate<PrefectAssignmentDto>(`/school/prefect-assignments/${id}/revoke`, 'POST', body),

  // --- Asistencia diaria (una lista por grupo y fecha; la fecha la decide el servidor). Sin borrado ni correcciones. ---
  attendanceToday: () => request<AttendanceTodayResponse>('/school/attendance/today'),
  openAttendanceDay: (body: OpenAttendanceDayBody) =>
    mutate<OpenAttendanceDayResponse>('/school/attendance/days', 'POST', body),
  listAttendanceDays: (q: Partial<ListAttendanceDaysQuery> = {}) =>
    request<AttendanceDayList>(`/school/attendance/days${query({ ...q })}`),
  getAttendanceDay: (id: string) => request<AttendanceDayDetail>(`/school/attendance/days/${id}`),
  saveAttendanceMarks: (id: string, body: SaveAttendanceMarksBody) =>
    mutate<SaveAttendanceMarksResponse>(`/school/attendance/days/${id}/marks`, 'POST', body),
  finalizeAttendanceDay: (id: string, body: FinalizeAttendanceDayBody) =>
    mutate<FinalizeAttendanceDayResponse>(`/school/attendance/days/${id}/finalize`, 'POST', body),
  // --- Reportes basicos de asistencia (SOLO LECTURA; el servidor autoriza y aplica el alcance por grupo). ---
  attendanceReportOptions: () =>
    request<AttendanceReportOptions>('/school/attendance/reports/options'),
  attendanceReportGroupStudents: (groupId: string) =>
    request<AttendanceReportStudentOptions>(`/school/attendance/reports/group/${groupId}/students`),
  attendanceGroupReport: (q: AttendanceGroupReportQuery) =>
    request<AttendanceGroupReport>(`/school/attendance/reports/group${query({ ...q })}`),
  attendanceStudentReport: (studentId: string, q: AttendanceStudentReportQuery) =>
    request<AttendanceStudentReport>(
      `/school/attendance/reports/student/${studentId}${query({ ...q })}`,
    ),
  // --- Recepcion de justificantes (Trabajo Social): hecho administrativo; no aprueba ni modifica la asistencia. ---
  searchJustificationStudents: (q: string) =>
    request<JustificationStudentSearch>(`/school/justifications/students${query({ q })}`),
  createJustificationReceipt: (body: CreateJustificationReceiptBody) =>
    mutate<CreateJustificationReceiptResponse>('/school/justifications/receipts', 'POST', body),
  listJustificationReceipts: (q: Partial<ListJustificationReceiptsQuery> = {}) =>
    request<JustificationReceiptList>(`/school/justifications/receipts${query({ ...q })}`),
  listAttendanceEvents: (id: string, q: { page?: number; pageSize?: number } = {}) =>
    request<AttendanceEventList>(`/school/attendance/days/${id}/events${query({ ...q })}`),

  // --- Dispositivos moviles (PROTOTIPO de sandbox, ADR 0005 "propuesta"): canal web con cookie + CSRF. La persona titular reclama la
  // solicitud de su dispositivo; una autoridad confirma la huella. Ninguna llamada envia un identificador de persona. ---
  claimMobileDevice: (body: ClaimMobileDeviceBody) =>
    mutate<MobileRequestDto>('/mobile-devices/claims', 'POST', body),
  listMyMobileDevices: () => request<MobileDevicesListResponse>('/mobile-devices/mine'),
  cancelMobileRequest: (id: string) =>
    mutate<{ id: string }>(`/mobile-devices/mine/requests/${id}/cancel`, 'POST'),
  revokeMyMobileDevice: (id: string) =>
    mutate<{ id: string }>(`/mobile-devices/mine/devices/${id}/revoke`, 'POST'),
  listMobileDevices: () => request<MobileDevicesListResponse>('/mobile-devices'),
  approveMobileRequest: (id: string, body: ApproveMobileDeviceBody) =>
    mutate<MobileRequestDto>(`/mobile-devices/requests/${id}/approve`, 'POST', body),
  rejectMobileRequest: (id: string) =>
    mutate<{ id: string }>(`/mobile-devices/requests/${id}/reject`, 'POST'),
  revokeMobileDevice: (id: string, body: RevokeMobileDeviceBody) =>
    mutate<{ id: string }>(`/mobile-devices/devices/${id}/revoke`, 'POST', body),

  // --- Activacion por la persona titular (rutas publicas; el secreto nunca sale de esta pagina salvo al completar) ---
  activationRequest: (email: string, secretHash: string) =>
    request<{ accepted: true; ttlMinutes: number }>('/auth/activation/request', {
      method: 'POST',
      body: { email, secretHash },
      quiet401: true,
    }),
  activationStatus: (secretHash: string) =>
    request<ActivationStatusResponse>('/auth/activation/status', {
      method: 'POST',
      body: { secretHash },
      quiet401: true,
    }),
  activationComplete: (secret: string, newPassword: string) =>
    request<void>('/auth/activation/complete', {
      method: 'POST',
      body: { secret, newPassword },
      quiet401: true,
    }),
};
