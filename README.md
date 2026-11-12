# Next Minute Delivery — WhatsApp agent

A WhatsApp shopping assistant for a delivery service. Customers message the business
number, search the catalogue in plain language, build a cart, **share a location pin**, and
check out — all in chat. Payment is on delivery; the agent captures the order and staff
fulfil it.

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
| `get_customer_details` / `save_customer_details` | Delivery name, pin on file, doorstep notes |
| `request_location` | Sends WhatsApp's native *Send location* button |
| `place_order` | Transactional checkout |
| `list_recent_orders` | Order history and status |
| `show_product_photo` | Sends a product photo, when one is on file |
| `send_buttons` | Native WhatsApp tap-to-reply buttons |

Placing an order also pushes an alert to `STAFF_NUMBERS` — see **Running the shop** below.

**Safeguards already in place**

- Checkout is a single SQLite transaction: order rows, stock decrements and cart clearing
  all commit together or not at all.
- Stock is re-checked inside that transaction, so a search result going stale can't oversell.
- `place_order` refuses to run without a saved name, a shared location pin, and a non-empty
  cart. Coordinates never pass through the model: the channel validates and stores them, and
  the agent is told only that a pin is on file.
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

## The service menu

Every conversation opens the same way, whatever the customer types first:

```
Welcome to Next Minute Delivery! 👋

What can we help you with today?

*1.* Grocery shopping
*2.* Restaurant ordering
*3.* Parcel delivery
*4.* Other

Just reply with the number.
```

A returning customer is greeted by name and still gets the menu, because the service they
want today is not the one they wanted last week.

**The menu is not generated by the model.** Fixed text does not need one: it arrives
instantly, costs nothing per message, and reads identically to every customer every time.
A model asked to "always open with the menu" will one day open with something else.
Numbered rather than tappable because WhatsApp reply buttons stop at three.

Replies are read generously — `1`, `3.`, `(2)`, `option 4`, or the service in words
(`groceries`, `takeaway`, `parcel`). An ambiguous or long message is *not* treated as a
pick, so "I need help with an order I placed last Tuesday" is not swallowed as menu input.

Once chosen, the service is pinned for the conversation and restated to the agent on every
turn — twenty messages into a parcel job a model that has forgotten which service it is in
starts searching the grocery catalogue. The choice expires with the conversation (12 hours),
so the next visit opens with the welcome again.

### Changing their mind

A customer can switch service **at any point, in the same breath** — "actually, can I get
pizza instead?" is a switch, not a request to find a menu. Sending `menu` still works, but
nobody is made to.

Their cart cannot follow them (one order comes from one source) and it is not the agent's
to throw away, so switching with anything in it asks first:

> You've got rice and eggs in the grocery cart — keep it for later, or drop it?

**Keep** sets it aside safely. **Drop** clears it. An empty cart needs no question and
switches silently. The tool refuses to act without that answer — deciding for them loses
somebody's shopping.

A set-aside cart is kept per source: one grocery list and one cart per restaurant, so both
can wait at once. It stays in the agent's context every turn, so "what about my groceries?"
twenty messages later gets them back rather than a blank look:

> Got them back, nothing lost:
> • White Rice, 2 kg — $780
> • Eggs, dozen — $960

Restoring puts them back in the right service and menu, refuses to merge onto a cart that
already has something in it, and quietly drops anything that sold out while it waited —
reprised from the live catalogue, so a price that moved overnight comes back at today's.

## Parcel delivery

A delivery associate collects from one address and takes it to another. No catalogue, no cart.

The agent gathers four things: a **collection pin**, a **destination pin**, the
**recipient's** name and number, and **what is being sent**. The two pins are asked for one
at a time, and when one arrives the agent is told which slot it filled so it can read it
back — a parcel sent back where it came from because two pins were swapped is a wasted trip
nobody notices until the delivery associate arrives.

**A parcel pin never touches the customer's own saved address.** It is somebody else's
doorstep; letting it overwrite their delivery location would quietly redirect next week's
groceries.

### What may not be carried

Asked about every time, and some answers are refused outright: weapons or explosives, drugs,
cash or jewellery, live animals, fuel and corrosives, medical material, and alcohol or
tobacco. The agent says so plainly, does not suggest a way around it, and does not book the
job. It cannot see inside a bag and is not meant to — it catches the person who tells you
honestly, which is most people.

### Pricing

| Variable | Effect |
|---|---|
| `PARCEL_FEE_BASE` | flat fee |
| `PARCEL_FEE_PER_KM` | added per kilometre between the two pins, rounded up |
| `PARCEL_MAX_KM` | beyond this the job is refused; `0` disables the cap |

**With neither fee set, the job is still taken** and the agent says the shop will confirm
the cost before collecting, rather than inventing a figure. A quoted price is a promise and
a wrong one is an argument on a doorstep.

## Other — handing over to a person

Option 4, and any request the agent cannot settle — a complaint, a refund, a change to an
order already placed. It asks one or two questions so the summary is actionable, then staff
get it with the customer's number and a `wa.me` link, so replying is one tap:

```
🙋 Customer needs help

Ordered Karibee parboiled rice, received white rice. Wants the correct
rice sent. Also tried calling and nobody answered.

📞 +5926005002
💬 https://wa.me/5926005002
No previous orders
```

The agent confirms it has gone to the team and **does not promise when** — it has no way
to know.

## Restaurants and takeaways

The same number also takes cooked food from restaurants and fast-food outlets. Two CSVs,
because they change on different clocks — an outlet's hours and address rarely, its menu
and prices often:

```bash
npm run import:menu -- ./data/sample-outlets.csv ./data/sample-menu.csv
```

**Outlets** carry their own hours, cooking time, minimum order, delivery fee, pickup
address and pickup pin, plus the WhatsApp number their kitchen tickets go to.

**Menu items** carry a price and an options spec. The spec is compact text, because whoever
maintains a menu works in a spreadsheet and will not hand-write JSON:

```
Size:Regular|Large+520;Protein:Chicken|Pork+100|Shrimp+350;Spice:Mild|Hot;Extras*:Cheese+150
```

| Form | Means |
|---|---|
| `Name:` | exactly one must be chosen |
| `Name?:` | at most one, may be skipped |
| `Name*:` | any number, may be skipped |
| `+520` | adds 520 to the price |

The agent is told which groups are compulsory and refuses to add a dish until they are
answered — so nobody gets a burger with no size and the kitchen never guesses.

### Adding a restaurant from a photograph

Editing two CSVs and redeploying is fine for a developer and wrong for whoever is actually
signing restaurants up — they are standing in one, holding a phone, and the menu is on the
wall. So from a staff number: **send a photo of the menu.**

A printed menu already carries almost everything needed, and what comes back is a draft:

```
📋 Draft — Mahaica Grill House (MGH)

Serves: Creole & Grill
Hours: Mon-Sat 11:00am - 10:00pm, Sun closed
At: 14 Light Street, Alberttown
Tel: 5926184477

*From The Grill*
1. Grilled Chicken Leg Quarter — $1,250
     _Size:Regular|Large+450;Spice:Mild|Hot_
2. BBQ Pork Ribs — $2,400

🚫 Left out (1) — WhatsApp does not allow selling these:
• Banks Beer

⚠️ Check these:
• BBQ Pork Ribs — price was partly obscured

2 item(s) ready. *Nothing is live yet.*

Send another photo to add more pages,
`publish` to put it on the menu, or `discard` to drop it.
```

**Nothing reaches a customer until a person publishes it.** A model reading small print off
a laminated menu in bad light will occasionally get a price wrong, and a wrong price is
money — so the draft is read back first, with anything it was unsure of flagged rather than
quietly guessed. Further photos add pages to the same draft, since menus rarely fit on one
sheet, and a dish already read is not added twice.

Alcohol is dropped at the read *and* again at publish, and the draft says what it left out
— staff should know the beer was seen and excluded, not wonder where it went.

Then the parts a photo cannot give you:

```
📍 share a location pin     where the delivery associate collects — one tap, standing outside
number MGH 5926123456       the kitchen's own WhatsApp
minimum MGH 1800            their minimum order
fee MGH 650                 delivery fee
hours MGH Mon-Sun 9am-9pm   corrects what was read
```

