# Facebook Page Inbox - Customer Support Demo

A production-ready demo application for Meta (Facebook) App Review to request the following permissions:
- `pages_show_list`
- `pages_read_engagement`  
- `pages_messaging`

## 🎯 Purpose

This is a **customer support inbox** for Facebook Page admins. It allows Page administrators to:

1. Sign in with Facebook
2. Select a Page they manage
3. View the Page's conversation inbox
4. Open individual conversation threads
5. Manually type and send a reply to that conversation

## ⚠️ Important Restrictions

This application **enforces strict compliance** with Facebook's messaging policies:

- ✅ **Reply-only**: Can only respond to customers who messaged first
- ✅ **Manual sending**: Each message must be manually typed and sent from the UI
- ✅ **Rate limited**: Maximum 1 message per 3 seconds per thread
- ❌ **NO bulk messaging**
- ❌ **NO broadcast campaigns**
- ❌ **NO automation or bots**
- ❌ **NO unsolicited messages**

## 📁 Project Structure

```
├── .env.example          # Environment variables template
├── README.md             # This file
├── public/               # Frontend (static files)
│   ├── index.html        # Home page with login
│   ├── dashboard.html    # Pages list
│   ├── inbox.html        # Conversations list
│   ├── thread.html       # Message thread view
│   ├── privacy.html      # Privacy Policy
│   ├── terms.html        # Terms of Service
│   ├── css/
│   │   └── styles.css    # Main stylesheet
│   └── js/
│       └── app.js        # Frontend JavaScript
└── server/               # Backend (Node.js/Express)
    ├── index.js          # Server entry point
    └── package.json      # Dependencies
```

## 🚀 Setup Instructions

### Prerequisites

- Node.js 18+ installed
- A Facebook Developer account
- A Facebook App configured for Login

### Step 1: Create a Facebook App

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Click "My Apps" → "Create App"
3. Select "Business" type
4. Name your app and create it
5. Add the "Facebook Login" product
6. Configure these settings in Facebook Login → Settings:
   - **Valid OAuth Redirect URIs**: `http://localhost:3000/api/auth/callback`
   - For production, add your production URL as well

### Step 2: Configure App Permissions

In your Facebook App Dashboard:
1. Go to "App Review" → "Permissions and Features"
2. Request these permissions:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_messaging`

### Step 3: Clone and Configure

```bash
# Navigate to project directory
cd "DEVELOPER WEBSITE"

# Copy environment template
cp .env.example .env

# Edit .env with your Facebook App credentials
nano .env  # or use your preferred editor
```

Your `.env` file should contain:

```env
FB_APP_ID=your_facebook_app_id
FB_APP_SECRET=your_facebook_app_secret
PORT=3000
SESSION_SECRET=generate_a_secure_random_string_here
BASE_URL=http://localhost:3000
```

### Step 4: Install Dependencies

```bash
cd server
npm install
```

### Step 5: Run the Application

```bash
# From the server directory
npm start

# Or for development with auto-reload
npm run dev
```

The application will be available at `http://localhost:3000`

## 🔐 Security Features

| Feature | Implementation |
|---------|----------------|
| **OAuth PKCE** | Authorization Code Flow with PKCE code challenge |
| **Server-side tokens** | Access tokens stored in server session only |
| **CSRF Protection** | Token-based CSRF protection on all POST requests |
| **HTTP-only cookies** | Session cookies not accessible via JavaScript |
| **Input validation** | Message length limits, empty message prevention |
| **Rate limiting** | 1 message per 3 seconds per thread |
| **Token revocation** | "Disconnect" button revokes Facebook permissions |

## 📖 API Routes

### Authentication
- `GET /api/csrf-token` - Get CSRF token
- `GET /api/auth/status` - Check authentication status
- `GET /api/auth/login` - Initiate OAuth flow
- `GET /api/auth/callback` - OAuth callback handler
- `POST /api/auth/logout` - Logout and revoke tokens

### Pages & Conversations
- `GET /api/pages` - Get user's Facebook Pages
- `GET /api/pages/:pageId/conversations` - Get conversations for a page
- `GET /api/threads/:threadId/messages` - Get messages in a thread
- `POST /api/threads/:threadId/reply` - Send a reply (rate limited)

