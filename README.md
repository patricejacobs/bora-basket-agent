# WhatsApp Grocery Agent

A WhatsApp shopping assistant. Customers message your store's WhatsApp number, search the
catalogue in plain language, build a cart, and check out — all in chat. Payment is on
delivery; the agent captures the order and staff fulfil it.

Built on the **WhatsApp Cloud API** (direct from Meta) and **Claude Opus 5**.

---

## Quick start

You can run the whole thing locally and talk to it in a browser before touching Meta.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your Anthropic API key in `.env` (`ANTHROPIC_API_KEY=sk-ant-...`), then load the sample
catalogue and start the server:

```bash
npm run import:catalog -- ./data/sample-products.csv
```

```bash
npm start
```

Open **http://localhost:3000/simulator** and start typing. Try:

- *"what do you have?"*
- *"I need rice, chicken and a dozen eggs"*
- *"how much is that altogether?"*
- *"deliver to 12 Main Street, Georgetown"*

The simulator runs the **exact same code path** as WhatsApp — same agent, same tools, same
database. Only the transport differs. The side panel shows the live cart, saved customer
details, and recent orders so you can see what the agent actually did.

No build step: Node 24 strips the TypeScript types natively.

### Verify without spending anything

```bash
npm run smoke
```

104 checks over catalogue import, search ranking, cart maths, stock limits, checkout,
webhook parsing, signature verification, replay protection, message chunking, reply pacing,
staff dispatch commands and the action buttons. Makes no API calls.

---

## How it works

```
WhatsApp  ──▶  /whatsapp/webhook ──┐
                                    ├──▶  conversation.ts  ──▶  agent loop  ──▶  Claude Opus 5
Browser   ──▶  /simulator/api    ──┘         (per-customer      (tools)            │
                                              serialisation)                        ▼
                                                                              SQLite: catalog,
                                                                              carts, orders,
                                                                              chat history
```

The agent has no knowledge of your products baked into it. Every price, pack size and stock
figure comes from a tool call against the database, and the system prompt forbids answering
from memory. That is what stops it inventing a product or quoting a stale price.

**Tools the agent can call**

| Tool | What it does |
|---|---|
| `list_categories` | What departments exist |
| `search_products` | Ranked keyword search over name, aliases, category, description |
| `get_product` | One product by SKU, with live stock |
| `view_cart` | Itemised cart with subtotal, delivery, total |
| `add_to_cart` / `update_cart_item` / `clear_cart` | Cart edits, stock-checked |
| `get_customer_details` / `save_customer_details` | Delivery name and address |
| `place_order` | Transactional checkout |
| `list_recent_orders` | Order history and status |
| `show_product_photo` | Sends a product photo, when one is on file |
| `send_buttons` | Native WhatsApp tap-to-reply buttons |

Placing an order also pushes an alert to `STAFF_NUMBERS` — see **Running the shop** below.

**Safeguards already in place**

- Checkout is a single SQLite transaction: order rows, stock decrements and cart clearing
  all commit together or not at all.
- Stock is re-checked inside that transaction, so a search result going stale can't oversell.
- `place_order` refuses to run without a saved name, a saved address, and a non-empty cart.
- Every webhook is HMAC-verified against your Meta app secret. An unconfigured secret
  rejects everything rather than trusting it.
- Meta redelivers any webhook it doesn't get a fast `200` for. Message IDs are claimed in a
  unique index, so a redelivery can never place a second order.
- Messages from one customer are processed one at a time, so two fast taps can't race on
  the same cart.
- The agent never handles card or bank details — the system prompt stops the conversation
  if a customer starts typing them.

---

## Loading your real catalogue

Replace the sample file with your own export. Required columns are `sku`, `name`, `price`;
everything else is optional.

```csv
sku,name,description,category,unit,price,stock,keywords,active,image
RIC-001,Karibee Parboiled Rice,Long grain parboiled,Rice & Grains,5 kg bag,1850,120,rice parboiled grain,1,https://cdn.example.com/rice.jpg
```

- **`keywords`** is what customers actually say about *this* product — a brand you carry, a
  local name, what people call it at the counter. Search reads it second only to the name,
  so it is the highest-leverage column in the file. Spend time on it. General terms
  (`washing powder`, `bully beef`, `fig`) are already understood without it — see below.
- **`unit`** is displayed with the price (`$1,850 / 5 kg bag`), so it should read naturally.
- **`image`** is optional: a publicly reachable **https** URL. WhatsApp fetches the
  address itself, so a link behind a login, on localhost, or over plain http silently
  fails — those are rejected at import rather than becoming a mystery later. Products
  without one simply have no photo, and the agent describes them in words.