Publishing again **replaces** that outlet's menu rather than adding to it, so a dish taken
off a reprinted menu actually comes off — while keeping the pin, number and figures a
person set by hand.

### Ordering, in as few messages as possible

Picking *Restaurant ordering* shows the kitchens immediately, numbered, with what each
costs **before** anything is added:

```
Kitchens cooking right now:

*1.* Kingston Fried Hut — Fried chicken, burgers · 20 min · $700 delivery · min $1,500
*2.* Sheriff Street Chinese — Chinese, chow mein · 25 min · $700 delivery · min $2,000

*3.* Bourda Roti House — _opens 7:00am tomorrow_

Reply with the number.
```

The fee and the minimum are here rather than at checkout on purpose: a customer who builds
a $1,800 order and is only then told the kitchen will not take it under $2,000 has been
wasted, and it reads as a bait and switch.

The numbers the customer sees and the numbers `list_outlets` returns come from **one
ordering**. If those drifted apart, a reply of "2" would pick the wrong restaurant and
look to everyone like it had worked. Naming the place or describing it — "the chinese
one" — works just as well.

Choices are asked for once, numbered, so the reply is a few digits:

```
*Chicken Chow Mein* — $1,280
Size: *1* Small · *2* Large +$520
Protein: *1* Chicken · *2* Pork +$100 · *3* Shrimp +$350
Spice: *1* Mild · *2* Hot · *3* Extra hot

Reply like `2 1 2` — large, chicken, hot.
```

Words work too — "large chicken hot" is the same answer. Optional extras never get a turn
of their own; a dip is mentioned inside the message already being sent, because asking
"dip with that?" and waiting is a whole round trip spent on something free. And the agent
never asks whether to show the menu: the customer picked the restaurant.

Checkout is one message carrying the whole order, ending *"anything else, or shall I place
it?"* — "that's all" answers it, and the order goes.

### How a food order runs

```
customer orders  →  kitchen cooks  →  delivery associate collects  →  delivery associate delivers
```

Each party sees only what they need, on one shared number:

| | Sees |
|---|---|
| **Kitchen** | the dish, the choices, its own orders. **Not** the customer's address or phone |
| **Delivery associate** | pickup place + pin, the dish, customer name, phone, delivery pin, cash to collect |
| **Shop** | all of it, so someone notices when a kitchen goes quiet |

The delivery associate is told **only when the food is actually ready** — sent at order time they stand
in a restaurant watching a fryer. The customer is deliberately *not* messaged at that
point either: food on a counter waiting for a delivery associate is, from their side, the same as food
still cooking, and a message about it only invites "so where is it?"

Kitchen commands (`help` lists them): `orders`, `7 confirm`, `7 ready`, `7 cancel`,
`pause` / `open`, and `sold out SSC-006` / `back SSC-006` for one dish.
Delivery associate commands: `jobs`, `7 collected`, `7 delivered`.

A kitchen cannot read, move or cancel another outlet's order — and asking about one it does
not own gets the same answer as an order that does not exist, so order numbers cannot be
probed. A delivery associate cannot collect food the kitchen has not marked ready, and cannot cancel
anything. Pausing is an outlet's own switch for "we are slammed"; it never deactivates them,
because that is your decision, not theirs.

### One order, one kitchen

Two restaurants is two collections and two prep times, and hot food never shares a delivery
with groceries. So a cart holds one source. Switching is refused while something is in it,
with an explanation for the agent to pass on — the customer has to agree before anything is
cleared.

### Alcohol

**Menus are filtered, not trusted.** Nearly every place that sells a burger also sells a
beer, so the menu you are handed will list it — and WhatsApp's Commerce Policy prohibits
selling alcohol or tobacco over the channel, with a strike costing you the number the whole
business runs on.

So the importer refuses those rows and says so, on every boot:

```
[menu] refused "Rum Punch" — alcohol ("rum") — WhatsApp's Commerce Policy prohibits selling it
[menu] refused "Banks Beer" — alcohol ("beer") — WhatsApp's Commerce Policy prohibits selling it
```

Matched on words rather than brands, which go stale and misfire. It reads the name,
description, category, keywords *and* the options column, since "add a shot" is a choice
rather than a dish. Ginger beer, root beer, rum cake, beer-battered fish and anything
labelled non-alcoholic all pass — refusing half a menu over a word inside another word
would make the filter unusable.

The agent is also told it cannot sell alcohol, so if someone asks it says so plainly and
offers the soft drinks. That is the second line; the data is the first.

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

## Where to deliver: the location pin

Every order goes to a pin the customer shares from WhatsApp. No pin, no checkout — the
agent cannot talk its way past it, because `place_order` reads the database rather than the
conversation.

**The flow**

1. The customer starts ordering. The agent calls `request_location`, which sends WhatsApp's
   native *Send location* message — a button, not a sentence they have to act on.
2. They tap it and share a pin. It arrives as a `location` webhook of its own, carrying
   latitude, longitude, and sometimes a place name and resolved street address.
3. `channels/whatsapp.ts` validates the coordinates and `conversation.ts` saves them
   **before the agent runs**. The agent is handed a note saying a pin was saved — never the
   numbers.
4. The agent confirms the area in words, then asks the one question a pin cannot answer:
   which gate, which floor, what to look for. That goes in `address`, now doorstep detail
   rather than the thing deliveries depend on.
5. At checkout the pin is copied onto the order row. A customer who moves next month does
   not retroactively relocate last week's delivery.

**Why the coordinates skip the model**

A pin is structured data from the moment it leaves the customer's phone. Routing nine
significant figures through a language model only adds a chance of a digit changing, and a
digit in the fifth decimal place is a different street. The model is told *that* a pin
exists and what WhatsApp called the place; it is never given the numbers, so it cannot read
them out — "I have you at 6.80714, -58.15536" tells a customer nothing.

**What the delivery associate gets**

The new-order alert to `STAFF_NUMBERS` carries a tappable maps link, and the pin follows as
a WhatsApp map card that opens straight in their maps app. Texting an order number back
(`7`) returns the order plus its card again.

**Rejected coordinates**

Out-of-range values and exactly `0, 0` are refused rather than stored. `0, 0` is a real
point in the Gulf of Guinea and, as a delivery address, is always an uninitialised field.
The customer is asked to share the pin again rather than being told everything is fine.

### The delivery area

`DELIVERY_AREAS` is the area in words, for customers to read. The geofence is the same fact
as a circle, which a computer can check:

| Variable | Meaning |
|---|---|
| `SERVICE_CENTRE_LAT` / `SERVICE_CENTRE_LNG` | Where the shop is. In Google Maps, right-click your shop and click the numbers at the top of the menu to copy them. |
| `SERVICE_RADIUS_KM` | How far you will drive. `0`, or a blank centre, switches the check **off**. |

Set it in `store-settings.json` under `serviceArea` and run `npm run settings:apply`, or set
the three variables directly. `npm run check` prints the area it resolved, and fails loudly
on a half-set one — a radius with no centre would otherwise measure every pin against a
point in the Atlantic and refuse every order in the city.

**It ships switched off.** A shop that has not drawn its area has not said any pin is
unreachable, and a fence enabled by accident looks exactly like a broken bot.

**When a pin falls outside it**, the customer is told as soon as they share it — not at
checkout, after ten minutes of shopping. `place_order` refuses, the cart is left intact,
and the agent says a staff member will confirm whether a delivery associate can reach them. It is not
allowed to promise delivery, quote a surcharge for the distance, or suggest meeting the
delivery associate halfway. Staff see the distance and an `OUTSIDE` warning on the pin, so they can
still take the order by hand if the shop decides to make the trip.

The pin is stored either way — it is still where the customer is — and the distance is
computed from config on every read, so the radius can be retuned without touching data.

A circle is a crude shape for a delivery area, which really follows the river, the bridge
and the road. It is deliberate: a radius needs two numbers off a map and no GIS, and it
catches what it is for — the pin in another region or another country. Someone 200m outside
a sensibly drawn radius is a phone call for staff to make, not a rule to encode.

