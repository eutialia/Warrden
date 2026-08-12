---
site: https://subhd.tv
updated: 2026-08-10
---

# subhd.tv

## Access
- IF fetching any page THEN send a browser-like User-Agent and keep cookies across every request in the run — the download API depends on an IP-bound `tk_*` cookie collected along the way. (confirmed 2026-08-10)
- IF working this site THEN the whole flow works at the `curl` tier; no JavaScript rendering is needed. (confirmed 2026-08-10)

## Search
- IF searching THEN GET `/search/{query}` (URL-encode the query); it returns static HTML with each result as an anchor `<a class="link-dark align-middle" href='/a/{slug}'>{title}</a>`. (confirmed 2026-08-10)
- IF reading a result THEN the ~2500 characters after its anchor describe the pack: language badges as `<span>` labels (简体 = zh-Hans, 繁体 = zh-Hant, 英语 = en, 日语 = ja), the subtitle format in uppercase (SRT/ASS), file size, download count, upload date, and uploader name. (confirmed 2026-08-10)
- IF several results match the target languages THEN prefer higher download counts and preferred groups among them. (confirmed 2026-08-10)

## Download
- IF downloading a chosen pack `{slug}` THEN GET `/a/{slug}` first — the detail page, which collects cookies. (confirmed 2026-08-10)
- IF the detail page has been fetched THEN GET `/down/{slug}` with `Referer: https://subhd.tv/a/{slug}` — the landing page, which collects more cookies. (confirmed 2026-08-10)
- IF the landing page has been fetched THEN POST `/api/sub/down` with content-type `application/json`, body `{"sid": "{slug}", "cap": ""}`, and `Referer: https://subhd.tv/down/{slug}`. (confirmed 2026-08-10)
- IF the POST response has `success: false` THEN this pack is not downloadable — `msg` says why; try another pack or give up. (confirmed 2026-08-10)
- IF the POST response has `pass: false` THEN `msg` contains an SVG captcha — read the characters out of the SVG source and repeat the POST once with `cap` set to the answer; if it still fails, give up on this pack. (confirmed 2026-08-10)
- IF the POST response has `success: true` and `pass: true` THEN `url` is the archive — download it with the same cookies and `Referer: https://subhd.tv/down/{slug}`. (confirmed 2026-08-10)

## Pitfalls

## Operator notes
