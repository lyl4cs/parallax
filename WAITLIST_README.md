# Beta Waitlist System

Parallax now includes a beta waitlist system to collect email addresses from users before the beta launch.

## Features

- **Public Waitlist Page** - Clean, professional signup form
- **Email Validation** - Prevents duplicate signups
- **Automatic Email Confirmation** - Users receive welcome email upon signup
- **Admin Dashboard** - View and manage signups
- **Bulk Notifications** - Send emails to all waitlist members from admin panel
- **CSV Export** - Export emails for use in email marketing tools
- **Copy to Clipboard** - Quick copy of all emails

## URLs

### Public Signup Pages
- `http://localhost:3000/waitlist` - Waitlist signup page
- `http://localhost:3000/beta` - Alternative URL
- `http://localhost:3000/?waitlist=true` - Query parameter option

### Admin Dashboard
- `http://localhost:3000/admin/waitlist` - View and manage waitlist
- `http://localhost:3000/?admin=waitlist` - Query parameter option

**Admin Features:**
- View all waitlist signups
- Search/filter emails
- Send bulk notifications to all members
- Export to CSV
- Copy emails to clipboard
- Delete individual emails

## API Endpoints

### POST /api/waitlist
Add an email to the waitlist.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully added to waitlist",
  "total": 42
}
```

### GET /api/waitlist
Get all emails on the waitlist (for admin).

**Response:**
```json
{
  "success": true,
  "emails": ["user1@example.com", "user2@example.com"],
  "count": 2
}
```

### GET /api/waitlist/export
Export waitlist as CSV file.

**Response:** CSV file download

### DELETE /api/waitlist/:email
Remove an email from the waitlist (for admin).

**Response:**
```json
{
  "success": true,
  "message": "Email removed from waitlist"
}
```

## Usage

1. **Share the waitlist URL:**
   - Send users to `http://localhost:3000/waitlist` or your production URL
   - They can sign up with their email

2. **View signups:**
   - Visit `http://localhost:3000/admin/waitlist`
   - See all emails in a searchable list
   - Search, copy, or export emails

3. **Export for email marketing:**
   - Click "Export CSV" to download all emails
   - Import into Mailchimp, SendGrid, or any email service

4. **Send notifications:**
   - Click "📧 Notify All" in the admin panel
   - Enter subject and message
   - Send to all waitlist members instantly
   - Or export CSV to use with external email services

## Data Storage

Currently uses in-memory storage (Set). For production, consider:
- Database storage (PostgreSQL, MongoDB)
- File-based storage with JSON
- Integration with email service APIs (Mailchimp, SendGrid)

## Email Functionality

Parallax includes automatic email confirmations and bulk notification features.

### Setup Email Service

See [EMAIL_SETUP.md](./EMAIL_SETUP.md) for detailed setup instructions.

**Quick Setup (Gmail):**
1. Enable email in `.env`:
```env
EMAIL_ENABLED=true
EMAIL_SERVICE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com
EMAIL_FROM_NAME=Parallax Team
```

2. Restart server: `npm run server:clean`

### Automatic Confirmations

When someone signs up for the waitlist, they automatically receive a welcome email (if `EMAIL_ENABLED=true`).

### Send Notifications

From the admin panel:
1. Click "📧 Notify All" button
2. Enter subject and message
3. Click "Send to X Members"

All waitlist members will receive the notification email.

**Note:** If email is not configured, waitlist signups still work - just no emails will be sent.

## Future Enhancements

- Integration with email marketing services (Mailchimp, SendGrid API)
- Analytics dashboard
- Custom fields (name, company, etc.)
- Email templates customization