## 🎬 Demo Walkthrough for Meta App Review

Follow this exact flow when recording your screencast for App Review:

### Scene 1: Home Page (0:00-0:20)
1. Show the home page at `http://localhost:3000`
2. Point out the use-case explanation: "Customer Support Portal"
3. Highlight the visible notice: "Only reply to customers who messaged first"
4. Show links to Privacy Policy and Terms of Service
5. Click "Connect with Facebook" button

### Scene 2: Facebook Login (0:20-0:40)
1. Show the Facebook OAuth dialog
2. Point out the requested permissions:
   - pages_show_list
   - pages_read_engagement
   - pages_messaging
3. Complete the login/authorization flow
4. Show redirect back to the application

### Scene 3: Dashboard - Select Page (0:40-1:00)
1. Show the dashboard with your Facebook Pages listed
2. Point out the "No bulk messaging" reminder banner
3. Hover over a Page to show it's selectable
4. Click on a Page to open its inbox

### Scene 4: Inbox - View Conversations (1:00-1:30)
1. Show the conversations list for the selected Page
2. Point out the notice: "Only conversations where you can reply are shown"
3. Show conversation previews (participant name, last message snippet)
4. Explain: "These are customers who messaged the Page first"
5. Click on a specific conversation to open it

### Scene 5: Thread - View Messages (1:30-2:00)
1. Show the full conversation thread
2. Point out incoming messages (from customer) vs outgoing (from Page)
3. Show the compose area at the bottom
4. Highlight the notice: "Only reply to customers who messaged first. No unsolicited or bulk messages."
5. Note the character counter (max 2000)

### Scene 6: Send a Reply (2:00-2:30)
1. Type a test reply in the compose box
2. Show the character counter updating
3. Click the Send button
4. Show the success message
5. Show the sent message appearing in the thread

### Scene 7: Rate Limit Demo (2:30-2:50)
1. Immediately try to send another message
2. Show the rate limit error: "Please wait X seconds before sending another message"
3. Wait for the cooldown
4. Send another message successfully
5. Explain: "This prevents spam and enforces responsible messaging"

### Scene 8: Disconnect (2:50-3:00)
1. Click the "Disconnect" button in the header
2. Show redirect to home page
3. Explain: "This revokes all Facebook permissions"

### Key Points to Emphasize in Screencast

- ✅ "This is a customer support tool for responding to existing conversations"
- ✅ "Users can ONLY reply to customers who messaged first"
- ✅ "There is no way to start new conversations or send unsolicited messages"
- ✅ "No bulk messaging - each message is manually typed and sent one at a time"
- ✅ "Rate limiting prevents spam - maximum 1 message per 3 seconds"
- ✅ "Users can disconnect at any time, which revokes all permissions"

## 📋 App Review Submission Checklist

Before submitting for App Review:

- [ ] Privacy Policy is accessible at `/privacy.html`
- [ ] Terms of Service is accessible at `/terms.html`
- [ ] App description clearly states customer support use-case
- [ ] Screencast follows the demo walkthrough above
- [ ] Test with a real Facebook Page that has conversations
- [ ] Verify all permissions work correctly
- [ ] HTTPS enabled for production deployment

## 🛠️ Troubleshooting

### "Invalid redirect URI" error
- Ensure your OAuth callback URL exactly matches what's in Facebook App settings
- Include the full path: `http://localhost:3000/api/auth/callback`

### "Pages not showing" 
- Ensure you have admin access to at least one Facebook Page
- Verify `pages_show_list` permission is granted

### "Conversations not loading"
- Ensure `pages_read_engagement` permission is granted
- The Page must have existing conversations from customers

### "Cannot send messages"
- Ensure `pages_messaging` permission is granted
- Can only reply to conversations started by customers
- Check rate limit hasn't been exceeded
- Verify the 24-hour messaging window hasn't expired

## 📝 License

MIT License - See LICENSE file for details

## 🤝 Support

For questions about this demo or the App Review process:
- Facebook Developer Documentation: https://developers.facebook.com/docs/
- Graph API Explorer: https://developers.facebook.com/tools/explorer/