Distances use the haversine formula, so they are straight-line, not road distance. A pin
across a river is nearer than it can be driven, which is why the radius is a sanity check
and never a delivery quote.

---

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
| `STORE_NAME` | — | The name customers see, in the welcome and throughout |
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
| `PARCEL_FEE_BASE` / `PARCEL_FEE_PER_KM` | 0 / 0 | Unset means parcels are taken unpriced |
| `PARCEL_MAX_KM` | 0 | Refuse parcels further than this; 0 disables |
| `DRIVER_NUMBERS` | — | Delivery associates, comma separated. Required once restaurants are set up |
| `SEED_OUTLETS_PATH` / `SEED_MENU_PATH` | — | Outlets and menu CSVs imported at boot |
| `STAFF_NUMBERS` | — | Comma-separated E.164 digits. Empty means nobody is told about orders |
| `STORE_TIMEZONE` | `America/Guyana` | Used for greetings and the closing-time reminder |
| `TEMPLATE_ORDER_ON_THE_WAY` | — | Approved template, used only outside the 24h window |
| `TEMPLATE_ORDER_DELIVERED` | — | As above |
| `TEMPLATE_LANGUAGE` | `en` | Template language code |
| `SEED_CATALOG_PATH` | — | CSV imported at boot when the catalogue is empty |
| `SERVICE_CENTRE_LAT` / `SERVICE_CENTRE_LNG` | — | The shop's position, for the delivery-area check |
| `SERVICE_RADIUS_KM` | `0` | How far you deliver. `0` switches the check off |
| `TEMPLATE_KITCHEN_NEW_ORDER` | — | Reaches a kitchen outside the 24h window. Unset means staff are warned instead |
| `BACKUP_TOKEN` | — | Guards the backup downloads. 24+ characters, or the routes stay off |
| `BACKUP_DIR` | `backups` beside the database | Where snapshots are written |
| `BACKUP_EVERY_HOURS` | `24` | `0` switches automatic snapshots off |
| `BACKUP_KEEP` | `14` | How many snapshots to keep. `0` keeps every one |

### A note on `STORE_HOURS`

Written for customers to read, but also parsed — per day, so `Mon-Sat 8:00am - 8:00pm,
Sun 9:00am - 4:00pm` gives Sunday its own shorter day. Day ranges (`Mon-Sat`), day lists
(`Mon, Wed, Fri`), `Sun closed`, and hours crossing midnight (`6:00pm - 2:00am`) all read
correctly. A day you never list is a day off.

To trade around the clock, set it to **`24 hours`** — or `24/7`, `always open`, `open 24
hours a day` or `round the clock`, all of which read sensibly when quoted back to a
customer. There is then no closing time at all: orders are taken at any hour and the agent
never says deliveries have finished for the day.

This covers the shop's own window only. **A restaurant keeps its own hours**, so a kitchen
that shuts at seven cannot cook at two in the morning whatever the shop is doing. Groceries
and parcels run all night; food does not.

`/health` reports `storeHours` and `storeOpen`, so the live setting can be confirmed
without a shell.

**Outside those hours the agent does not say "we're closed."** It says when deliveries
start and keeps taking the order:

> Good morning! Next Minute Delivery here — I can build your grocery order right in this chat.
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
| `7 ready` | Food is cooked — sends a delivery associate to collect |
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
words — "out with the delivery associate", never "pending" — and **will not give a delivery time**,
since it has no way to know one and a guess becomes a promise.

A customer can name an order (`ORD-00007`), but the lookup is scoped to the number they
are messaging from. Order numbers are sequential and get read aloud, so an unscoped
lookup would hand anyone their neighbour's name and address for the price of a guess.

### Cancelling, and why

"Cancelled" on its own tells the customer nothing and leaves you no pattern to read later.
A kitchen that ran out of goat, a kitchen that is slammed, and an address nobody can reach
are three different problems.

So a bare `7 cancel` does not cancel. It asks:

```
Why is ORD-00002 being cancelled?

Tap one, or type the reason — the customer is told what it was.
[ 2 cust changed ]  [ 2 cant deliver ]  [ 2 sold out ]
```

The reasons offered depend on who is cancelling — a kitchen is never offered "customer
changed their mind". Three buttons, because WhatsApp allows no more, so the ones unique to
that role come first and anything else is typed: `7 cancel the cook did not turn up` is
kept verbatim.

The button titles **are** the commands, so a tap and a typed reason go through one parser.

Then the reason goes where it is useful:

| | |
|---|---|
| **Customer** | *"**A Taste of Guyana Roti Shop & Bakery** has cancelled your order: the kitchen has run out of something on it. Nothing has been charged."* |
| **Kitchen** | 🚫 *ORD-00002 cancelled — Customer changed their mind. Stop cooking it if you have started.* |
| **The record** | stored on the order, so the pattern is readable later |

The customer is told **who** cancelled, not an order number they can do nothing with — a
named restaurant is something they can act on, by picking another. But the shop cannot hide
behind a restaurant's name: a cancellation your staff made says so, because *"they cancelled
because you asked us to"* would be a lie, and an order you could not deliver is yours to own.

No invitation to write back, either. That implies the cancellation might be a mistake and
hands the chasing to the person who has just lost their dinner. The reason is what they
need; it tells them whether to try another dish, another kitchen, or come back tomorrow.

Telling the kitchen matters too: one that keeps cooking an order the shop cancelled is
wasted food and wasted money.

### A customer who wants to cancel

They get it stopped, or get it handed to someone who can — and either way the agent leads
with what has happened rather than what it cannot do.

| State | What happens |
|---|---|
| Kitchen has not accepted | cancelled there and then: *"ORD-00007 is cancelled, and nothing has been charged."* The kitchen is told to ignore the ticket |
| Anything further along | food may be cooking or with a delivery associate, so it goes to staff: *"I've passed ORD-00002 to the team to stop. They'll come back to you right here."* |

**The agent never announces its own limits.** "I can't do that myself", "you'll need to
speak to staff", "I'll try" — all of them tell the customer nothing useful and make the shop
look helpless. The rule is in the prompt and the tool enforces it: when an order is too far
along, the refusal handed back to the agent says in as many words *do not say you are unable
to do it*.

A customer can only cancel their own orders, checked against the number they are messaging
from — order numbers are sequential and read aloud.

### Offering jobs by distance

`ASSOCIATE_RADIUS_MILES` stops associates being offered collections far from them. **Off by
default** — set it to `5` and only associates within five miles of the pickup are told.

WhatsApp never reports where anyone is, so position comes from two places:

| Source | How |
|---|---|
| **A pin they share** | they send a location; the reply confirms it. Send another when they move |
| **Their last delivery** | the doorstep they were demonstrably standing at when they tapped *Delivered* — free, and needs no habit to maintain |

**Two rules matter more than the filter itself.** An associate whose position is unknown, or
older than `ASSOCIATE_LOCATION_TTL_MINUTES` (default 3 hours), is **always included** —
otherwise somebody who never shares a pin quietly stops getting work and nobody can say why.
And if the filter leaves nobody at all, **everyone is told anyway**, with a line in the log:
a long trip is a complaint, an order nobody hears about is a customer who never gets dinner.

### Several orders, one trip

Associates are **not** limited to one delivery. Three orders from the same kitchen are one
trip, and refusing the second would stop somebody doing exactly what they are standing at
that counter to do.

`jobs` shows what they are carrying and still offers more — flagging anything waiting at a
kitchen they are already visiting:

```
*With you now (2)*
ORD-00007 — on the way …
ORD-00008 — on the way …

*1 ready to collect*
ORD-00009 — cooked, waiting … — *same stop as yours*
```

**An order belongs to whoever collects it**, assigned when they tap *Collected* and released
when they deliver — not to whoever it was offered to.

`MAX_JOBS_PER_ASSOCIATE` imposes a cap if you want one; `0`, the default, means none. It is
a blunt instrument: it counts deliveries without knowing whether the next is a second bag
off the same counter or a pickup across town. Until it can tell those apart, leaving it off
is the honest setting.

### When an order stops moving

