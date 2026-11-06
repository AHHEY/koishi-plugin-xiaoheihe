# Validation report

Date: 2026-11-04

## Automated tests

Command (using the installed Koishi dependencies for the real load test):

```text
node --test test/security.test.cjs test/parsers.test.cjs test/image.test.cjs \
  test/bridge.test.cjs test/game.test.cjs test/reader.test.cjs \
  test/bili-provider.test.cjs test/plugin.test.cjs \
  test/community-service.test.cjs test/lifecycle.test.cjs
```

Result: **64 passed, 0 failed**.

Covered:

- fixed HTTPS host, numeric ID, DNS/private-address and redirect checks
- hkey request-signing reference vector and real QR-request connectivity
- real AstrBot fixture feed, post body and comments
- real share-link forms: `/app/bbs/link/`, `/community/<id>/list/`, `/v3/bbs/app/api/web/share?link_id=` and hexadecimal link IDs
- hexadecimal share ID may map to a numeric canonical post ID, while arbitrary mismatches still fail closed
- image URL extraction from post arrays and rich HTML/JSON, deduplication, four-image cap and image-only posts
- image CDN allowlist, public DNS pinning, no cookies/authorization, redirect/MIME/magic/oversize/timeout rejection
- separate vision-model request with untrusted title, labeled image data, response cap and no Key in results/errors
- independent image daily limit and per-post cap
- reuses only `visionEndpoint`/`visionApiKey`/`visionModel` from atri-bili-eyes without duplicate secret fields
- image failure is non-fatal to text; feed and non-HDS direct-link paths skip vision
- image descriptions stay in temporary observations and `webContext`, not long-term HDS script text
- cache and daily limit behavior
- HDS `xhh-*` intent ownership, deferred execution, source hash validation
- external observations stored outside HDS narrative tables
- direct link observation: raw text stays out of stored script and is only exposed through current webContext
- expiry redaction and no admin-fact writes
- Steam details, price/region/currency, review sample metadata, partial failure
- real Koishi `App` plugin load and command registration
- Bilibili provider read-only behavior
- shared service lifecycle and single HDS wrapper installation
- lifecycle: last-owner release restores the original narrator, multiple child contexts share one root bridge, failed version check leaves HDS untouched

## Staging Bilibili regression

`E:\workspace\Zcode\koishi-xiaoheihe-staging\atri-bilibili` is a source copy, not an installation. Its original tests plus a shared-bridge compatibility test:

Result: **247 passed, 0 failed**.

One original test asserted Unix `0600` mode; the staging copy adapts that assertion to Windows `0666` because Windows does not expose POSIX permission bits the same way. This was a test-environment adaptation, not a production code failure.

## Syntax and package

- `node --check` passed for `index.js`, all `lib/*.js`, and all `test/*.test.cjs`.
- `npm pack --dry-run` included 21 files and excluded tests/logs.
- No credentials or literal placeholder tokens remain in packaged source.
- The real instance's `atri-bili-eyes` config block was parsed read-only to confirm that `visionEndpoint`, `visionApiKey` and `visionModel` are present and pass validation. No secret value was printed, logged or copied.

## Real services

- Steam `appdetails` was confirmed through the available web fetch path for AppID `570` (Dota 2); it returned a JSON object and `price_overview` was absent because the game is free. The Node process in this sandbox could not reach Steam (`network`), so live network behavior remains environment-dependent.
- Steam `appreviews` was not confirmed as JSON through the available fetch path; the implementation therefore treats review failure as explicit unavailability, not as invented reviews.
- Xiaheihe authenticated feed/post/comment and game endpoints were **not** tested against a real account. No QR scan or account credentials were used. Treat those as unverified until you run a logged-in read-only test.
- One real Xiaheihe post image was confirmed on `imgheybox1.max-c.com` and downloaded through `fetchImage()` as a 72,844-byte JPEG on 2026-11-04. The full Xiaheihe post-to-visual-model path was not run end-to-end; automated vision tests use synthetic PNG bytes and a mocked OpenAI-compatible response.
- **Bilibili sampled visual path was verified live on 2026-11-05.** `yt-dlp 2026.10.26`, FFmpeg/ffprobe `9.0.2` and the configured vision endpoint were used against one public 212.261-second video. `createDeep().read()` returned `status=sampled-visual`, 8 sampled timestamps, a 725-character description, and an explicit no-audio/not-complete-viewing limitation. No Cookie was supplied, and the temporary media directory was removed. This verifies the download/frame/vision component directly; the full Koishi `eyes.watch()` plus HDS delivery path still requires a post-restart user link test.
- No write operations, comments, posts, likes, follows, favorites or account mutations are implemented.

## Known unverified areas

- Xiaheihe's current image CDN hosts and whether all post images use JPEG/PNG/WebP rather than GIF or another format. One real post's image was confirmed at `imgheybox1.max-c.com` and downloaded as a 72,844-byte JPEG on 2026-11-04; other posts may use different hosts.
- Visual model quality on screenshots, charts, small text and compressed Xiaheihe images.
- Xiaheihe's non-public game-detail response shape and price fields.
- Real account login/QR polling and post/comment parsing under current platform responses.
- Whether the platform rate-limits a long-running production account.
- HDS rc57 private-method compatibility after an HDS upgrade.

## References

- [Xiaoheihe SDK game item fields](https://docs.xiaoheihe.cn/hb_sdk/reference/symbols/root/interfaces/SteamGameListItem.html)
- [Non-official Xiaoheihe game detail example](https://www.vinking.top/posts/codes/game-and-social-media-sharing)
