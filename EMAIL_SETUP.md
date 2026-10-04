# Email Configuration Guide

Parallax supports email confirmations for waitlist signups and bulk notifications to waitlist members.

## Features

1. **Automatic Confirmation Emails** - Users receive a welcome email when they join the waitlist
2. **Bulk Notifications** - Admin can send notifications to all waitlist members from the admin panel

## Setup

### Option 1: Gmail (SMTP)

**⚠️ Important:** App Passwords require 2-Step Verification to be enabled first!

**Step 1: Enable 2-Step Verification**
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Under "Signing in to Google", click "2-Step Verification"
3. Follow the setup wizard to enable 2FA
4. You can use any method (phone, authenticator app, etc.)

**Step 2: Generate App Password** (only available after 2FA is enabled)
1. Go to [App Passwords](https://myaccount.google.com/apppasswords)
2. Select "App" → "Mail" → "Other (Custom name)"
3. Enter "Parallax" and click "Generate"
4. Copy the 16-character password (spaces don't matter)

**Step 3: Configure `.env` file:**
```env
EMAIL_ENABLED=true
EMAIL_SERVICE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-16-char-app-password
EMAIL_FROM=your-email@gmail.com
EMAIL_FROM_NAME=Parallax Team
```

### Option 2: SendGrid (Recommended - Easier Setup)

SendGrid is often easier than Gmail because:
- ✅ No App Passwords needed
- ✅ Just requires an API key
- ✅ Free tier (100 emails/day forever)
- ✅ Better for production use

**Setup Steps:**

1. Sign up at [SendGrid](https://sendgrid.com)
   - Free account gives 100 emails/day forever
   - No credit card required for free tier

2. Verify your sender email:
   - Go to Settings → Sender Authentication
   - Verify your email address (you'll receive a verification email)
   - For production: Set up Domain Authentication (recommended)

3. Create an API Key:
   - Go to Settings → API Keys
   - Click "Create API Key"
   - Give it a name (e.g., "Parallax Waitlist")
   - Set permissions to "Full Access" or "Mail Send" only
   - Copy the API key (you can only see it once!)

4. Add to your `.env` file:
```env
EMAIL_ENABLED=true
EMAIL_SERVICE=sendgrid
SENDGRID_API_KEY=your-sendgrid-api-key
EMAIL_FROM=your-verified-sender@domain.com
EMAIL_FROM_NAME=Parallax Team
```

### Option 3: Other SMTP Providers

Works with any SMTP provider (Outlook, Mailgun, etc.):

```env
EMAIL_ENABLED=true
EMAIL_SERVICE=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@domain.com
SMTP_PASSWORD=your-password
EMAIL_FROM=your-email@domain.com
EMAIL_FROM_NAME=Parallax Team
```

## Quick Start (No Email Setup Required)

You can test the waitlist **without email setup**:

```env
EMAIL_ENABLED=false
```

The app will work perfectly - waitlist signups will be saved, but no emails will be sent. This is perfect for development and testing.

You can always enable email later by setting `EMAIL_ENABLED=true` and configuring SMTP/SendGrid.

## Disable Email (Development)

To disable email functionality:

```env
EMAIL_ENABLED=false
```

The app will still work, but no emails will be sent. Waitlist signups will still be saved.

## Usage

### Automatic Confirmations

When someone signs up for the waitlist, they automatically receive a confirmation email (if EMAIL_ENABLED=true).

### Send Bulk Notifications

1. Go to Admin Panel: `http://localhost:3000/admin/waitlist` or `?admin=waitlist`
2. Click "📧 Notify All" button
3. Enter subject and message
4. Click "Send to X Members"

The notification will be sent to all waitlist members in the background.

## Testing

To test email functionality:

1. Ensure `EMAIL_ENABLED=true` in `.env`
2. Configure SMTP credentials
3. Restart the server: `npm run server:clean`
4. Sign up a test email at `http://localhost:3000/waitlist`
5. Check the inbox for confirmation email

## Troubleshooting

### "App passwords not available for your account"
**This happens when:**
- 2-Step Verification is not enabled
- Advanced Protection is enabled (which disables App Passwords)

**Solution:**
1. **Enable 2-Step Verification first:**
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Click "2-Step Verification" and set it up
   - Then App Passwords will become available

2. **If Advanced Protection is enabled:**
   - You'll need to use OAuth2 instead (more complex setup)
   - Or use a different email provider (SendGrid recommended)

### Alternative: Use SendGrid Instead (Easier Setup)
If Gmail App Passwords aren't working, SendGrid is often easier:
1. Sign up at [SendGrid](https://sendgrid.com) (free tier available)
2. Verify your sender email
3. Create an API key
4. Use the SendGrid configuration (see Option 2 above)

### "Email service not configured"
- Check that `EMAIL_ENABLED=true` in `.env`
- Verify SMTP credentials are correct
- Restart the server after changing `.env`

### Emails not sending
- Check server logs for error messages
- Verify SMTP credentials (especially app passwords for Gmail)
- Test SMTP connection using a mail client first
- For Gmail: You MUST use an App Password (not your regular password)
- Make sure 2-Step Verification is enabled before generating App Password

### Gmail authentication errors
- Use App Password, not your regular Gmail password
- Make sure 2-Step Verification is enabled first
- Check that `SMTP_USER` is your full email address
- Verify the App Password is copied correctly (spaces are OK)

## Rate Limiting

The email service includes rate limiting (100ms delay between emails) to avoid overwhelming SMTP servers. For large lists, emails are sent in the background.

## Email Templates

- **Confirmation Email**: Automatically sent when users join the waitlist
- **Notification Email**: Custom HTML email sent from admin panel

Both emails use HTML formatting with the Parallax branding and can be customized in `services/email.js`.
