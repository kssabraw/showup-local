import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center text-2xl">
            ⚠️
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              An unexpected error occurred. Please refresh the page to continue.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 bg-accent text-accent-foreground text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
          >
            Refresh page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
