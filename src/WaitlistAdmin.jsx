import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './WaitlistAdmin.css';

const API_BASE = '/api';

function WaitlistAdmin() {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [notificationSubject, setNotificationSubject] = useState('');
  const [notificationMessage, setNotificationMessage] = useState('');
  const [sendingNotification, setSendingNotification] = useState(false);
  const [notificationResult, setNotificationResult] = useState(null);

  useEffect(() => {
    fetchWaitlist();
  }, []);

  const fetchWaitlist = async () => {
    try {
      const response = await axios.get(`${API_BASE}/waitlist`);
      if (response.data.success) {
        setEmails(response.data.emails);
      }
    } catch (error) {
      console.error('Error fetching waitlist:', error);
      alert('Error loading waitlist: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const response = await fetch(`${API_BASE}/waitlist/export`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `parallax-beta-waitlist-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error exporting waitlist:', error);
      alert('Error exporting waitlist: ' + error.message);
    }
  };

  const handleCopyEmails = () => {
    const emailList = filteredEmails.join('\n');
    navigator.clipboard.writeText(emailList).then(() => {
      alert('Email list copied to clipboard!');
    }).catch(err => {
      alert('Failed to copy: ' + err.message);
    });
  };

  const handleDelete = async (email) => {
    if (!confirm(`Remove ${email} from waitlist?`)) {
      return;
    }
    try {
      await axios.delete(`${API_BASE}/waitlist/${encodeURIComponent(email)}`);
      await fetchWaitlist();
    } catch (error) {
      console.error('Error deleting email:', error);
      alert('Error removing email: ' + error.message);
    }
  };

  const handleSendNotification = async () => {
    if (!notificationSubject.trim() || !notificationMessage.trim()) {
      alert('Please fill in both subject and message');
      return;
    }

    if (!confirm(`Send notification to all ${emails.length} waitlist members?`)) {
      return;
    }

    setSendingNotification(true);
    setNotificationResult(null);

    try {
      const response = await axios.post(`${API_BASE}/waitlist/notify`, {
        subject: notificationSubject,
        message: notificationMessage
      });

      if (response.data.success) {
        setNotificationResult({
          success: true,
          message: `Notification queued for ${response.data.total} members!`
        });
        setNotificationSubject('');
        setNotificationMessage('');
        setTimeout(() => {
          setShowNotificationModal(false);
          setNotificationResult(null);
        }, 3000);
      }
    } catch (error) {
      console.error('Error sending notification:', error);
      setNotificationResult({
        success: false,
        message: error.response?.data?.error || 'Failed to send notification'
      });
    } finally {
      setSendingNotification(false);
    }
  };

  const filteredEmails = emails.filter(email =>
    email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="admin-container">
        <div className="admin-loading">Loading waitlist...</div>
      </div>
    );
  }

  return (
    <div className="admin-container">
      <div className="admin-content">
        <div className="admin-header">
          <h1>Parallax Beta Waitlist</h1>
          <p className="admin-subtitle">
            {emails.length} {emails.length === 1 ? 'signup' : 'signups'}
          </p>
        </div>

        <div className="admin-actions">
          <input
            type="text"
            placeholder="Search emails..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="admin-search"
          />
          <button 
            onClick={() => setShowNotificationModal(true)} 
            className="btn-notify"
            disabled={emails.length === 0}
            title={emails.length === 0 ? 'No emails to notify' : 'Send notification to all waitlist members'}
          >
            📧 Notify All
          </button>
          <button onClick={handleCopyEmails} className="btn-copy">
            📋 Copy All
          </button>
          <button onClick={handleExport} className="btn-export">
            📥 Export CSV
          </button>
          <button onClick={fetchWaitlist} className="btn-refresh">
            🔄 Refresh
          </button>
        </div>

        <div className="admin-list">
          {filteredEmails.length === 0 ? (
            <div className="admin-empty">
              {searchTerm ? 'No emails match your search' : 'No signups yet'}
            </div>
          ) : (
            filteredEmails.map((email, index) => (
              <div key={email} className="admin-item">
                <span className="item-number">{index + 1}</span>
                <span className="item-email">{email}</span>
                <button
                  onClick={() => handleDelete(email)}
                  className="btn-delete"
                  title="Remove from waitlist"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        {filteredEmails.length > 0 && (
          <div className="admin-footer">
            <p>Showing {filteredEmails.length} of {emails.length} emails</p>
            <p className="admin-hint">
              💡 Tip: Export CSV for use in email marketing tools
            </p>
          </div>
        )}

        {/* Notification Modal */}
        {showNotificationModal && (
          <div className="admin-modal-overlay" onClick={() => !sendingNotification && setShowNotificationModal(false)}>
            <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
              <div className="admin-modal-header">
                <h2>Send Notification to Waitlist</h2>
                <button 
                  onClick={() => setShowNotificationModal(false)} 
                  className="modal-close"
                  disabled={sendingNotification}
                >
                  ×
                </button>
              </div>
              
              <div className="admin-modal-content">
                {notificationResult && (
                  <div className={`notification-result ${notificationResult.success ? 'success' : 'error'}`}>
                    {notificationResult.message}
                  </div>
                )}
                
                <div className="form-group">
                  <label>Subject:</label>
                  <input
                    type="text"
                    value={notificationSubject}
                    onChange={(e) => setNotificationSubject(e.target.value)}
                    placeholder="e.g., Parallax Beta is Now Live!"
                    disabled={sendingNotification}
                    className="form-input"
                  />
                </div>
                
                <div className="form-group">
                  <label>Message:</label>
                  <textarea
                    value={notificationMessage}
                    onChange={(e) => setNotificationMessage(e.target.value)}
                    placeholder="Enter your message here..."
                    rows={8}
                    disabled={sendingNotification}
                    className="form-textarea"
                  />
                  <small>This will be sent to all {emails.length} waitlist members</small>
                </div>
              </div>
              
              <div className="admin-modal-footer">
                <button 
                  onClick={() => setShowNotificationModal(false)} 
                  className="btn-cancel"
                  disabled={sendingNotification}
                >
                  Cancel
                </button>
                <button 
                  onClick={handleSendNotification} 
                  className="btn-send"
                  disabled={sendingNotification || !notificationSubject.trim() || !notificationMessage.trim()}
                >
                  {sendingNotification ? 'Sending...' : `📧 Send to ${emails.length} Members`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default WaitlistAdmin;