Every stage of an order has somebody waiting on it who will chase — a kitchen chases a
ticket, a customer chases a meal. **"Cooked, waiting for a delivery associate" has nobody watching it.**
The order is not late in the database; it is in a perfectly normal status. The first person
to notice is the customer, and by then the food is cold and the complaint is yours.

So the shop is told when one stops:

```
⏰ *ORD-00001* stuck — cooked, waiting for a delivery associate for 18 minutes

Cooked and sitting at A Taste of Guyana Roti Shop & Bakery.
No delivery associate has collected it.

Anita Persaud · +5926007002
$4,600 to collect
```

| Stage | Default | Setting |
|---|---|---|
| Placed, kitchen has not accepted | 10 min | `STALL_PENDING_MINUTES` |
| Cooked, no delivery associate has collected | 15 min | `STALL_ALERT_MINUTES` |
| With a delivery associate, not delivered | 60 min | `STALL_DELIVERY_MINUTES` |

Each stage alarms **once**. Moving the order clears the stamp, so one that stalls twice is
reported twice — but a sweep every two minutes does not re-send the same warning all night.
`STALL_ALERT_MINUTES=0` switches the whole thing off; a `0` on any one stage switches just
that stage off.

**It is a sweep, not a timer per order.** Timers die with the process: a deploy at 7:30pm
would silently cancel an alarm set at 7:21pm and nobody would ever know. The state lives in
the database, so the next sweep after a restart picks up exactly where it left off. The
order is stamped *before* the message is sent, so a send that fails cannot replay the same
alert every two minutes afterwards.

### The 24-hour rule

WhatsApp only permits free-form messages within 24 hours of the customer's last message.
Outside that window an approved template is the only route.

The notifier picks automatically. Same-day delivery is almost always inside the window, so
most updates need no template at all. For next-day updates, create two **Utility** templates
in WhatsApp Manager and set `TEMPLATE_ORDER_ON_THE_WAY` and `TEMPLATE_ORDER_DELIVERED`.
Parameters are `{{1}}` first name, `{{2}}` order number, `{{3}}` total.

With no template configured, an out-of-window update is skipped and logged rather than
failing silently.

### An order only goes forward

An order moves forward or it is cancelled. It never goes back.

This is not tidiness. **A tapped WhatsApp button does not disappear**, so every message
ever sent about an order keeps working forever. Tapping `Confirm` on an order already
cooked used to drag it back to confirmed and answer "-> confirmed" as though that were
progress - and tapping `Ready` after that dispatched a **second associate for one order**,
so two people rode out for one meal.

A move that would wind an order back is refused with what it actually is:

```
ORD-00031 is already *cooked, waiting for a delivery associate* - it cannot go
back to *confirmed*. Cancel it if something is wrong.
```

Tapping the stage an order is already at is not a backward move - it is somebody tapping
twice, and gets "already ready" rather than a refusal. Cancelling is allowed from any
stage, and is the one way out when something is genuinely wrong.

### What a kitchen reads after a tap

One line: which order, and where it now stands.

```
*ORD-00031* prepared, waiting for a delivery associate.
```

Not that the customer was notified, not that an associate was dispatched, not that the
shop was told. All of that is true and all of it is useful - to the people running the
shop, who still see every line. To a cook it is bookkeeping, and a cook who reads three
lines after every tap soon reads none of them.

The exception is anything a kitchen can act on, which is why the cut is worth making
rather than an inconsistency in it:

```
*ORD-00031* prepared, waiting for a delivery associate.
⚠️ Nobody has been sent to uplift this yet - ring the shop.
```

That one decides whether the food waits on a counter or on nobody. The same applies to a
cancellation nobody could be called off from: an associate may still turn up, and the
kitchen is the one who has to turn them away.

### An action is unavailable by being absent

**WhatsApp has no disabled button.** A reply button is on a message or it is not; there is
no greyed-out state to offer. So a step that is not allowed yet is simply not shown:

| Stage | Buttons |
|---|---|
| `pending` | `Confirm` · `Cancel` |
| `confirmed` | `Ready` · `Cancel` |
| `ready` | `Uplifted` · `Cancel` |

`Ready` appears only once an order has been accepted, so a cook cannot mark food ready for
an order nobody has taken.

Leaving it off is not enough on its own, and this is the part that is easy to miss:
**messages already sent keep their buttons**. A `Ready` button on a message from last week
still works. So the rule is enforced on arrival as well - a tap that arrives out of turn is
refused with what to do instead:

```
ORD-00031 has not been accepted yet - press *Confirm* first, then *Ready*
when the food is up.
```

### One message per step, no map cards

A delivery associate gets one message when the job arrives and one when they say they have
the food. Nothing else - no map cards at either end.

Addresses travel as links in the card itself. A link opens in whatever maps app they
actually navigate with, where a WhatsApp map card opens WhatsApp's own, and everything
about the job stays in the message they come back to rather than being spread over three.
Each link is announced rather than left bare, because a URL on its own in a message reads
as something to ignore unless it says what it opens.

The message after uplifting is one line and a button: *ORD-00031 on the way*, with
**Delivered**. Everything needed on the doorstep - the address, the link, the door
description, the phone, the cash - is on the job card they accepted, and repeating it only
buries that card further up the chat.

### What else is on the counter

When a kitchen notes an uplift, it is also told what it has left behind:

```
*ORD-00043* uplifted at 17:51
2 earlier orders ready and waiting: ORD-00041, ORD-00042
```

The second line appears only when there is something to say - the oldest order waiting
gets the first line alone.

Counted by when the **customer placed** the order, not when the food was ready: that is
the queue the customer is in, and an order that jumped it is the thing worth seeing. Only
orders that are **prepared and still there** count - nothing is going cold that has not
been made - and the orders are named rather than only counted, because a count says there
is a problem and the numbers say which bag to look for.

### How a food order says goodbye

The delivered message thanks the customer, and a food order adds a line:

```
Order ORD-00043 delivered. Thank you for choosing Next Minute Delivery!
Enjoy your meal!
```

Seven lines are in rotation, each with an emoji matched to it - a wave on *see you next
time*, a speech bubble on *message us any time to order again*, a plate on *Bon appétit*.
That last line does two jobs, since a reply from the customer also reopens WhatsApp's free
messaging window.

**Food only.** A bag of rice or a parcel carried across town gets the thank-you alone.
Wishing somebody a good meal over a delivery that was not one reads as a machine that does
not know what it delivered. Which order is food is decided by whether a kitchen cooked it,
not by a label that could be wrong.

**Chosen by order number, not at random.** Varied across customers, fixed for any one
order - because this message can be sent twice, through a retry or a template fallback or
a dispatcher re-closing an order, and a customer who gets two goodbyes in different words
is talking to something unwell.

### Clocking on and off

An associate sends **`on`** to start a shift and gets a button to end it:

```
🛵 You are on duty, Rider. Jobs will come to you.

You will be clocked off automatically after 12 hours, so send *on* again tomorrow.
[ Clock off ]
```

Two letters to start, one tap to stop. The end of a shift is when somebody is tired and
least likely to type, so that is the half that gets the button. `in`, `start`, `working`,
`out`, `stop` and `finished` all work too.

**Sharing a pin also clocks them on.** It is somebody telling you they are out working,
and doing both in one action is the difference between a rule people follow and one they
forget.

**A shift lapses by itself** after `ASSOCIATE_DUTY_HOURS`, 12 by default. Somebody will
forget, the shop trades around the clock, and a forgotten shift means job cards at three
in the morning - after two of those an associate mutes the chat and is lost for the shifts
that matter. They are told about the limit as they clock on, so it is never a mystery,
and nothing sweeps for it: the age is worked out when the question is asked.

Clocking off does not abandon what is already in the bag - somebody carrying two orders is
told so plainly.

**If nobody is clocked on, the job goes to everyone anyway** and staff are warned. An
associate who gets a card off duty is mildly annoyed; an order nobody hears about is a
customer with no dinner.

### Twelve hours in a day, however it is split

A shift lapsing after twelve hours is not a limit on its own: four hours on, clock off,
clock back on, and there are twelve more. So hours are counted across **every stretch in
the last 24**, and clocking on is refused once the total reaches
`ASSOCIATE_MAX_HOURS_PER_DAY`:

