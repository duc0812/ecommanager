# Design artwork on Google Drive

**Status:** approved in chat 2026-10-10 (personal Gmail → OAuth, `drive.file` scope).

## Goal

When a designer uploads artwork (or a master artwork for a product profile), the file goes straight to the company Google Drive, in a folder per order and task, and the app records it. Files bigger than the VPS can buffer upload directly from the browser to Google. Approved files get an "anyone with the link" permission so the supplier CSV carries a Drive link the factory can open — the same convention the Trello flow uses today.

## Connection

- OAuth 2.0 web client created by the owner in Google Cloud Console (Drive API enabled, consent screen External, published "In production", scope `https://www.googleapis.com/auth/drive.file` — non-sensitive, so no verification and no 7-day token expiry). Redirect URIs: `http://localhost:3002/api/auth/google/callback` and `https://pod.thecrafthousellc.com/api/auth/google/callback`.
- `AppSetting` keys: `google.oauth.clientId`, `google.oauth.clientSecret`, `google.drive.refreshToken`, `google.drive.email`, `google.drive.rootFolderId`. Secrets never returned by GET routes (masked), only written by SUPERADMIN.
- Routes: `GET /api/auth/google` (SUPERADMIN, builds the consent URL with `access_type=offline&prompt=consent`, state stored like the Shopify OAuth state) → `GET /api/auth/google/callback` (`PUBLIC` in `API_ACCESS_RULES`, validates state, exchanges code, stores refresh token + email, creates the root folder "Design Studio" if missing); `GET/PUT/DELETE /api/setup/google-drive` (SUPERADMIN: client id/secret, status, disconnect).
- `src/lib/google-drive.ts` (plain `fetch` to the REST API, no `googleapis` dependency): `getAccessToken()` (refresh + in-memory cache until expiry), `ensureFolder(parentId, name)` (search by name+parent among app-created folders, else create), `folderForTask({ storeName, placedAt, orderNumber, taskKey })` → `Design Studio/<Store>/<YYYY-MM>/<Order>/<TaskKey>`, `startResumableUpload({ name, mimeType, size, parentId, origin })` → session URL (initiation request carries `Origin` so the browser can PUT cross-origin), `getFile(id, fields)`, `streamFile(id)` (`alt=media` → `Response.body`, never buffered), `shareAnyoneReader(id)`, `deleteFile(id)`.
- Setup page: a "Google Drive" card on `/setup` showing connected account, root folder link, Connect/Disconnect, and the client id/secret form.

## Upload flow

1. Browser `POST /api/design-studio/lines/[lineId]/artwork/session` `{ printArea, fileName, size, mimeType }` → server validates type/size (same allow-list as today, limit raised to 2 GB), resolves version, ensures the folder, starts a resumable upload named `v<version>-<safeFileName>`, stores a pending row in `DesignArtworkUpload` (`id, orderId, shopifyLineId, printArea, version, fileName, mimeType, size, sessionUrl, folderId, createdById, createdAt, completedAt?`) and returns `{ uploadId, sessionUrl }`.
2. Browser `PUT sessionUrl` with the file (progress bar via XHR `upload.onprogress`). Google returns the file resource (`id`).
3. Browser `POST /api/design-studio/artwork/complete` `{ uploadId, driveFileId }` → server `getFile` checks the file's parent is the recorded folder and the name matches, reads `imageMediaMetadata.width/height` when present, creates the `DesignArtwork` row (`storage: 'DRIVE'`, `driveFileId`, `driveWebViewLink`), marks the upload complete.
- When Drive is not connected, the v1 local path is used unchanged (`storage: 'LOCAL'`), so local development works without Google.

## Schema

`DesignArtwork` gains `storage String @default("LOCAL")`, `driveFileId String?`, `driveWebViewLink String?`; `storagePath` becomes nullable. New `DesignArtworkUpload` as above. Migration + `SCHEMA_VERSION` bump.

## Serving and approving

- `GET /api/design-studio/file/[artworkId]`: `LOCAL` → as today; `DRIVE` → stream via `streamFile` with the stored mime (from the validated extension), `Content-Disposition: inline`; PSD/ZIP → 302 to `driveWebViewLink`.
- On DONE (`updateLine(done:true)`), for a `DRIVE` artwork: `shareAnyoneReader(fileId)` then `designDriveLink = driveWebViewLink` (a `drive.google.com` URL, so the existing export and Trello attachment logic keep working). `LOCAL` keeps the app URL.
- Reopen does not revoke the share (the factory may already have the link).

## Failure handling

Drive errors surface as `{ error }` with the Google message; a failed session leaves the pending row (cleaned after 24 h by the next session request). `complete` is idempotent per `uploadId`. A token refresh failure marks the connection "cần kết nối lại" in Setup and uploads fall back with a clear error (not silently to local).

## Tests

`google-drive.ts` against a mocked `fetch` (token refresh caching, folder reuse vs create, resumable initiation headers incl. `Origin`, share call); session route validation and version allocation; complete route rejects a file outside the folder and is idempotent; serve route streams Drive and redirects PSD; `updateLine` shares and stores the web link; fallback to LOCAL when not connected; callback rejects a bad state.