- Common header spellings are accepted (`item_code`, `qty`, `department`, `tags`,
  `photo`, `picture`, …).

```bash
npm run import:catalog -- ./data/your-products.csv
```

Rows are matched on SKU and upserted — re-run the import whenever prices or stock change.
Products missing from the file are left alone; add `--deactivate-missing` to retire them
instead. Bad rows are skipped and reported by line number rather than failing the import.

## How search reads a customer

Nobody types the shelf label. Search is built for what people actually send:

| They type | They get | Why |
|---|---|---|
| `chiken`, `tomatos`, `spagetti` | Chicken, Tomatoes, Spaghetti | Spelling is repaired |
| `egg` / `eggs`, `plantains` | Eggs, Plantain | Plurals fold together |
| `2 lbs channa`, `5kg rice` | the product | Quantities are stripped |
| `do you have any fresh bread` | Bread | Filler words are ignored |
| `washing powder` | Laundry Detergent | Everyday name for the thing |
| `bully beef`, `fig`, `dhal`, `greens` | Corned Beef, Bananas, Split Peas, Callaloo | Local names |
| `colgate`, `clorox`, `pampers` | Toothpaste, Bleach, Diapers | Brand used as the word |

Forgiving, but not loose — **a wrong match is worse than none.** Somebody shown ketchup
when they asked for tomatoes stops trusting the rest of the screen. So spelling is only
repaired on words long enough for it to be safe (`rise` will not become `rice`), a listed
keyword always outranks a coincidental near-spelling, and every word of the query has to
be accounted for.

When a word cannot be accounted for, the shortfall is reported rather than hidden. Ask for
**cassava bread** and you are told plainly it is not stocked, shown Cassava Chips as the
nearest thing, and the phrase is added to the `wanted` report. That is the difference
between a shop that says "we don't have that, will this do?" and one that quietly hands
you the wrong item.

Two knobs, if you ever need them: per-product aliases go in the CSV `keywords` column;
the general vocabulary — Creole names, brand-as-generic, British/American splits — is
`SYNONYM_GROUPS` in [`src/catalog/search.ts`](src/catalog/search.ts).

## Product photos

Two ways, and a URL in the CSV always wins over a file on disk.

**Drop a file in a folder.** Name it by SKU — `RIC-001.jpg` — into
`PRODUCT_IMAGES_DIR` (`/var/data/product-images` on Render, so it survives deploys).
The server hosts it at `/images/RIC-001.jpg` and the catalogue picks it up
automatically. No CSV edit, no CDN, no image host. `.jpg`, `.jpeg`, `.png` and
`.webp` are recognised, and the folder is re-scanned every 20 seconds, so a new
photo appears without a restart.

This needs **`PUBLIC_BASE_URL`** set, because WhatsApp fetches image URLs from its own
servers and a relative path would resolve against Meta. Render provides
`RENDER_EXTERNAL_URL` automatically.

**Or put an https URL in the `image` column** of your catalogue CSV, for
supplier-hosted imagery.

Products without a photo are handled honestly: the agent describes them in words
rather than dwelling on the missing picture. `/health` reports `localImageFiles`
and `productsWithPhotos` so you can see coverage.

**On sourcing:** photograph your own stock, or use imagery you have written
permission for. Product photography belonging to brands or other retailers is
copyrighted, and republishing it to your customers is not something to do
casually.

---

## Connecting the real WhatsApp number