```
🛑 You have worked 12 hours in the last 24.

The limit is 12. You can clock on again from 23:20.
```

Rolling 24 hours rather than a calendar day, because a limit that resets at midnight lets
somebody work eleven at night through to eleven the next evening and never break it.

Sharing a pin does not get round it either - the easy way in must not also be the way
round the rule. And the time they can return is worked out from when past shifts actually
fall out of the window, not guessed at.

**A shift nobody closed counts only as far as it would have lapsed.** Somebody who forgot
to clock off last night did not thereby work all night, and banking those hours would lock
them out of a shift they are entitled to.

Set `ASSOCIATE_MAX_HOURS_PER_DAY` to `0` to switch the cap off.

### Proof of delivery

Every order gets a four-digit code. The customer receives it with the on-its-way
message, in their own language, and reads it out at the door:

```
Code Tester, your order ORD-00017 is on its way 🛵
Total $2,350, payable to the delivery associate.

Your delivery code is *2149* — read it to the delivery associate
at the door, so we know your order reached the right hands.
```

Typing those four digits **is** the delivery, so the associate's card carries no
Delivered button at all:

```
🛵 ORD-00047 on the way

🔐 Type the four-digit code from Marcia to close it.
No code? Reply *no code*.
```

One action at the door instead of three, and no button marked Delivered that
does not deliver. There is deliberately no **No code** button on that card
either: the only button on the message an associate works from becomes the path
of least resistance, tapped out of habit, every drop unverified. It appears on
the wrong-code reply, which is when somebody actually needs it:

```
❌ That is not the code for ORD-00047.

Ask Marcia to read it from our message. 2 tries left.

                                   [ No code ]
```

The close tells the customer how it went, as a receipt line before the thanks
rather than in place of them - the order did arrive, and the only thing in
question is how that was proved:

```
Order ORD-00048 delivered.
Delivery code: confirmed.

Thank you for choosing Next Minute Delivery!
Bon appétit! 🥘
```

And when it could not be confirmed:

```
Order ORD-00047 delivered.
Delivery code: not confirmed.

Thank you for choosing Next Minute Delivery!
Enjoy every bite! 😋

Anything wrong with this order? Just message us.
```

The invitation to write back comes last, so the actionable line is the one left
on the screen - and a warning never lands immediately before "enjoy your meal".
Translated into all four languages, since a customer who ordered in Spanish is
not told this one thing in English.

A customer whose order **never had** a code hears nothing about codes: an old
order, or one dispatched outside the 24-hour window. They had nothing to
confirm, and a note about a missing code would be nonsense.

An order with **no** code keeps its Delivered button — there is nothing to type,
so taking it away would strand them. Typing `47 delivered` still works as well:
the button is gone from the card, the word is not gone from the language.

**No operator message carries the digits** — not the job card, not `jobs`, not
the dispatch alert, not the CSV export. The code is not on the order object the
operator messages are built from, so there is nothing for a future edit to print
by accident. A code the person at the door can read off their own screen proves
nothing.

It never blocks a delivery. Tapping **No code** closes the order anyway, records
it unverified, and tells dispatch who it was:

```
⚠️ ORD-00018 — delivered, code not verified

Rider One (NEW 5678) +5926001111 reports the customer
could not give the code.
Customer: Code Tester +5926007777
```

Food going cold at a door while somebody hunts for a message is a worse failure
than an unverified drop. The record is what makes a pattern visible — one of
these is a flat battery; a dozen from the same person is something else.

Three wrong guesses spend the code. Four digits is nine thousand possibilities,
which nobody tapping a phone will exhaust — but an associate who can guess
freely can verify a delivery without the customer, which is the one thing the
code exists to prevent. A spent code still delivers, just never as verified.

A parcel is the strongest case: the person at the door is not the person who
placed the order. The sender gets the digits and passes them to whoever is
receiving, which is the only way the shop can show the parcel reached the right
hands rather than a doorstep.

The export keeps two columns, **Code sent** and **Code verified**, so three cases
stay distinguishable: no code issued, a code the customer never received, and a
code read back at the door. One combined flag would file the middle case as a
failure — and that is the one nobody is at fault for. It happens when an order
is dispatched outside WhatsApp's 24-hour window, where the fixed template cannot
carry digits; the associate is then never asked for a code they were never given.

Set `DELIVERY_CODE` to `false` to switch it off.

### Delivering somewhere the customer is not

WhatsApp's location screen is not only *send where I am*: the map can be
dragged and the pin follows it, and a place can be searched for. Almost nobody
knows that unless they are told, so one sentence is appended to every pin
request, in the customer's own language:

```
Send me the delivery pin and I will get this moving.

Not where you are now? Drag the map, or search for the place,
before you send it.

                                   [ Send location ]
```

Fixed text, added by the code rather than left to the model. It is the one
sentence that decides whether a customer away from the address can order at
all, and a model that paraphrases it four times out of five loses the fifth
order. It is also not repeated if the model happens to have said it already.

Nothing downstream changes: the customer sends a real pin, so the order gets a
map card, a service-area check and a navigable link exactly as any other does.

Dragging the map is confirmed on Android, which is most of Guyana; iOS guidance
is less consistent.

A customer who still cannot send one gives the address in words, and the order
goes through on that. It used to be refused outright with a promise that a staff
member would take it by hand — there are no staff, so that was a dead end that
lost the order. The model must have asked for the pin, been told no, and saved
an address; an order with neither is still refused, because the associate would
have nowhere to go and nothing to read out.

The job card then leads with the problem rather than burying it under the phone
number, since it decides whether they navigate or telephone — and carries no map
link, because there are no coordinates to put in one. The written address is the
whole answer, and a sentence saying so would only repeat the banner:

```
⚠️ NO PIN — ring before you set off

Deliver to: Marcia Persaud
Lot 77 Mocha, East Bank
Call at the junction, white fence
📞 +5926123456

Collect $235,000 cash
```

The honest cost: a written address cannot be measured against the delivery
radius, so such an order skips the service-area check. The associate reading it
before setting off is the only check left. The human who resolves it is the one
going there anyway — not an administrator.

### One name for the person who delivers

They are a **delivery associate** — in every message, to everybody, in every
language. Never a driver, a rider or a delivery man.

That last one is why this is written down. The ordinary trade word in each
language is perfectly polite in it: `repartidor`, `entregador`, `配送员`. But
all three come back from a translator as *delivery man*, which is exactly how
this was noticed — a customer read their own message through WhatsApp Translate
and it said "Completely $5,900, pay the delivery man". The Spanish had been
`Total $5,900, a pagar al repartidor`, which is correct Spanish and the wrong
words for this shop.

So all four now use the role as a job title: `asociado de entrega`,
`associado de entrega`, `配送专员`. The agent is told the same thing, since it
writes its own prose and would otherwise reach for whatever is idiomatic.

The Chinese also stopped saying 他 — *him*. Nobody knows who will be sent, so no
message should guess.

A test walks every language and every message that names the role, and fails on
any of the six banned words.

### Delivering to somebody other than the buyer

A customer often orders for someone else. The card used to name the buyer and
carry the buyer's number, so at the door the associate had the wrong name and a
phone that rang across town. Now the two are separated, and only when they
differ:

```
*Ordered by:* Marcia Persaud
📞 +5926100001 — ring about the order

*Deliver to:* Dave Singh
Lot 4 Section C, Diamond
White fence, upstairs
📞 +5926100099 — ring at the door
📍 https://www.google.com/maps?q=6.642000,-58.218000

*Collect $235,000 cash* from Dave Singh (3 items + delivery)
```

Each number says what it is for: two bare numbers on one card is where a wrong
call comes from. The cash line names who hands it over, because *Collect
$235,000* with two names on screen is the same confusion in a more expensive
form. On a self-delivery none of this appears — it would repeat a name and
number already on screen and push the address down a card read on a bike. On a
parcel the sender is already the *Uplift from:* block, so they are not named
twice.

