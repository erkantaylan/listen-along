# OAuth Setup Guide

Listen Along uses Google and GitHub OAuth for authentication. You need to create OAuth apps on both platforms to get the required credentials.

## Environment Variables

Add these to your `.env` file in the `backend/` directory:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
SESSION_SECRET=any-random-string-here
```

---

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)

2. Create a new project (or select an existing one)
   - Click the project dropdown at the top bar
   - Click **New Project**
   - Name it (e.g. "Listen Along") and click **Create**

3. Enable the Google+ API
   - Go to **APIs & Services > Library**
   - Search for "Google+ API" or "Google Identity"
   - Click **Enable**

4. Configure the OAuth consent screen
   - Go to **APIs & Services > OAuth consent screen**
   - Choose **External** (unless you have a Google Workspace org)
   - Fill in:
     - **App name**: Listen Along
     - **User support email**: your email
     - **Developer contact email**: your email
   - Click **Save and Continue**
   - On **Scopes**, click **Add or Remove Scopes**, select `email` and `profile`, then **Save and Continue**
   - On **Test users**, add your own Google email, then **Save and Continue**

5. Create OAuth credentials
   - Go to **APIs & Services > Credentials**
   - Click **Create Credentials > OAuth client ID**
   - Application type: **Web application**
   - Name: "Listen Along"
   - **Authorized JavaScript origins**:
     - `http://localhost:3000` (for local dev)
     - `https://yourdomain.com` (for production)
   - **Authorized redirect URIs**:
     - `http://localhost:3000/auth/google/callback` (for local dev)
     - `https://yourdomain.com/auth/google/callback` (for production)
   - Click **Create**

6. Copy the **Client ID** and **Client Secret** into your `.env` file

> **Note**: While in "Testing" mode, only emails listed as test users can log in. To allow anyone, go to OAuth consent screen and click **Publish App**.

---

## GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)

2. Click **OAuth Apps** in the left sidebar

3. Click **New OAuth App**

4. Fill in the form:
   - **Application name**: Listen Along
   - **Homepage URL**: `http://localhost:3000` (or your production URL)
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
   - Click **Register application**

5. On the app page:
   - Copy the **Client ID** (shown at the top)
   - Click **Generate a new client secret**
   - Copy the **Client Secret** immediately (it's only shown once)

6. Paste both into your `.env` file

> **For production**: Update the Homepage URL and callback URL to your production domain (e.g. `https://yourdomain.com/auth/github/callback`).

---

## Verify

After setting up both providers, restart the backend:

```bash
cd backend
npm start
```

You should see in the logs:
```
Google OAuth strategy configured
GitHub OAuth strategy configured
```

If a provider is not configured, you'll see:
```
Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
```

## User Approval

New users who log in land in **pending** status. You need to approve them from the dashboard before they can use the app. The first user is auto-approved.
