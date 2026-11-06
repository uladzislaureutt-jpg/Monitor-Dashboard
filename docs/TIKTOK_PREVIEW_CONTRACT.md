# TikTok / Сети — optional thumbnail contract (Monitor 0.8.81)

The source of truth is the **final operator-approved** TikTok-Monitor `networks_cards.jsonl`
inside `dashboard-bundle-tiktok-N.zip`. This adds an **optional** image to the
existing `networks.v1` card without changing other metadata or the filtering policy.

Recommended canonical property:

```json
{
  "schema_version": "networks.v1",
  "platform": "tiktok",
  "item_id": "tiktok:7702043649848184085",
  "source_url": "https://www.tiktok.com/@example/video/7702043649848184085",
  "preview_image_url": "https://p16-sign-va.tiktokcdn.com/.../thumbnail.jpeg"
}
```

If an extracted visual frame has no permanent public image URL, the source may
compress **one representative image** to a very small JPEG/WebP/PNG and embed it:

```json
{
  "preview_image_url": "data:image/jpeg;base64,/9j/4AAQSk..."
}
```

Maximum **20,000 characters total** for an embedded data URI (about 14 KiB
compressed image), and **4,096 characters** for HTTPS image URLs. Source
should resize images before embedding (e.g. width 90–160 px, portrait crop)
instead of transferring full-resolution original frames. This keeps each
card within the existing Supabase JSONB limit of 40 KB and avoids paid media
storage or extra API calls.

Compatibility aliases accepted when `preview_image_url` is missing:
`thumbnail_url`, `cover_url`, `poster_url`, `image_url`,
`cover_image_url`, `thumbnail_data_url`, `preview_image_data_url`,
`preview_image.url`, `preview_image.data_url`,
`thumbnail.url`, `thumbnail.data_url`, and `media.thumbnail_url`.

Only HTTPS (without userinfo or private/local IP hosts), and embedded
`data:image/jpeg|png|webp;base64` are accepted. SVG, plain HTTP, invalid,
or oversized media are ignored. No image is shown if no acceptable preview
exists. Do **not** substitute an unrelated video cover.

The existing TikTok ID, operator inclusion rules, SHA-256 bundle checksum,
GitHub import receipts and shared server moderation remain unchanged.
On reconciliation, preview metadata may be added to an already imported card
without overwriting the operator's classification, existing deletions, or flags.
Text-only older bundles stay valid.

The app consumes image **metadata in JSONL**, not free-standing JPGs in a ZIP
without a matching card field. The image may be from TikTok's cover, a photo
post, or a previously extracted frame; the sender must select one thumbnail.
