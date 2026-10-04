# Hosting migration and data continuity

## Confirmed source

The old owner-controlled deployment is **https://ink-and-echo-two.takibaysultan.chatgpt.site**, Sites project `appgprj_6a53f9c75e7c8191950ceb8fc5f70859`, saved version 3. Identity was checked through the connector. Its original source and identity remain in Git; the pre-audit commit is `344dfaa`.

The verified replacement is **https://sultannurzhan.github.io/ink-and-echo/**, from the existing personal repository `sultannurzhan/ink-and-echo`, with the separate app-owned Worker/D1 at `https://ink-and-echo-api.takibaysultan.workers.dev`. Public gameplay, persistence, query-route refresh and original-format story import were exercised successfully.

**Old-site retirement is pending.** Its status remains active. The owner still needs to export any stories/drafts worth retaining, verify those files on the replacement, then use a supported reversible unpublish/deactivate route for the exact old project. No assets or accounts were deleted.

## Save existing data first

1. Open the confirmed old URL in the browser/profile originally used to play. The agent cannot assume access to that browser's storage.
2. Finish live rooms you want to keep. In each gallery, choose **Export story** and save the JSON privately. Per-image download or Print gallery can provide extra copies. Keep the old site available until saved files open successfully on the replacement.
3. For unfinished drawings, use **Download** on the drawing desk. Copy unsent text into a local document. Unsubmitted drafts are not included in gallery exports.
4. On the replacement, choose **Open saved story**, select the JSON and verify its turn count, text and images. Original unversioned files work. Imported stories stay local/read-only; they do not transfer a live seat or upload a gallery.
5. Start new multiplayer rooms on the replacement. Do not reuse old recovery tokens against the new database or publish private recovery links.

A new origin cannot inherit old localStorage, sessionStorage or IndexedDB. Gallery export preserves visible history, not live authentication or unfinished drafts. Retention still applies while the old site is online: galleries last seven days; waiting/active rooms expire after 24/48 hours of inactivity. Export promptly.

If a browser does not save the JSON download, use a normal browser with download support and check that the file exists. The audit's in-app browser did not report a download event; import/serialization tests alone do not prove a file was saved to the user's disk.

## Existing backups and limits

Before local execution, the audit copied project-local `.wrangler/state` and made a Git bundle in ignored `work/backups/pre-audit-2026-10-05/`. These preserve local app state and source, not every browser or old-site database.

The read-only Sites connector confirmed five rooms, eight player rows and existing entries. Private JSON snapshots are in that ignored directory. **The entry export is incomplete:** image values were truncated and a row omitted. Do not restore this partial export or treat it as sufficient to retire the old site.

For full server continuity, obtain an untruncated SQL export of the exact old `DB` through a supported owner export route. Validate row counts and image payloads before restoring into a separate staging database. Preserve hashes/versions and never merge blindly into the replacement. No complete server migration has been attempted from truncated data.

## New backend backups

After creating a private output directory and verifying the backend configuration:

```sh
node scripts/prepare-backend.mjs
npx wrangler d1 export ink-and-echo --remote --config work/wrangler.production.json --output work/backups/ink-and-echo-backup.sql
```

Use a fresh filename each time. Keep SQL private: it can contain names, art and credential hashes. Test restoration to a separate database before relying on it.

## Retirement and rollback

Retire the old Site only after Pages and online multiplayer are verified, needed archives/drafts are safely exported, and live rooms are finished or migrated. Use a supported **Unpublish**/**Deactivate** action for this exact project. Do not delete the project, source, account or assets.

The exposed Sites connector has no unpublish/deactivate operation. Changing audience or removing a custom domain is not equivalent. If the owner UI also lacks unpublishing, contact Sites support with the exact project id to request reversible unpublishing; leave retirement pending meanwhile.

Rollback information: original Git history and `344dfaa`, ignored pre-audit bundle/state, preserved `.openai/hosting.json`, and saved Site version 3. Pages can redeploy a known-good frontend commit without overwriting D1. Never delete a database as a rollback shortcut.
