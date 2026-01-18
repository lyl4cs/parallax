import React, { useState } from 'react';
import axios from 'axios';
import './Waitlist.css';

const API_BASE = '/api';

function Waitlist() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      setLoading(false);
      return;
    }

    try {
      console.log('Submitting email to waitlist:', email);
      const response = await axios.post(`${API_BASE}/waitlist`, { email }, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Waitlist response:', response.data);
      
      if (response.data && response.data.success) {
        console.log('Success! Setting submitted to true');
        setSubmitted(true);
        setEmail('');
        setError(''); // Clear any previous errors
      } else {
        console.log('Response not successful:', response.data);
        setError(response.data?.error || 'Failed to join waitlist');
      }
    } catch (error) {
      console.error('Waitlist signup error:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        code: error.code
      });
      
      if (error.code === 'ECONNREFUSED' || error.message.includes('Network Error')) {
        setError('Cannot connect to server. Please make sure the backend is running on port 3001.');
      } else if (error.response?.status === 404 || (error.response?.status === undefined && error.message.includes('404'))) {
        setError('Waitlist endpoint not found. Please restart the backend server (npm run server) to load the waitlist endpoints.');
      } else if (error.response?.status === 409) {
        setError('This email is already on the waitlist!');
      } else if (error.response?.status === 400) {
        setError(error.response.data?.error || 'Invalid email address');
      } else if (error.response?.data?.error) {
        setError(error.response.data.error);
      } else {
        setError(`Failed to join waitlist: ${error.message || 'Unknown error'}. If this persists, restart the backend server.`);
      }
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="waitlist-container">
        <div className="waitlist-success">
          <div className="success-icon">✓</div>
          <h1>You're on the list!</h1>
          <p>Thanks for your interest in Parallax. We'll notify you as soon as the beta is ready.</p>
          <button onClick={() => setSubmitted(false)} className="btn-secondary">
            Add Another Email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="waitlist-container">
      <div className="waitlist-content">
        <div className="waitlist-header">
          <h1 className="waitlist-logo">Parallax</h1>
          <h2>Trade Copier Beta</h2>
          <p className="waitlist-subtitle">
            Join the waitlist to be notified when Parallax beta launches.
            Real-time trade copying, position sync, and more.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="waitlist-form">
          {error && (
            <div className="waitlist-error" role="alert">
              {error}
            </div>
          )}
          {loading && (
            <div className="waitlist-loading" style={{
              textAlign: 'center',
              color: '#667eea',
              marginBottom: '16px',
              fontSize: '14px'
            }}>
              Submitting...
            </div>
          )}
          
          <div className="form-input-group">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email address"
              required
              disabled={loading}
              className="waitlist-input"
            />
            <button 
              type="submit" 
              disabled={loading || !email}
              className="waitlist-button"
            >
              {loading ? 'Joining...' : 'Join Waitlist'}
            </button>
          </div>
        </form>

        <div className="waitlist-features">
          <div className="feature-item">
            <span className="feature-icon">⚡</span>
            <span>Real-time Trade Copying</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">🔒</span>
            <span>Secure & Reliable</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">📊</span>
            <span>Position Sync</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Waitlist;
