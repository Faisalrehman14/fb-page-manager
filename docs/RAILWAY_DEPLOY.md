# Railway deployment

## Service settings

| Setting | Value |
|--------|--------|
| **Root Directory** | *(leave empty — project root)* |
| **Branch** | `main` |
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

1. **Build image failed** → do not use custom `nixpacks.toml` with invalid `nixPkgs`. Node version is set via `package.json` → `"engines": { "node": "20" }` and `.nvmrc`. Let Nixpacks run default `npm install` (no custom `buildCommand`).
2. **Deploy logs** → look for `Cannot find module` → build did not install dependencies; redeploy.
3. **Healthcheck failed** → ensure start command is `npm start` and path `/api/health` returns 200.
4. **Wrong branch** → Settings → Source → branch must be `main` with `server/index.js`.
5. **Wrong root** → Root Directory must be empty unless the repo is a monorepo.

## Stripe webhooks

After deploy, set:

- `SITE_URL` to your Railway public URL
- Stripe webhook: `https://<domain>/api/billing/webhook`
