# FBCast Pro — Project Architecture

## Overview

Single-page application (SPA) served by **Node.js + Express**. The marketing landing and authenticated dashboard share `public/index.html`. Real-time features use **Socket.IO**.

## Directory layout

```
fb-page-manager-main/
├── docs/                      # Project documentation
├── public/                    # Static frontend (Express static root)
│   ├── index.html             # SPA shell (landing + dashboard)
│   ├── admin2.html            # Admin console
│   ├── oauth_callback.html    # OAuth redirect helper → /oauth_callback.php
│   ├── assets/
│   │   ├── css/               # Stylesheets (layered: base → features → themes)
│   │   └── js/
│   │       ├── core/          # fb_api.js, web_ui.js (broadcast + Graph API)
│   │       ├── app-shell.js   # View router
│   │       ├── index-page.js  # Landing, theme, OAuth UX
│   │       ├── messenger.js   # Inbox UI (msng-*)
│   │       └── …              # Feature modules (billing, analytics, …)
│   ├── images/                # Brand & OG images
│   └── pics/                  # Landing avatars
├── server/
│   ├── index.js               # Process entry
│   ├── createApp.js           # Express app + static + middleware
│   ├── bootstrap.js           # HTTP server + Socket.IO
│   ├── db.js                  # MySQL access
│   ├── config/                # env, paths, plans
│   ├── middleware/            # auth, csrf, session, legacy PHP aliases
│   ├── routes/
│   │   ├── register.js        # Orchestrates domain routers
│   │   ├── lib/register-context.js
│   │   ├── domains/           # webhook, oauth, admin, inbox-legacy, broadcast, spa, …
│   │   ├── billing.js         # Stripe
│   │   └── composer.js        # Route wiring
│   ├── messenger/             # Messenger API module
│   ├── services/              # AI, billing, entitlements, meta review
│   └── socket/                # Socket.IO handlers
├── uploads/                   # User uploads (gitignored)
└── package.json
```

## Frontend load order

CSS loads in cascade: `index.css` → brand (`fbc-theme`) → components → view CSS → `theme-light.bundle.css` (merged light overrides) → `theme-final` → `saas-polish` → `ui-overhaul`. `messenger.js` loads on demand when entering the Messenger view (`app-shell.js`).

JS: `user-data` → `index-page` → `ui-components` → `app-shell` → billing → **core** (`fb_api`, `web_ui`) → feature modules → inline helpers. `messenger.js` is injected when the Messenger view opens.

## PHP compatibility URLs

Meta OAuth and legacy clients use paths like `/oauth_callback.php`. These are **Node routes** (see `server/middleware/legacy-php.js`), not PHP files.

## Removed legacy (2025 cleanup)

- `_archive/` — old PHP app, dead server, multi-page HTML
- `inbox.js` / `inbox.css` — superseded by `messenger.js`
- Unused npm: `crypto-js`, `express-mysql-session`
- Orphan images and `payment_status.html` (Stripe returns to `/?payment=…`)

