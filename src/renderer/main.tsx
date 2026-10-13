import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>LectureDesk</h1>
        <h2>Не удалось открыть интерфейс · The interface could not be opened</h2>
        <p>{this.state.error}</p>
        <button onClick={() => window.location.reload()}>Повторить · Retry</button>
        <p>Сохранённые записи остаются на диске. Saved recordings remain on disk.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