**Ordered by shows the number they are messaging from.** It used to show
`contact_phone`, which means "the best number for this delivery" — and on an
order for somebody else that is naturally the recipient's. So the card printed
Jenny's number under *Ordered by: Patrice*, and then the same digits again under
Jenny's name: one number, two people, both labelled with confidence.
`contact_phone` now does the job it was named for, at the door.

**The order carries its own address.** `address` used to live only on the
customer, so an order going to somebody else had one slot for two different
addresses — the buyer's and the recipient's. The agent did the only thing it
could: it put one in the field with an instruction attached and wrote the other
into the free-text note, and the card came out carrying two delivery addresses
that disagreed, plus a briefing repeating everything the card already prints.
`place_order` now takes `delivery_address` for that order alone, and the
customer's own address is left where it belongs.

The note is capped at 120 characters and described as what it is: one line of
doorstep detail. The prompt lists what the card prints for itself — both names,
both numbers, the address, the NO PIN flag, the cash — so there is nothing left
worth repeating.

**Whose pin is it?** Every order copies the buyer's saved pin at checkout. On a
delivery to somebody else that pin is the buyer's own door — so a map link built
from it sends an associate confidently to the wrong house, with a written
address directly above saying somewhere different. A confident wrong answer is
worse than none, because the associate trusts it and drives there.

So a third-party order shows a link only when the buyer shared a pin **for the
recipient** during that order. The agent asks for one — *"can you drop the pin
on where Jenny is?"* — and when none comes, the card is flagged NO PIN and the
associate rings. That is the right answer, not a failure.

**The pin label is dropped when it repeats the address.** WhatsApp attaches a
place name to a shared location, and more often than not it is the same text as
the saved address, printed twice. It is kept only when it says something new.

When the recipient's number is unknown the card admits it rather than printing
an empty field:

```
📞 no number for Dave — ring Marcia Persaud on +5926100001
```

**The delivery code follows the recipient.** They are the one at the door, so
the buyer is told to pass it on — WhatsApp refuses a business-initiated message
to a number that has never written in, so the code cannot be sent to Dave
directly. Without this, every third-party delivery would end with the associate
tapping *No code* and the unverified count would stop meaning anything.

```
The delivery code is *2149* — give it to Dave Singh, who reads it
to the delivery associate at the door, so we know the order reached
the right hands.
```

### One order in hand, start to end

An associate carries one order at a time. Nothing new can be uplifted until the
one they have is delivered, so the shop always knows exactly what each of them
is holding. The refusal doubles as the reminder, and repeats everything the job
card said — that card is buried up the chat by now:

```
🛑 Finish ORD-00023 first.

*ORD-00023* — Marcia Persaud
Lot 4 Section C, Diamond
📞 +5926100001
https://www.google.com/maps?q=6.642000,-58.218000
Collect $235,000 cash

ORD-00030 stays where it is — someone else can take it, or
come back for it.
```

`jobs` leads with the same thing, since an undelivered order is the only item
on that list they cannot put off.

The price, plainly: two orders from one kitchen are a single trip, and this
refuses the second even though the associate is standing at that counter.
`MAX_JOBS_PER_ASSOCIATE` raises the limit; 0 switches it off.

#### The other half: the order must not be stranded

Holding somebody to one delivery means food can be cooked with nobody free to
fetch it. The two filters that pick who to dispatch to — on duty, within reach —
both fall back to telling *everybody* rather than nobody, on the principle that
a filter which leaves nobody is a filter that should not have run. The busy
filter cannot do that, because the point of it is to avoid offering a job that
would be refused. So it needs the opposite remedy: the job is re-offered the
moment capacity appears.

An associate is offered the oldest waiting job when they finish a delivery, when
an order they were carrying is cancelled out from under them, and when they
clock on. Nobody has to send `jobs` to find work that was already cooked.

And the kitchen is told the truth. Every associate being out is a queue, not a
fault, and must not read like one — sending a kitchen to ring the shop at the
busiest moment of their day points them at somebody who can do nothing about it:

```
ORD-00202 prepared, waiting for a delivery associate.
⏳ Every delivery associate is out. This will be collected as soon
   as one is free.
```

An empty `DRIVER_NUMBERS` is a different thing entirely — a shop that cannot
deliver at all, which somebody must fix — and still reads as a warning. Folding
the two into one outcome is what produced "nobody has been sent — ring the
shop" while an associate was out working normally.

**A mistyped order number is named as such.** A code typed against an order they
are not carrying used to be compared against that order and answered "not the
code — 2 tries left", which burned a stranger's code three times over and left
that delivery unverifiable by the customer actually holding the digits. The
other order is now left completely untouched:

```
ORD-00024 is not with you.

You have ORD-00023.

Check the order number and send it again, like `23 1234`.
```

The same answer whether the digits were right or wrong — it is the number that
is wrong, not the code.

### What a settled order says, and to whom

An order that is cancelled or delivered cannot move, and the message saying so
used to be the same for everybody: *"cannot be changed. Do not prepare it."* An
associate cannot unprepare anything. Standing somewhere holding food for an
order that was cancelled while they drove, they learned nothing they could act
on.

Now it depends who is reading. The associate:

```
🛑 ORD-00023 was cancelled — kitchen ran out.

Do not deliver it, and do not collect any money.
Take it back to A Taste of Guyana.
```

The reason, so they can answer a customer who appears at the door; **do not
collect any money**, because that is the expensive mistake; and somewhere to
take it, which is actionable with nobody to ring. A cancelled parcel goes back
to whoever sent it, not to a kitchen it never had.

The kitchen keeps *Do not prepare it* — right audience, right instruction.
Staff get the plain fact with no doorstep advice.

A settled order also never reaches the code logic at all. A wrong code on a
cancelled order used to answer *"2 tries left"*, inviting an associate to keep
trying to complete something that was over; and an old order with no code was
told to *"send 23 delivered to close it"*, which is worse — an instruction to
deliver something already cancelled. Its job-card view no longer prints
`Collect $235,000 cash` under the word *cancelled* either, which was an
instruction and a contradiction on one card.

### An order that never had a code is not a failed code

These are different facts and the export keeps two columns to tell them apart.
One branch collapsed them anyway: typing a code against an order with no code
warned dispatch that the code *"could not be confirmed"* and then forced a
delivery off what may have been a mistyped message. Both were false — the order
had no code and was never delivered — and it corrupted the one count that makes
unverified deliveries visible. It now says so and stops.

### An associate can never cancel

Their own handler allows only uplifted and delivered. A second guard sits inside
the one function every actor passes through, so no future caller can open the
door either. An associate is at a doorstep with the food in their hand: whatever
has gone wrong there, voiding the order is not the answer, and a cancellation is
the one move with no way back. A code that will not verify delivers unverified;
nobody home is a conversation for the shop.

A four-digit message with nothing waiting on a code is also answered directly
rather than falling through to the order-number parser — otherwise `2149` could
be read as order 2149, which is how a code attempt could reach an order it has
nothing to do with.

### Counting the cash

The shop trades cash on delivery, so at the end of a shift somebody is carrying
money. Every order already records its total and who carried it — this adds the
arithmetic, which is the part that was missing.

Staff send `cash`:

```
💰 Cash today — Thursday 12 November

Rider One (NEW 5678) — 6 orders, $1,625,000
Rider Two (PLL 1234) — 2 orders, $470,000
Closed by the shop, nobody named — 1 order, $235,000

9 orders, $2,330,000 in all

Delivered and paid in cash. Card orders are not counted —
nothing changes hands.
```

An associate sends `cash` to check their own figure against their own pocket,
and clocking off states it unprompted — the one moment they are certain to read
it, since nobody can hand over money they were never told the amount of:

```
👋 You are off duty. No more jobs will come to you.

💰 6 deliveries for cash — $1,625,000 to hand in.
```

Three deliberate choices. **Delivered cash only**: an order on its way is money
nobody is holding yet, a cancelled one is money that never existed, and a card
payment leaves nothing to hand over. **Orders closed by a dispatcher are shown
as a row of their own** rather than dropped or attributed to a guess — they have
no associate's name on them, and a total that does not reconcile to the till is
worse than an awkward row. **Both the shift and the day** are reported when they
differ: a figure for the shift alone understates what somebody who worked this
morning is carrying, and a figure for the day double-counts anything already
handed in.

