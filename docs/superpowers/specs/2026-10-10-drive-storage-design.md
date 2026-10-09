# Design artwork on Google Drive

**Status:** approved in chat 2026-10-10 (personal Gmail → OAuth, `drive.file` scope).

## Goal

When a designer uploads artwork (or a master artwork for a product profile), the file goes straight to the company Google Drive, in a folder per order and task, and the app records it. Uploads go through the tool (200 MB cap) and the tool pushes them to Drive in chunks. Uploaded files get an "anyone with the link" permission so the supplier CSV carries a Drive link the factory can open — the same convention the Trello flow uses today.

## Connection

- OAuth 2.0 web client created by the owner in Google Cloud Console (Drive API enabled, consent screen External, published "In production", scope `https://www.googleapis.com/auth/drive.file` — non-sensitive, so no verification and no 7-day token expiry). Redirect URIs: `http://localhost:3002/api/auth/google/callback` and `https://pod.thecrafthousellc.com/api/auth/google/callback`.
- `AppSetting` keys: `google.oauth.clientId`, `google.oauth.clientSecret`, `google.drive.refreshToken`, `google.drive.email`, `google.drive.rootFolderId`. Secrets never returned by GET routes (masked), only written by SUPERADMIN.
- Routes: `GET /api/auth/google` (SUPERADMIN, builds the consent URL with `access_type=offline&prompt=consent`, state stored like the Shopify OAuth state) → `GET /api/auth/google/callback` (`PUBLIC` in `API_ACCESS_RULES`, validates state, exchanges code, stores refresh token + email, creates the root folder "Design Studio" if missing); `GET/PUT/DELETE /api/setup/google-drive` (SUPERADMIN: client id/secret, status, disconnect).
- `src/lib/google-drive.ts` (plain `fetch` to the REST API, no `googleapis` dependency): `getAccessToken()` (refresh + in-memory cache until expiry), `ensureFolder(parentId, name)` (search by name+parent among app-created folders, else create), `folderForTask({ storeName, placedAt, orderNumber, taskKey })` → `Design Studio/<Store>/<YYYY-MM>/<Order>/<TaskKey>`, `startResumableUpload({ name, mimeType, size, parentId, origin })` → session URL (initiation request carries `Origin` so the browser can PUT cross-origin), `getFile(id, fields)`, `streamFile(id)` (`alt=media` → `Response.body`, never buffered), `shareAnyoneReader(id)`, `deleteFile(id)`.
- Setup page: a "Google Drive" card on `/setup` showing connected account, root folder link, Connect/Disconnect, and the client id/secret form.

## Upload flow (revised 2026-10-10: designer uploads to the tool, the tool pushes to Drive)

1. Unchanged UI and route: `POST /api/design-studio/lines/[lineId]/artwork` multipart (`printArea`, `file`), 200 MB cap.
2. The server writes the bytes to a temp file under `storageRoot()/tmp`, then, when Drive is connected: ensures the task folder, starts a resumable upload (no `Origin` needed — server to Google), and PUTs the temp file in 8 MB chunks read from a file stream (`Content-Range`), never holding the whole file twice. On success: `shareAnyoneReader(fileId)`, create the `DesignArtwork` row (`storage: 'DRIVE'`, `driveFileId`, `driveWebViewLink`, width/height from the image probe), delete the temp file.
3. Drive not connected or the push fails: move the temp file into the v1 local layout and create a `LOCAL` row; the response carries `warning` ("Chưa đẩy được lên Drive: …") which the slot shows. A later "Đẩy lên Drive" action on a LOCAL artwork retries the push.
4. The response returns the artwork including `driveWebViewLink`; the slot shows a "Copy link Drive" button.

`DesignArtworkUpload` (from the P1 migration) is kept as the record of in-flight pushes: one row per push with `sessionUrl`, cleared on completion; a crashed push leaves a row that the retry action reuses.

## Schema

`DesignArtwork` gains `storage String @default("LOCAL")`, `driveFileId String?`, `driveWebViewLink String?`; `storagePath` becomes nullable. New `DesignArtworkUpload` as above. Migration + `SCHEMA_VERSION` bump.

## Serving and approving

- `GET /api/design-studio/file/[artworkId]`: `LOCAL` → as today; `DRIVE` → stream via `streamFile` with the stored mime (from the validated extension), `Content-Disposition: inline`; PSD/ZIP → 302 to `driveWebViewLink`.
- On DONE (`updateLine(done:true)`), for a `DRIVE` artwork: `designDriveLink = driveWebViewLink` (already shared at upload) (a `drive.google.com` URL, so the existing export and Trello attachment logic keep working). `LOCAL` keeps the app URL.
- Reopen does not revoke the share (the factory may already have the link).

## Failure handling

Drive errors surface as `{ error }` with the Google message; a failed session leaves the pending row (cleaned after 24 h by the next session request). `complete` is idempotent per `uploadId`. A token refresh failure marks the connection "cần kết nối lại" in Setup and uploads fall back with a clear error (not silently to local).

## Tests

`google-drive.ts` against a mocked `fetch` (token refresh caching, folder reuse vs create, resumable initiation headers incl. `Origin`, share call); upload route pushes in chunks (mock: initiation + N chunk PUTs with correct Content-Range) and shares; falls back to LOCAL with a warning on Drive error; retry action pushes a LOCAL artwork; serve route streams Drive and redirects PSD; `updateLine` shares and stores the web link; fallback to LOCAL when not connected; callback rejects a bad state.
