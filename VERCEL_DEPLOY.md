# Vercel Deployment Guide

## Quick Setup

### Option 1: Deploy Full Stack to Vercel (Recommended) ✅ READY

Your project is now configured for Vercel deployment!

Vercel can host both your frontend and backend using serverless functions.

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm i -g vercel
   ```

2. **Login to Vercel**:
   ```bash
   vercel login
   ```

3. **Link your project**:
   ```bash
   vercel link
   ```

4. **Deploy**:
   ```bash
   vercel
   ```
   
   Or deploy to production:
   ```bash
   vercel --prod
   ```

4. **Set Environment Variables in Vercel Dashboard**:
   Go to your project on Vercel → Settings → Environment Variables
   
   Add all these variables:
   ```
   TRADOVATE_USERNAME=
   TRADOVATE_PASSWORD=
   TRADOVATE_APP_ID=Parallax
   TRADOVATE_CID=
   TRADOVATE_SECRET=
   USE_DEMO=true
   MOCK_MODE=true
   PORT=3001
   
   EMAIL_ENABLED=true
   EMAIL_SERVICE=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=hello.uply@gmail.com
   SMTP_PASSWORD=your-app-password
   EMAIL_FROM=hello.uply@gmail.com
   EMAIL_FROM_NAME=Parallax Team
   ```

5. **Update Vite Config for Production**:
   The `vite.config.js` proxy won't work on Vercel. The API calls will automatically go to `/api/*` routes.

### Option 2: Separate Deployments (More Control)

**Frontend on Vercel:**
- Just the React app
- Set `VITE_API_URL` environment variable if backend is elsewhere

**Backend on Railway/Render/Heroku:**
- Deploy `server/index.js` separately
- Update frontend API calls to point to backend URL

## Important Notes

1. **WebSocket Support**: 
   - Vercel serverless functions don't support WebSocket connections
   - The WebSocket server in `server/index.js` won't work on Vercel
   - You may need to use a service like Ably, Pusher, or deploy backend separately for WebSocket support

2. **Environment Variables**:
   - Never commit `.env` file
   - Add all variables in Vercel dashboard
   - Use different values for Production/Preview/Development

3. **Build Settings**:
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`

4. **API Routes**:
   - All `/api/*` routes will be handled by `server/index.js`
   - Make sure Express routes are compatible with serverless format

## After Deployment

1. Test the waitlist signup page
2. Test email sending (check spam folder)
3. Test admin panel at `/admin/waitlist`
4. Monitor logs in Vercel dashboard

## Troubleshooting

- **API routes not working**: Check that `vercel.json` routes are correct
- **Environment variables not loading**: Make sure they're set in Vercel dashboard, not just `.env`
- **Build fails**: Check build logs in Vercel dashboard
- **WebSocket errors**: Backend needs separate deployment or use polling instead