Counted from midnight on the store's own clock, via `STORE_TIMEZONE`'s
offset read out of the zone's own formatted parts. The tempting one-liner for
this — reparsing a formatted date string — silently uses the *server's*
timezone, so it gives the right answer only when the server happens to be
somewhere else. On a server already set to Guyana time the day started at 20:00
the previous evening. The suite runs under four server timezones for that
reason.

### A copy that is not on the server

Snapshots are written beside the database. That survives a bad write, a bad
migration or a mistaken delete — it does not survive losing the disk, which is
the failure that ends a business rather than inconveniencing it.

So a copy goes off the machine over WhatsApp, every `BACKUP_SEND_HOURS`, to
`BACKUP_TO` (or the first staff number). WhatsApp rather than email because the
credentials already exist: no new account, no SMTP host, no third service to go
wrong, and it lands on the phone the shop is already run from. A backup that
needs somebody to remember a password is a backup that stops happening.

Two files, because they fail differently — the CSV is what a person opens six
months later to find out what an address was, and the JSON is what rebuilds the
table, since flattening an order into a row loses the item lines.

Staff can also pull one at any time with `backup`. That matters: a
business-initiated WhatsApp message is refused more than 24 hours after the
recipient last wrote in, and the one person certainly inside that window is
whoever just typed the command. The scheduled push is not run on boot, so a
host that restarts the process a few times does not send the owner a backup each
time.

**The file holds every customer's name, address and map pin.** That is the point
of keeping it and the reason it goes to one number rather than to all staff. The
caption says not to forward it.

### Where the associates are

Staff send `where`:

```
*Delivery associates*

🟢 *Rider One · GSS 1234*
   +5926001111
   📍 6 min ago (pin they sent)
   https://www.google.com/maps?q=6.806500,-58.148900
   Carrying ORD-00043

⚪ *Rider Two · CVC 5678*  (off duty)
   📍 3 hours ago (last drop-off) ⚠️
   ...
```

`where <name>` sends that associate a location request they answer with one tap, rather
than asking somebody on a bike to type an address.

**There is no live tracking, and there cannot be.** WhatsApp's live location is a consumer
feature; a business number receives pins, not a track. What exists is the last position
each associate gave, from one of two places: a pin they sent, or the doorstep of their
last delivery - the one position nobody has to ask for, because they were demonstrably
standing on it when they tapped **Delivered**.

Which is why every line says how old it is, and anything over an hour is flagged. Six
minutes old is where somebody is; three hours old is where they were, and a dispatcher
who cannot tell the two apart is worse off than one with no position at all.

### Who carried an order

Associates are CSV lines in the **`ASSOCIATES`** environment variable, set in the host's
dashboard:

```
phone,name,vehicle,active
5926001111,Rider One,GSS 1234,1
```

Only `phone` and `name` are required - a shop running unplated motorbikes has nothing to
put in `vehicle`.

**Not in the repository, unlike the menu.** A menu is catalogue data; a list of your
employees' names and mobile numbers is not, and this repository is public. `data/sample-associates.csv`
holds invented people so the format is visible, and `SEED_ASSOCIATES_PATH` still reads a
file for anyone who wants one - but `ASSOCIATES` takes precedence, so a sample can never be
mistaken for the real thing.

When an associate takes an order, their name and vehicle are **copied onto it** alongside
the number. Not looked up later: someone who changes van next month must not rewrite which
van carried an order last week, and someone who leaves must not erase themselves from the
orders they delivered.

It shows wherever the question is asked - the staff view of an order, the alert when a
kitchen reports an uplift, and three columns in the backup export:

```
🛵 Rider One · +5926001111 · GSS 1234
```

A number with no directory entry still records the number. Knowing a little beats losing
the one fact there was.

`DRIVER_NUMBERS` still decides who is offered a job. This answers who they are.

### Four languages

English, Spanish, Portuguese and Chinese. A customer who writes in one is answered in it,
from the welcome to the last line after delivery.

**The conversation was never the hard part.** The agent is told to match the customer's
language and does, in any language, including from a photographed shopping list. What
stayed English was everything the model does not write - the welcome, the four services,
every status notification, the cancellation messages. Those are deliberately fixed so they
read identically every time, which meant a customer could order entirely in Spanish and be
thanked in English.

Those fixed messages are now written out once per language rather than translated at send
time. Translating on the fly would cost a call per notification, add latency, and put text
in front of a customer that nobody at the shop can read - a wrong price or a garbled
cancellation reason going out unreviewed.

**How the language is known.** From what the customer wrote, on the first message, before
anything replies - so even the welcome comes back in their language. Chinese is read from
its characters; Spanish and Portuguese from words that differ between them (`quiero`
against `quero`, `gracias` against `obrigado`), never from the ones they share. Nothing is
guessed from a phone's country code: a Guyanese number is no evidence of a language in a
country that speaks nine.

It is only ever set, never cleared. `ok` and a thumbs up give nothing away, and a
one-word reply must not reset somebody who has been writing Portuguese all along.

**Everything the customer reads, start to finish.** The welcome, the four services, the
restaurant list with its prep times and delivery fees, the line that opens each service,
every status update, the cancellation and its reason, the closing line after delivery. The
agent translates what it says about the menu too, giving each dish's name as the menu has
it with a short translation beside it - so the customer knows what they are ordering and
the kitchen still gets a ticket it recognises.

**Staff, kitchens and delivery associates are always in English.** Whoever is ordering,
the people running the shop read one language, and a ticket in a script the cook cannot
read is worse than useless. A test holds this: a customer writing Chinese produces not one
Han character in anything sent to a kitchen, an associate or the shop.

Two things are deliberately left as they are. A restaurant's own description of its cuisine
comes from its CSV row in its own words - translating it would be putting words in
somebody's mouth. And a cancellation reason a dispatcher typed by hand is passed on exactly
as typed, because inventing a translation of somebody's sentence would be guessing at what
they meant, in front of the customer.

### Timing an order

Two moments are stamped on every order as they happen, and never moved afterwards:

| Stamp | Set when |
|---|---|
| `ready_at` | the kitchen marks the food ready |
| `uplifted_at` | a delivery associate says they have it |
| `handed_over_at` | the kitchen reports the food was uplifted from its counter |

`updated_at` cannot answer this - every later move overwrites it, so by the time an order
is delivered it has forgotten when it was ready. Each stamp is written once, because a tap
on an old message would otherwise move it and quietly flatter every number derived from
it.

**Who sees them.** Staff, and nobody else. Looking an order up shows the gaps as
durations rather than clock times, because nobody reads two timestamps and subtracts:

```
Ready 17 min after ordering
Uplifted 9 min after that
```

While an order is still waiting the line counts up instead - *Waiting 9 min for a delivery
associate* - because the number still running is the one worth acting on.

The backup export carries both stamps, the handover, and the two gaps as plain minutes, so
a spreadsheet can average them across every order rather than one at a time.

Nothing is sent to anyone at the moment a stamp is written. A message per timestamp is
noise and costs money, and the case worth knowing about - food sitting too long - is
already covered by the stall watch, which speaks by exception rather than narrating.
**The customer never sees any of it**: "ready at 1:05, uplifted at 1:22" only invites a
question about the seventeen minutes in between.

### Who says the food has left

Both the kitchen and the delivery associate get a button marked **Uplifted**, because both
of them say the word. They mean different things by it, and the system treats them
differently.

| Who taps it | What it means | What happens |
|---|---|---|
| Kitchen | The food left my counter | The time is recorded. Nothing else |
| Delivery associate | I have the food | The order moves to on the way, and the customer is told |

Only the person carrying the food can say it is on its way, so only their tap tells the
customer. The kitchen's tap is a clock: it measures the gap between food being prepared and
food leaving, which is the thing a kitchen and a shop otherwise argue about from memory.

The handover time is written once and never moved, so a second tap on an old message cannot
rewrite it. It also changes what a stall alert says: an order prepared an hour ago reads
differently when the kitchen has already handed it over, because then the food is not
sitting on a counter - it is with somebody who has not said so, and the person to ring is
the associate rather than the kitchen.

