/** Contrato de GET /health: solo indica que el proceso HTTP responde. No verifica dependencias. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

/** Contrato de GET /ready: 200 {status:"ready"} o 503 {status:"not_ready"}, sin detalles internos. */
export interface ReadyResponse {
  status: 'ready' | 'not_ready';
}

/** Forma comun de los errores de la API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