1. **Create a Meta app.** [developers.facebook.com](https://developers.facebook.com) → Create
   App → *Business* → add the **WhatsApp** product.
2. **Get your credentials.** Under WhatsApp → API Setup, copy the **Phone number ID** and an
   access token. Under App Settings → Basic, copy the **App Secret**.
3. **Fill in `.env`:**

   ```
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_ACCESS_TOKEN=...
   WHATSAPP_APP_SECRET=...
   WHATSAPP_VERIFY_TOKEN=any-random-string-you-choose
   ```

4. **Expose the server.** Meta needs a public HTTPS URL. For testing, `ngrok http 3000`.
   For production, deploy behind a real domain.
5. **Register the webhook.** WhatsApp → Configuration → Edit:
   - Callback URL: `https://your-domain/whatsapp/webhook`
   - Verify token: the same string you put in `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field.
6. **Test.** Message your number from the phone you registered as a test recipient.

**Two things that will bite you in production:**

- The temporary token from API Setup expires in 24 hours. Generate a permanent token from a
  System User in Meta Business Settings before going live.
- Businesses can only message a customer freely within 24 hours of that customer's last
  message. Outside that window you must use a pre-approved message template. This agent only
  ever replies to inbound messages, so it stays inside the window — but any proactive
  "your order is out for delivery" notification you add later will need a template.

Going live also requires Business Verification and a display-name review by Meta. Start that
early; it is the long pole, not the code.

---

## Configuration

All of this lives in `.env`.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `AGENT_EFFORT` | `low` | `low`\|`medium`\|`high`\|`xhigh`\|`max`. See the note below |
| `STORE_NAME` | Your Grocery Store | Used in the greeting and the system prompt |
| `STORE_HOURS` | — | Quoted to customers verbatim, and read per day. See below |
| `DELIVERY_AREAS` | — | Where you deliver |
| `DELIVERY_FEE` | 500 | In display currency, not minor units |
| `FREE_DELIVERY_OVER` | 10000 | `0` disables free delivery |
| `MIN_ORDER_TOTAL` | 1000 | `0` disables the minimum |
| `CURRENCY_CODE` / `CURRENCY_SYMBOL` | `GYD` / `$` | |
| `CURRENCY_DECIMALS` | `0` | `0` for GYD; set `2` for currencies with cents |
| `PORT` | 3000 | |
| `DATABASE_PATH` | ./data/store.db | |
| `ENABLE_SIMULATOR` | true | Refused for non-local requests regardless; `false` removes the route |
| `STAFF_NUMBERS` | — | Comma-separated E.164 digits. Empty means nobody is told about orders |
| `STORE_TIMEZONE` | `America/Guyana` | Used for greetings and the closing-time reminder |
| `TEMPLATE_ORDER_ON_THE_WAY` | — | Approved template, used only outside the 24h window |
| `TEMPLATE_ORDER_DELIVERED` | — | As above |
| `TEMPLATE_LANGUAGE` | `en` | Template language code |
| `SEED_CATALOG_PATH` | — | CSV imported at boot when the catalogue is empty |

### A note on `STORE_HOURS`

Written for customers to read, but also parsed — per day, so `Mon-Sat 8:00am - 8:00pm,
Sun 9:00am - 4:00pm` gives Sunday its own shorter day. Day ranges (`Mon-Sat`), day lists
(`Mon, Wed, Fri`), `Sun closed`, and hours crossing midnight (`6:00pm - 2:00am`) all read
correctly. A day you never list is a day off.

**Outside those hours the agent does not say "we're closed."** It says when deliveries
start and keeps taking the order:

> Good morning! Bora Basket here — I can build your grocery order right in this chat.
> Bread we have: …
> Which one, and how many? Deliveries run from 8:00am today, so I can get it moving from then.

Same fact, but "we're closed" reads as *go away* and loses an order the shop could have
filled at eight. The three cases are worded apart, because "deliveries have finished for
today" is untrue on a day the shop never opened:

| Situation | What the customer hears |
|---|---|
| Before opening | Deliveries start at 8:00am today |
| After closing | Deliveries have finished for today — they start at 8:00am tomorrow |
| A day off | No deliveries today — they start at 8:00am on Monday |

If the hours cannot be parsed, the agent says nothing about timing rather than guessing.
Telling someone the shop is shut when it is open costs a sale; silence costs nothing.

### A note on `AGENT_EFFORT`

It defaults to `low`. WhatsApp is a latency-sensitive medium — a shopper who waits eight
seconds for "we have three kinds of rice" assumes the bot is broken. Low effort keeps replies
in the one-to-three second range, and this task (search a catalogue, do arithmetic via tools,
follow a checkout script) is not one where deeper reasoning changes the answer much.

If you find replies shallow — misreading vague orders, missing that "the usual" means a
repeat order — raise it to `medium` and compare. That is a real quality/latency trade-off and
it is yours to make, not a cost decision made on your behalf.

Prompt caching is on for the system prompt and tool definitions, which is the bulk of each
request's input tokens on a short chat turn.

---

## Running the shop

Staff share the customer-facing WhatsApp number. Any number listed in `STAFF_NUMBERS`
reaches a dispatch queue instead of the shopping agent.

**A new order arrives as a push message** with the items, total, customer, address and
phone, followed by tappable buttons for the next action. Dispatch is a tap.

The same actions can be typed, which is faster once you know them:

| Command | Effect |
|---|---|
| `orders` | List everything not yet delivered or cancelled |
| `7` | Show one order |
| `7 confirmed` | Accept it — customer is told |
| `7 on the way` | Dispatch it — customer is told |
| `7 delivered` | Close it — customer is told |
| `7 cancel` | Cancel it — customer is told |
| `wanted` | What customers asked for and you did not have |
| `help` | Print the list |

Order numbers work as `7`, `ORD-7` or `ORD-00007`. Status words are matched loosely, so
`7 otw`, `7 out for delivery` and `7 dispatched` all mean the same thing.

Button titles *are* the typed commands, so a tap and a typed message go through one parser.

These are parsed rather than sent to the model: a dispatcher clearing twenty orders needs
the same words to do the same thing every time, instantly, and at no per-message cost.

### What customers asked for and you did not have

Every search that comes back empty is recorded. It is the one number a shop cannot read
off its own till roll — sales tell you what people bought, not what they came in for and
left without.

Send `wanted` on a staff number:

```
*Asked for, not in stock* — the last 30 days

• *channa* — 6 people
• *cassareep* — 4 people, 7 times
• *quinoa* — 1 person, 9 times

24 empty search(es) in total.
Ranked by how many different people asked.
```

`wanted 7` narrows it to the last week.

**Ranked by people, not by count, and the difference matters.** Six people asking once is
a gap on your shelf — stock it. One person asking nine times is a gap in the *search* —
they are rephrasing because they cannot find something you already sell.

Phrasings are grouped, so "Channa", "channa?" and "2 lbs channa" are one line. Staff
searches are excluded — a dispatcher checking stock is not a customer wanting to buy.

Near misses count too. Ask for cassava bread and the catalogue offers Cassava Chips — the
customer is told plainly it is not the same thing, *and* "cassava bread" goes on this list.
A half-answer is still a thing you were asked for and did not have.

`/health` reports the count but never the phrases, since those are customer-typed text and
that URL is public.

### "Where is my order?"

The agent answers this itself, from the live database rather than from memory, because a
dispatcher may have moved the order along mid-conversation. It reports status in plain
words — "out with the driver", never "pending" — and **will not give a delivery time**,
since it has no way to know one and a guess becomes a promise.

A customer can name an order (`ORD-00007`), but the lookup is scoped to the number they
are messaging from. Order numbers are sequential and get read aloud, so an unscoped
lookup would hand anyone their neighbour's name and address for the price of a guess.

### The 24-hour rule

WhatsApp only permits free-form messages within 24 hours of the customer's last message.
Outside that window an approved template is the only route.

The notifier picks automatically. Same-day delivery is almost always inside the window, so
most updates need no template at all. For next-day updates, create two **Utility** templates
in WhatsApp Manager and set `TEMPLATE_ORDER_ON_THE_WAY` and `TEMPLATE_ORDER_DELIVERED`.
Parameters are `{{1}}` first name, `{{2}}` order number, `{{3}}` total.

With no template configured, an out-of-window update is skipped and logged rather than
failing silently.

## What is not built yet

Named plainly, because you will want some of these before going live:

- **No human handoff.** The agent tells customers "a staff member will follow up", but
  nothing routes that anywhere.
- **No staff dashboard.** The WhatsApp queue works well for one shop; volume would want a
  screen.
- **No payments.** Deliberate — cash or card to the driver, as chosen.
- **SQLite, single process.** Fine for one store and a few thousand products. Multiple
  instances behind a load balancer would need Postgres and a shared lock for the
  per-customer serialisation.
- **Voice notes are built but switched off.** Set `TRANSCRIBE_PROVIDER` and the matching
  key to turn them on; without it a voice note gets a polite "could you type that".

---

## Project layout

```
src/
  server.ts              Express app, startup checks
  config.ts              Environment config, money formatting
  conversation.ts        Shared entry point for every channel
  agent/
    run.ts               The agent loop (tool calls, history, error mapping)
    context.ts           Local time and returning-customer recognition
    pacing.ts            Reply splitting and typing delays
    tools.ts             Tool definitions and their implementations
    system-prompt.ts     Behaviour, tone, guard rails
  channels/
    whatsapp.ts          Webhook verification, parsing, routing
    whatsapp-send.ts     Graph API sending (text, buttons, templates)
    simulator.ts         Browser test channel
    types.ts             Channel-neutral message shapes
  notifications.ts       Staff alerts and customer status updates
  staff.ts               Dispatch commands over WhatsApp
  order-status.ts        Order lifecycle vocabulary and action buttons
  catalog/
    import-csv.ts        CSV parser and importer (also a CLI)
    search.ts            Typo, plural and synonym matching
  db/
    index.ts             Schema
    repo.ts              All queries
  public/
    simulator.html       The test chat UI
  smoke.ts               The offline test suite
data/
  sample-products.csv    73 sample products
```

## Commands

```bash
npm start                                              # run the server
npm run dev                                            # run with auto-restart on change
npm run import:catalog -- ./data/sample-products.csv   # load or refresh the catalogue
npm run smoke                                          # offline test suite
npm run check                                          # configuration doctor
npm run typecheck                                      # tsc --noEmit
```
