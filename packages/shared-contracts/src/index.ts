/** Contrato de GET /health: solo indica que el proceso HTTP responde. No verifica dependencias. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

/** Forma comun de los errores de la API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
