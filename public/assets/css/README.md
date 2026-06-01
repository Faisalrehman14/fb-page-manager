# Stylesheets

Load order is defined in `public/index.html` (do not reorder without visual QA).

| Layer | Files | Purpose |
|-------|--------|---------|
| Base | `index.css`, `fbc-theme.css` | Reset, landing, legacy broadcast |
| Components | `ui-components.css`, `design-system.css` | Shared UI primitives |
| Layout | `app-shell.css`, `saas-topbar.css`, `app-mobile-nav.css` | Dashboard chrome |
| Views | `messenger.css`, `scheduling.css`, `home-dashboard.css`, … | Per-screen UI |
| Themes | `theme-light.bundle.css`, `theme-final.css` | Light mode overrides (single merged bundle) |
| Polish | `saas-polish.css`, `ui-overhaul.css`, `production-ui.css` | Final contrast, fixes & production polish |

New view-specific styles: add a dedicated file and link it before `theme-final.css`.
