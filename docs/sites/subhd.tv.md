# subhd.tv protocol

Paste this document into the site's profile notes (Sites → Notes) for
`https://subhd.tv`. The browse agent receives it in its prompt and follows it.
The whole flow works at the `curl` tier; no JavaScript rendering is needed.
Send a browser-like User-Agent on every request, and keep cookies across all
steps — the download API depends on an IP-bound `tk_*` cookie collected along
the way.

## Search

`GET /search/{query}` (URL-encode the query) returns static HTML. Each result
is an anchor of the form:

    <a class="link-dark align-middle" href='/a/{slug}'>{title}</a>

The ~2500 characters after each anchor describe that pack: language badges as
`<span>` labels (简体 = zh-Hans, 繁体 = zh-Hant, 英语 = en, 日语 = ja), the
subtitle format in uppercase (SRT/ASS), file size, download count, upload date,
and uploader name. Pick the pack whose languages match the target languages;
prefer higher download counts and preferred groups when several match.

## Download

For a chosen pack `{slug}`, in order, keeping cookies throughout:

1. `GET /a/{slug}` — the detail page; collects cookies.
2. `GET /down/{slug}` with `Referer: https://subhd.tv/a/{slug}` — the landing
   page; collects more cookies.
3. `POST /api/sub/down` with content-type `application/json`, body
   `{"sid": "{slug}", "cap": ""}`, and `Referer: https://subhd.tv/down/{slug}`.
4. Read the JSON response `{ success, pass, url, msg }`:
   - `success` false: this pack is not downloadable; `msg` says why. Try
     another pack or give up.
   - `pass` false: `msg` contains an SVG captcha. Read the characters out of
     the SVG source and repeat the POST once with `cap` set to the answer. If
     it still fails, give up on this pack.
   - `success` and `pass` true: `url` is the archive. Download it with the
     same cookies and `Referer: https://subhd.tv/down/{slug}`.
