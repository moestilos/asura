# StackWatch SDK

Tiny clients that push bot/scraper progress to the local StackWatch panel
(`http://127.0.0.1:27315`).

Fail-silent: if the daemon is offline your bot keeps running normally.

## Node

```bash
npm install <path>/stackwatch/sdk/node
# or copy stackwatch-sdk into your project
```

```js
import sw from 'stackwatch-sdk'

const bot = await sw.bot('amazon-scrape', { target: 15000 })

for (const url of urls) {
  try {
    const item = await scrape(url)
    bot.tick({ item: url, data: item.title })
  } catch (e) {
    bot.error(e.message, { url })
  }
}

bot.done()
```

## Python

Copy `python/stackwatch_sdk.py` into your project:

```python
from stackwatch_sdk import bot

b = bot("amazon-scrape", target=15000)
for url in urls:
    try:
        item = scrape(url)
        b.tick(item=url, data=item.title)
    except Exception as e:
        b.error(str(e), meta={"url": url})
b.done()
```

## API

| Method                          | Effect                                                |
|---------------------------------|-------------------------------------------------------|
| `bot.tick({ item, data })`     | +1 progress · `item` shown as "current" · `data` saved as sample |
| `bot.tick({ count: 50 })`      | bulk tick (rare)                                      |
| `bot.error(msg, meta?)`        | record error · last 20 kept                          |
| `bot.done()`                    | mark as completed                                     |
| `bot.crashed(msg)`             | mark as crashed                                       |

Ticks without `item`/`data` are batched (250ms) so a 10k-item loop doesn't
hammer the daemon.

## Env vars

- `STACKWATCH_HOST`   — default `127.0.0.1`
- `STACKWATCH_PORT`   — default `27315`
- `STACKWATCH_DISABLE=1` — fully disable (no network calls)
