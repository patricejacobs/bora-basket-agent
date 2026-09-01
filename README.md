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

53 checks over catalogue import, search ranking, cart maths, stock limits, checkout,
webhook parsing, signature verification, replay protection, and message chunking. Makes no
API calls.

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
| `send_buttons` | Native WhatsApp tap-to-reply buttons |

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
sku,name,description,category,unit,price,stock,keywords,active
RIC-001,Karibee Parboiled Rice,Long grain parboiled,Rice & Grains,5 kg bag,1850,120,rice parboiled grain,1
```

- **`keywords`** is what customers actually say. `pampers` finding the diapers row, `dhal`
  finding split peas — that comes from here, and it is the single highest-leverage column
  for search quality. Spend time on it.
- **`unit`** is displayed with the price (`$1,850 / 5 kg bag`), so it should read naturally.
- Common header spellings are accepted (`item_code`, `qty`, `department`, `tags`, …).

```bash
npm run import:catalog -- ./data/your-products.csv
```

Rows are matched on SKU and upserted — re-run the import whenever prices or stock change.
Products missing from the file are left alone; add `--deactivate-missing` to retire them
instead. Bad rows are skipped and reported by line number rather than failing the import.

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
| `STORE_HOURS` | — | Quoted to customers verbatim |
| `DELIVERY_AREAS` | — | Where you deliver |
| `DELIVERY_FEE` | 500 | In display currency, not minor units |
| `FREE_DELIVERY_OVER` | 10000 | `0` disables free delivery |
| `MIN_ORDER_TOTAL` | 1000 | `0` disables the minimum |
| `CURRENCY_CODE` / `CURRENCY_SYMBOL` | `GYD` / `$` | |
| `CURRENCY_DECIMALS` | `0` | `0` for GYD; set `2` for currencies with cents |
| `PORT` | 3000 | |
| `DATABASE_PATH` | ./data/store.db | |
| `ENABLE_SIMULATOR` | true | **Set to `false` in production** |

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

## What is not built yet

Named plainly, because you will want some of these before going live:

- **No staff-facing admin.** Orders land in the `orders` table and nothing tells your team
  they arrived. This is the biggest gap between the prototype and a working shop — the
  agent takes orders perfectly and nobody finds out. A dashboard, an email, or even a
  WhatsApp message to a staff number would close it.
- **No order status updates.** `status` is a column that only ever says `pending`. Nothing
  moves it, and nothing notifies the customer.
- **No human handoff.** The agent tells customers "a staff member will follow up", but
  nothing routes that anywhere.
- **No payments.** Deliberate — cash or card to the driver, as chosen.
- **SQLite, single process.** Fine for one store and a few thousand products. Multiple
  instances behind a load balancer would need Postgres and a shared lock for the
  per-customer serialisation.
- **Text only.** Voice notes and photos get a polite "please type that" reply. Transcribing
  voice notes would be a genuine win for grocery ordering.

---

## Project layout

```
src/
  server.ts              Express app, startup checks
  config.ts              Environment config, money formatting
  conversation.ts        Shared entry point for every channel
  agent/
    run.ts               The agent loop (tool calls, history, error mapping)
    tools.ts             Tool definitions and their implementations
    system-prompt.ts     Behaviour, tone, guard rails
  channels/
    whatsapp.ts          Webhook verification, parsing, Graph API sending
    simulator.ts         Browser test channel
    types.ts             Channel-neutral message shapes
  catalog/
    import-csv.ts        CSV parser and importer (also a CLI)
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
npm run typecheck                                      # tsc --noEmit
```
