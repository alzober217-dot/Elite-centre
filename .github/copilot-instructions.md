# Project conventions

- This is a Vite + React JavaScript project. Keep page routes in `src/app/AppRouter.jsx` and reusable layouts/components in their existing directories.
- The interface is Arabic-first and right-to-left. Preserve `lang="ar"`, `dir="rtl"`, and the shared rules in `src/styles/rtl.css`.
- Grade, subject, teacher, and price records live in `server/catalog.json` and are served through the local API. Telegram changes are limited to IDs in `server/permissions.json`.
- Student authentication and file storage are intentionally unconfigured until a provider is selected.
- Keep credentials out of source control. Add only variable names to `.env.example`; put local values in an ignored `.env` file.
