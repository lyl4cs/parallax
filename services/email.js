import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Email service configuration
let transporter = null;

// Initialize email transporter
export function initEmailService() {
  const emailEnabled = process.env.EMAIL_ENABLED === 'true';
  
  if (!emailEnabled) {
    console.log('📧 Email service disabled (EMAIL_ENABLED=false or not set)');
    console.log('   Set EMAIL_ENABLED=true in .env to enable email confirmations');
    return false;
  }

  const emailService = process.env.EMAIL_SERVICE?.toLowerCase() || 'smtp';
  
  try {
    if (emailService === 'sendgrid') {
      // SendGrid configuration
      if (!process.env.SENDGRID_API_KEY) {
        console.warn('⚠️  EMAIL_ENABLED=true but SENDGRID_API_KEY not set');
        return false;
      }
      
      transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        auth: {
          user: 'apikey',
          pass: process.env.SENDGRID_API_KEY
        }
      });
      console.log('📧 Email service initialized (SendGrid)');
    } else {
      // Standard SMTP configuration
      if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
        console.warn('⚠️  EMAIL_ENABLED=true but SMTP_USER or SMTP_PASSWORD not set');
        console.warn('   Please configure SMTP credentials in .env to enable email');
        return false;
      }
      
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD
        }
      });
      console.log(`📧 Email service initialized (SMTP: ${process.env.SMTP_HOST || 'smtp.gmail.com'})`);
    }
    
    // Test connection (non-blocking)
    transporter.verify().then(() => {
      console.log('✅ Email service verified and ready');
    }).catch(err => {
      console.warn('⚠️  Email service connection verification failed:', err.message);
    });
    
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize email service:', error.message);
    return false;
  }
}

// Send confirmation email to new waitlist signup
export async function sendWaitlistConfirmation(email) {
  if (!transporter) {
    console.log('⚠️  Email service not initialized, skipping confirmation email');
    return { success: false, error: 'Email service not configured' };
  }

  const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@parallax.app';
  const fromName = process.env.EMAIL_FROM_NAME || 'Parallax Team';

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: email,
    subject: 'Welcome to Parallax Beta Waitlist! 🚀',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Parallax Beta</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 32px;">Parallax</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Trade Copier</p>
        </div>
        
        <div style="background: white; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h2 style="color: #333; margin-top: 0;">You're on the list! 🎉</h2>
          
          <p>Hi there,</p>
          
          <p>Thanks for joining the <strong>Parallax Beta Waitlist</strong>!</p>
          
          <p>You'll be among the first to know when we launch the beta. Here's what you can expect:</p>
          
          <ul style="padding-left: 20px; color: #555;">
            <li>⚡ <strong>Real-time trade copying</strong> - Copy trades instantly from leader accounts</li>
            <li>📊 <strong>Position sync</strong> - Keep all accounts in sync automatically</li>
            <li>🔒 <strong>Secure & reliable</strong> - Enterprise-grade security</li>
            <li>⚙️ <strong>Advanced settings</strong> - Customize size multipliers, SL/TP copying, and more</li>
          </ul>
          
          <p>Im trying my hardest to make Parallax the best trade copier available. I'm going to be testing this relentlessly in the next coming weeks to ensure it's stable and reliable for everyone.</p>
          
          <div style="margin: 30px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid #667eea;">
            <p style="margin: 0; color: #555; font-size: 14px;">
              <strong>What's next?</strong><br>
              I'll send you an email as soon as I'm sure the site is stable and ready for beta testers (I going to make this 100% free in the testing phase).
            </p>
          </div>
          
          <p style="margin-top: 30px;">Best regards,<br><strong> Parallax (layth)</strong></p>
        </div>
        
        <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
          <p>You're receiving this email because you signed up for the Parallax Beta Waitlist.</p>
          <p>If you didn't sign up, you can safely ignore this email.</p>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to Parallax Beta Waitlist! 🚀

You're on the list! 🎉

Hi there,

Thanks for joining the Parallax Beta Waitlist!

You'll be among the first to know when we launch the beta. Here's what you can expect:

⚡ Real-time trade copying - Copy trades instantly from leader accounts
📊 Position sync - Keep all accounts in sync automatically
🔒 Secure & reliable - Enterprise-grade security
⚙️ Advanced settings - Customize size multipliers, SL/TP copying, and more

Im trying my hardest to make Parallax the best trade copier available. I'm going to be testing this relentlessly in the next coming weeks to ensure it's stable and reliable for everyone.

What's next?
I'll send you an email as soon as I'm sure the site is stable and ready for beta testers (I going to make this 100% free in the testing phase).

Best regards,
Parallax (layth)

---
You're receiving this email because you signed up for the Parallax Beta Waitlist.
If you didn't sign up, you can safely ignore this email.
    `
  };

  try {
    console.log(`📧 Attempting to send confirmation email to: ${email}`);
    console.log(`   From: "${fromName}" <${fromEmail}>`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Confirmation email sent successfully to: ${email}`);
    console.log(`   Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send confirmation email to ${email}:`);
    console.error(`   Error: ${error.message}`);
    if (error.response) {
      console.error(`   Response: ${error.response}`);
    }
    if (error.code) {
      console.error(`   Error code: ${error.code}`);
    }
    return { success: false, error: error.message };
  }
}

// Send notification email to all waitlist members
export async function sendWaitlistNotification(subject, message) {
  if (!transporter) {
    return { success: false, error: 'Email service not configured' };
  }

  const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@parallax.app';
  const fromName = process.env.EMAIL_FROM_NAME || 'Parallax Team';

  return { success: true, emailService: 'ready' }; // Will be used by the endpoint
}

// Send email to multiple recipients
export async function sendBulkEmail(recipients, subject, htmlContent, textContent) {
  if (!transporter) {
    console.warn('⚠️  Email service not configured, cannot send bulk emails');
    return { success: 0, failed: 0, errors: [] };
  }

  const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@parallax.app';
  const fromName = process.env.EMAIL_FROM_NAME || 'Parallax Team';

  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  for (const email of recipients) {
    try {
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: email,
        subject: subject,
        html: htmlContent,
        text: textContent
      });
      results.success++;
      console.log(`✅ Email sent to: ${email}`);
    } catch (error) {
      results.failed++;
      results.errors.push({ email, error: error.message });
      console.error(`❌ Failed to send email to ${email}:`, error.message);
    }
    
    // Rate limiting: wait 100ms between emails to avoid overwhelming the server
    if (recipients.indexOf(email) < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}
