import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error de interfaz', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold text-tinto-700">Algo salió mal</h1>
        <p className="mt-2">
          Recarga la página. Si el problema continúa, avisa al área de sistemas.
        </p>
      </main>
    );
  }
}
