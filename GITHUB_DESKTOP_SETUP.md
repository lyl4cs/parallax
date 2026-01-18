# GitHub Desktop Setup Guide

## Step 1: Add Repository to GitHub Desktop

1. **Open GitHub Desktop**
2. Click **"File"** → **"Add Local Repository"**
3. Click **"Choose..."** and navigate to `/Users/layth/syncflow`
4. Click **"Add Repository"**

If it says "This directory does not appear to be a Git repository":
- Click **"Create a repository"**
- Name: `parallax` (or any name)
- Leave "Initialize this repository with a README" **unchecked**
- Local Path: Should show `/Users/layth/syncflow`
- Click **"Create Repository"**

## Step 2: Review Your Changes

You'll see all your files listed in GitHub Desktop. Review what's being added.

**Important:** Make sure `.env` is NOT in the list (it should be ignored). If you see it, you need to add it to `.gitignore`.

## Step 3: Create Your First Commit

1. At the bottom left, write a commit message:
   ```
   Initial commit: Parallax Trade Copier MVP with waitlist
   ```

2. Click **"Commit to main"** button

## Step 4: Publish to GitHub

1. Click the **"Publish repository"** button (top right)
2. **Name:** `parallax` (or your preferred name)
3. **Description:** (optional) "Trade Copier MVP - Parallax"
4. **Keep this code private:** (check if you want it private, uncheck for public)
5. Click **"Publish Repository"**

## Step 5: Push Future Changes

After your first publish, when you make changes:

1. GitHub Desktop will show changed files
2. Review the changes
3. Write a commit message (e.g., "Updated email template")
4. Click **"Commit to main"**
5. Click **"Push origin"** button (top right)

## After Publishing: Deploy to Vercel

Once your code is on GitHub:

1. Go to https://vercel.com
2. Click **"Add New..."** → **"Project"**
3. Click **"Import Git Repository"**
4. Find your `parallax` repository
5. Click **"Import"**
6. Vercel will auto-detect settings
7. Add environment variables (see VERCEL_DEPLOY.md)
8. Click **"Deploy"**

Your waitlist will be live! 🚀
