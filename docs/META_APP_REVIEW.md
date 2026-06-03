# Meta App Review — `public_profile` & `pages_show_list`

## Why you see API call counts but no green Completed

On **developers.facebook.com → Review → Testing**, Meta shows two different things:

| UI | Meaning |
|----|---------|
| **"10,000+ API test call(s)"** | Total Graph API traffic using that permission (often from **all** live users) |
| **Green "Completed"** | Meta accepted a **valid test** from an **App Admin, Developer, or Tester** within the last **30 days** |

So many calls without a green tick usually means:

1. Logins are from normal customers, not from someone listed under **App roles**
2. Only server-side calls were counted; Meta sometimes wants **browser** calls too
3. Dashboard has not refreshed yet (**up to 24 hours**)

The CSP errors in Meta’s own Testing page console are on **Facebook’s site**, not FBCast Pro — they do not block your app’s API calls.

## What FBCast Pro does

On Facebook connect and page sync, the app runs:

- `GET /me?fields=id,name` → `public_profile`
- `GET /me/accounts?fields=id,name` → `pages_show_list`

From **both** the browser and your server (`/api/meta/review-tests`).

## What you should do

1. Open [Meta for Developers](https://developers.facebook.com/) → your app → **App roles**
2. Add your Facebook account as **Administrator**, **Developer**, or **Tester**
3. In FBCast Pro: **Settings → Meta App Review → Run review test calls**
4. Confirm status shows **App role account: YES** and both permissions **OK**
5. In Meta: **Review → Testing** — wait up to **24 hours** for green Completed
6. Optional: use **Open Graph API Explorer** on the Testing page while logged in as that role account

## Required OAuth scopes

Already requested by the app:

- `public_profile`
- `pages_show_list`

## Environment

Use the same Graph version everywhere (default `v21.0` via `FB_GRAPH_VERSION` in `.env`).
