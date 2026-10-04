# GitHub Setup & Deployment Guide

## Step 1: Create GitHub Repository

1. Go to https://github.com
2. Click the **"+"** icon (top right) → **"New repository"**
3. Name it: `parallax` (or any name you want)
4. **DO NOT** initialize with README, .gitignore, or license
5. Click **"Create repository"**
6. Copy the repository URL (e.g., `https://github.com/yourusername/parallax.git`)

## Step 2: Initialize Git in Your Project

Open terminal in your project folder and run:

```bash
# Initialize git repository
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit: Parallax Trade Copier MVP with waitlist"

# Add your GitHub repository as remote
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 3: If You Already Have Files on GitHub

If the repository already exists with files:

```bash
git init
git add .
git commit -m "Initial commit: Parallax Trade Copier MVP with waitlist"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
git pull origin main --allow-unrelated-histories
# Fix any conflicts if needed, then:
git push -u origin main
```

## Important: Before Pushing

Make sure your `.env` file is in `.gitignore` (it already is ✅)

Your `.env` file contains sensitive credentials and should **NEVER** be pushed to GitHub.

## Step 4: Deploy to Vercel

After pushing to GitHub:

1. Go to https://vercel.com
2. Click **"Add New..."** → **"Project"**
3. Import your GitHub repository
4. Vercel will auto-detect your settings
5. Add environment variables in Vercel dashboard (see VERCEL_DEPLOY.md)
6. Click **"Deploy"**

## Quick Commands Reference

```bash
# Check status
git status

# Add files
git add .

# Commit changes
git commit -m "Your commit message"

# Push to GitHub
git push

# Pull latest changes
git pull

# See what files will be committed
git status
```

## Troubleshooting

**If git is not installed:**
- Mac: `git` should be pre-installed, or install Xcode Command Line Tools
- Or install GitHub Desktop: https://desktop.github.com

**If authentication fails:**
- Use GitHub Personal Access Token instead of password
- Generate token: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
- Or use SSH keys: https://docs.github.com/en/authentication/connecting-to-github-with-ssh

**If you get "fatal: remote origin already exists":**
```bash
git remote remove origin
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
```
