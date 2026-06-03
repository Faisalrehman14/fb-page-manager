# Railway deployment

## Service settings

| Setting | Value |
|--------|--------|
| **Root Directory** | *(leave empty — project root)* |
| **Branch** | `main` or `binance-pay` |
| **Start Command** | `npm start` *(or leave empty — uses `railway.json`)* |
| **Healthcheck path** | `/api/health` |

## Required variables

Set in Railway → your app service → **Variables**:

```
FB_APP_ID=
FB_APP_SECRET=
SESSION_SECRET=<random 32+ chars>
SITE_URL=https://your-app.up.railway.app
APP_ENV=production
WEBHOOK_VERIFY_TOKEN=
```

## MySQL

1. Add a **MySQL** plugin to the project.
2. On the **app** service, add variable:  
   `DATABASE_URL=${{MySQL.DATABASE_URL}}`  
   (use *Reference* → pick your MySQL service → `DATABASE_URL`)
3. Redeploy.

Without `DATABASE_URL`, the app still starts but login/data will not persist.

## Deploy failed?

1. **Deploy logs** → look for `Cannot find module` → build did not run `npm ci`; redeploy.
2. **Healthcheck failed** → ensure start command is `npm start` and path `/api/health` returns 200.
3. **Wrong branch** → Settings → Source → branch must include `server/index.js` (not old `server.js` only).
4. **Wrong root** → Root Directory must be empty unless the repo is a monorepo.

## Binance / Stripe webhooks

After deploy, set:

- `SITE_URL` to your Railway public URL
- Stripe webhook: `https://<domain>/api/billing/webhook`
- Binance webhook: `https://<domain>/api/billing/webhook/binance`