What the kitchen still cannot do is close an order. Delivered is the doorstep, and only
whoever stood on it can say so.

### Buttons say one word

A tapped WhatsApp button sends back two things: what it said, and the id we gave it. The
order number rides in the id, which nobody sees, so the button itself can read `Delivered`
rather than `Delivered 31`. The detail is already in the message above it.

| Who | What they see | What the tap means |
|---|---|---|
| Kitchen | `Confirm` · `Ready` · `Cancel` | `31 confirm` · `31 ready` · `31 cancel` |
| Staff | `Confirm` · `Ready` · `On the way` · `Delivered` · `Cancel` | the same, with the order number |
| Delivery associate | `Uplifted` · `Delivered` | `31 on the way` · `31 delivered` |
| Cancelling | `Sold out` · `Too busy` · `Closing` · `Customer asked` | `31 sold out`, and so on |

Only ids the system recognises are translated. **This matters more than it looks:** the
agent builds its own buttons for customers, whose titles are meaningful sentences the model
must receive as written — reading those taps as ids would feed it `option_1` instead of
`Grocery shopping`. Anything unrecognised keeps its title, which also keeps buttons sent
before this change working, since their titles still carry the number.

Typed commands are unchanged: `31 ready`, `ORD-00031 delivered` and the rest all still work,
and a tap and a typed command still meet in the same parser.

### Kitchens and the window

A kitchen is the hard case. A customer has just messaged to order, so their window is open
by definition — but a restaurant has no reason to message the shop each morning, so the
**first ticket of the day routinely lands on a shut window** and Meta refuses it. The order
then sits at `pending` with nobody aware the kitchen never saw it.

The ticket path therefore checks the window first:

| Window | What happens |
|---|---|
| Open | The ticket is sent as normal, and recorded as delivered only if Meta accepted it |
| Shut, template set | `TEMPLATE_KITCHEN_NEW_ORDER` is sent instead, carrying just the order number |
| Shut, no template | Staff are warned by name: *"ORD-00031 could not reach A Taste of Guyana. Ring them."* |

The template carries a **quick-reply button**. Tapping it counts as an inbound message, so
the window opens, and the held ticket — with its Confirm and Food ready buttons — is
delivered the moment they reply. Any message from a kitchen triggers that flush, not just
the button.

Two rules keep this honest. An order is marked as delivered to the kitchen **only when Meta
actually accepted it**, so a refused send stays owed. And only live orders are ever flushed,
with every pre-existing order treated as already delivered — so switching this on cannot
bury a kitchen under a month of history for saying hello.

Create the template in WhatsApp Manager as **Utility**, with one body variable:

```
New order {{1}} from Next Minute Delivery. Tap below to open it.
```

## Keeping a copy of the orders

Every order, every customer and every saved address lives in one SQLite file on one
hosted disk. The orders are replaceable; the **addresses and pins are not** — they were
typed once by a customer who will not type them again.

Two layers, because they fail differently.

**A snapshot on the disk.** Taken on every boot and then every `BACKUP_EVERY_HOURS`
(default 24), into `BACKUP_DIR`, keeping the last `BACKUP_KEEP` (default 14). It uses
SQLite's own online backup, so it is safe to take while the agent is serving — copying a
live database file with `cp` can produce a torn file that only reveals itself the day you
need it. This survives a bad write, a bad migration and a mistaken delete. It does **not**
survive losing the disk, because it is on the disk.

**A download off the disk.** The only copy that survives the host:

| URL | What you get |
| --- | --- |
| `/backup` | What is available, and when the last snapshot was taken |
| `/backup/orders.csv` | Every order as a spreadsheet — opens in Excel |
| `/backup/orders.json` | The same orders, complete and nested, for restoring |
| `/backup/store.db` | The whole database, snapshotted on request |

The spreadsheet has a column for each thing worth keeping: order number, time placed,
status, customer name and phone, delivery address, latitude and longitude, a tappable map
link, the delivery note, the restaurant, the pickup address, the delivery associate who
carried it, what was ordered, the subtotal, the delivery fee and the total, the payment
method, parcel recipient and contents, and who cancelled it and why.

### The token

These URLs return every customer's name, address and GPS pin, so they are the one part of
the service with a password. Set `BACKUP_TOKEN`:

```bash
openssl rand -hex 24
```

Three rules, in order of how much they matter:

1. **No token, no routes.** Not a 401 — the paths do not exist. A half-configured deploy
   cannot leave the customer list open while somebody means to get round to it.
2. **A short token is refused like no token.** Under 24 characters and the routes stay off,
   with a warning in the log. A weak password on a URL like this is worse than none,
   because it reads as protection.
3. **A wrong token gets the same flat 404** as an unconfigured service, compared in
   constant time, so probing cannot tell "wrong password" from "no such thing here".

Pass it as a header, or as `?key=` so a link can simply be tapped:

```bash
curl -H "Authorization: Bearer $BACKUP_TOKEN" https://your-service.onrender.com/backup/orders.csv -o orders.csv
```

The query form is there because the person who needs a backup is usually holding a phone,
not a terminal, and a link they can tap is the difference between a backup taken weekly and
one taken never. The cost is real: **a URL lands in the host's request log**, so treat the
link itself as the password and rotate `BACKUP_TOKEN` if it goes anywhere it should not.

`/health` reports whether backups are configured, how many snapshots are on the disk and
when the last one was taken — never the token, and never a path to the data. It is enough
to notice that backups have silently stopped.

With a shell, `npm run backup` writes all three files into `BACKUP_DIR` locally.

## What is not built yet

Named plainly, because you will want some of these before going live:

- **No staff dashboard.** The WhatsApp queue works well for one shop; volume would want a
  screen.
- **No payments.** Deliberate — cash or card to the delivery associate, as chosen.
- **SQLite, single process.** Fine for one store and a few thousand products. Multiple
  instances behind a load balancer would need Postgres and a shared lock for the
  per-customer serialisation.
- **The geofence is a circle, and off by default.** It catches a pin in the wrong region,
  not one on the wrong side of a river. Set `SERVICE_RADIUS_KM` to switch it on.
- **Voice notes are built but switched off.** Set `TRANSCRIBE_PROVIDER` and the matching
  key to turn them on; without it a voice note gets a polite "could you type that".

---

## Project layout

```
src/
  server.ts              Express app, startup checks
  config.ts              Environment config, money formatting
  conversation.ts        Shared entry point for every channel
  location.ts            Location pins: validation, distance, the delivery-area check
  agent/
    run.ts               The agent loop (tool calls, history, error mapping)
    context.ts           Local time and returning-customer recognition
    pacing.ts            Reply splitting and typing delays
    tools.ts             Tool definitions and their implementations
    system-prompt.ts     Behaviour, tone, guard rails
  channels/
    whatsapp.ts          Webhook verification, parsing, routing
    whatsapp-send.ts     Graph API sending (text, buttons, pins, templates)
    simulator.ts         Browser test channel
    types.ts             Channel-neutral message shapes
  notifications.ts       Staff alerts and customer status updates
  staff.ts               Dispatch commands over WhatsApp
  order-status.ts        Order lifecycle vocabulary and action buttons
  services.ts            The welcome and the four numbered services
  onboarding.ts          Adding a restaurant from a menu photo
  menu-reader.ts         Reading dishes and prices off a photograph
  hours.ts               Parsing free-text opening hours
  parcels.ts             Parcel pricing and what may not be carried
  availability.ts        Stock for shelves, sold-out for kitchens
  menu-options.ts        Size, spice, sides — parsing, pricing, validation
  restricted.ts          Alcohol and tobacco, refused at import
  dispatch.ts            Kitchen tickets and delivery associate job cards
  backup.ts              Order exports and database snapshots (also a CLI)
  catalog/
    import-csv.ts        CSV parser and importer (also a CLI)
    import-menu.ts       Outlets and menus (also a CLI)
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
npm run import:menu -- ./data/sample-outlets.csv ./data/sample-menu.csv   # outlets and menus
npm run smoke                                          # offline test suite
npm run backup                                         # export the orders and snapshot the database
npm run check                                          # configuration doctor
npm run typecheck                                      # tsc --noEmit
```
