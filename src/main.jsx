import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Waitlist from './Waitlist.jsx'
import './index.css'

// Error boundary wrapper
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ 
          padding: '20px', 
          color: 'white', 
          backgroundColor: '#1a1f3a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1>Error loading app</h1>
          <p>{this.state.error?.message || 'Unknown error'}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
          <pre style={{ marginTop: '20px', color: '#ef4444' }}>
            {this.state.error?.stack}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));

// Simple routing based on URL
const path = window.location.pathname;
const params = new URLSearchParams(window.location.search);

let ComponentToRender = App;

if (path === '/waitlist' || path === '/beta' || params.get('waitlist') === 'true') {
  ComponentToRender = Waitlist;
} else if (path === '/admin/waitlist' || params.get('admin') === 'waitlist') {
  // Load admin component dynamically
  const WaitlistAdmin = React.lazy(() => import('./WaitlistAdmin.jsx'));
  ComponentToRender = () => (
    <React.Suspense fallback={
      <div style={{ 
        padding: '40px', 
        color: 'white', 
        textAlign: 'center',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%)'
      }}>
        Loading admin...
      </div>
    }>
      <WaitlistAdmin />
    </React.Suspense>
  );
}

try {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ComponentToRender />
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (error) {
  console.error('Failed to render app:', error);
  root.render(
    <div style={{ 
      padding: '20px', 
      color: 'white', 
      backgroundColor: '#1a1f3a',
      minHeight: '100vh'
    }}>
      <h1>Failed to load app</h1>
      <p>{error.message}</p>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
