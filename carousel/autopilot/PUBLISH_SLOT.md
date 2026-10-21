You are posting ONE queued Instagram Reel for @prizedrawsdaily, unattended on the owner's Mac. Nobody will
answer a question. The Reel was built, checked frame by frame and hosted by the lunchtime run; the item
above says what to post. `carousel/autopilot/queue.mjs` already confirmed that it is due at this UK hour
and that its draw is still open.

## Rules
- Post exactly this item: its `video_url`, its `cover_url` and its `caption`, byte for byte. Do not
  edit, shorten or add to the caption.
- Use Composio only through `COMPOSIO_MULTI_EXECUTE_TOOL` (parameter name `tools`), and only for the
  three INSTAGRAM_* tools below. Never touch comments, DMs, likes or follows. (This is the Mac's fallback
  route when it has no COMPOSIO_API_KEY; the script route, `bun carousel/ig-publish.mjs reel`, also posts the
  Reel to Facebook.)
- Bash is allowed only as single commands of the form `bun carousel/autopilot/queue.mjs …`. A refused
  command applies to that command only; rephrase it and carry on.
- Never print or echo a secret.

## Steps
1. **Create the container:** `INSTAGRAM_POST_IG_USER_MEDIA` with
   - `ig_user_id`: the item's `igUserId`
   - `media_type`: `"REELS"`
   - `video_url`: the item's `video_url`
   - `cover_url`: the item's `cover_url`
   - `caption`: the item's `caption`
   - `share_to_feed`: `true`

   Keep the container id it returns.
2. **Publish:** `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` with `ig_user_id`, `creation_id` = that container id,
   `max_wait_seconds`: 300. Video processing takes 30–120 s. If it fails, create a fresh container once and
   try again. If it fails twice, stop: STATUS: FAILED, with the error text verbatim.
3. **Record it:** `bun carousel/autopilot/queue.mjs done <SLOT> --ig <published media id>`. This marks the
   row published, unqueues the item and frees the day's hosted files once nothing else needs them.
4. **Check it landed:** `INSTAGRAM_GET_IG_USER_MEDIA` for the user (`fields`: `id,caption,media_product_type,permalink,timestamp`,
   `limit`: 3). The newest item must have the published id and media_product_type `REELS`.
5. **Write the report** to the REPORT path given above, with the Write tool:

```
STATUS: PUBLISHED            (or STATUS: FAILED)
slot: <SLOT> · hero: <hero slug>
reel: <permalink>            (or the error, verbatim)
notes: one line, only if something was odd
```

The first line must be exactly `STATUS: PUBLISHED` or `STATUS: FAILED`.
