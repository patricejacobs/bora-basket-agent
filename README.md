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

### One map card at a time

An associate gets one map card when the job arrives - the **uplift** - and the second when
they say they have the food:

```
job arrives     job card                      then  map card: Uplift - A Taste of Guyana
taps Uplifted   map card: Anita Persaud       then  delivery card + [Delivered]
```

Both pins used to arrive together with the job. Two map cards side by side is how somebody
glancing at a phone on a bike navigates to the customer instead of the restaurant, and for
the next fifteen minutes the destination is not where they are going.

**The card and its map cannot be one message.** A WhatsApp location message carries a
latitude, a longitude, a name and an address, and nothing else - no body, no buttons - so
anything to read or tap travels separately. The nearest thing available is what is done
here: a map card has exactly two lines, a name and an address, so the name carries the
customer and the second line carries the coordinates as a link. The street is on the
delivery card directly above it.

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
