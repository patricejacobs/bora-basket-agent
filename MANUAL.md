# Next Minute Delivery — Manual

How to run the service, written for the people who use it: the shop, the
delivery associates, the kitchens.

This is the **manual**. [README.md](README.md) is the engineering record — why
things were built the way they were. If the two ever disagree, the code is
right and both documents are wrong; tell us and we will fix them.

**Last updated:** 13 November 2026 — tracks `main`. This file ships in the same
commit as the change it describes, so if it is behind the agent, that is a bug.

---

## Contents

1. [What the service does](#1-what-the-service-does)
2. [For the shop](#2-for-the-shop)
3. [For delivery associates](#3-for-delivery-associates)
4. [For restaurants](#4-for-restaurants)
5. [What a customer sees](#5-what-a-customer-sees)
6. [Delivery codes](#6-delivery-codes)
7. [Parcels](#7-parcels)
8. [Money](#8-money)
9. [Settings](#9-settings)
10. [Running it day to day](#10-running-it-day-to-day)
11. [What is recorded](#11-what-is-recorded)

---

## 1. What the service does

Customers message one WhatsApp number. An agent answers, takes the order and
runs it through to the door. There are four services:

| | |
|---|---|
| **Grocery** | Shopping from the shop's own catalogue |
| **Restaurant** | Food from a partner kitchen |
| **Parcel** | Collect something from one address, take it to another |
| **Other** | Anything else — handed to a person |

Three kinds of people work the other side of it, and each is recognised purely
by the number they message from:

- **Staff** — the shop. Sees everything, can move any order.
- **Delivery associates** — collect and deliver. Nothing else is theirs to decide.
- **Kitchens** — accept, cook, hand over. Never see a customer's address.

Anyone whose number is on none of those lists is a customer.

---

## 2. For the shop

Send `help` to the shop number for this list at any time.

### The order queue

| Command | What it does |
|---|---|
| `orders` | Open orders. Also `open`, `queue`, `list` |
| `7` | One order in detail |
| `7 confirm` | Accept it |
| `7 ready` | Food is up — an associate is sent |
| `7 uplifted` | Note the time it left the counter; nothing else happens |
| `7 on the way` | Dispatch; the customer is told |
| `7 delivered` | Close it; the customer is told |
| `7 cancel` | Cancel it — you are asked why |

Order numbers work as `7`, `ORD-7` or `ORD-00007`.

### People and money

| Command | What it does |
|---|---|
| `where` | Where the associates are, and when each was last seen |
| `where rohan` | Ask one of them to share a fresh pin |
| `cash` | What each associate has collected today |
| `change number <name> <new number>` | An associate has a new SIM — see §10 |
| `7 history` | Everything that happened to order 7 |
| `backup` | The trading record, sent to you here |
| `wanted` | What customers asked for and you did not have |

### Restaurants

| Command | What it does |
|---|---|
| Command | What it does |
|---|---|
| `outlets` | The restaurants on the system |
| `new outlet` | How to add one |

**Send a photograph of the menu** to start. Repeat for more pages, then:

| Command | What it does |
|---|---|
| `draft` | Show what has been read off the photographs |
| `publish` | Put it on the menu |
| `discard` | Throw the draft away |

Once it is published:

| Command | What it does |
|---|---|
| `hours KFH Mon-Sat 10am-10pm` | Trading hours |
| `number KFH 5926123456` | The kitchen's own WhatsApp |
| `minimum KFH 1500` | Smallest order they will cook |
| `fee KFH 700` | Delivery fee for their orders |

**Share a location pin** to set where the associate collects from.

Anything the menu photographs showed as alcohol or tobacco is left out, and you
are told how many were dropped.

### What you cannot do

Clock an associate on or off. A shift record somebody else can edit is not a
record of hours worked.

---

## 3. For delivery associates

Send `help` to the shop number for this list.

| Command | What it does |
|---|---|
| `on` | Clock on. Sharing a location pin also does it |
| `off` | Clock off |
| `jobs` | What is waiting, and what you are already carrying |
| `7 uplifted` | You have it |
| `7 delivered` | Dropped off |
| `7 transfer` | Hand order 7 to another associate |
| `cash` | What you are holding this shift |

### The rules

**One at a time.** You cannot uplift anything new until the one you have is
delivered. The refusal repeats the whole job card, because the original is
buried up the chat by then.

**Twelve hours.** A shift ends twelve hours after you clock on, and you cannot
work more than twelve hours in any rolling twenty-four, however you split them.
An order already in your hands is always yours to finish — the cap stops new
work, it never strands a delivery.

**Only yours to close.** You cannot deliver, return or close an order that is
not with you. If somebody hands you their job, they send `<order> transfer` and
choose you.

**You cannot cancel.** Whatever has gone wrong at a door, voiding the order is
not the answer. Deliver it, or ring the shop.

### Handing a job over

```
Rider One ▸ "72 transfer"

🤝 Who is taking ORD-00072?
                              [ Rider Two ]  [ Rider Three ]
```

Only associates on duty and carrying nothing are offered. Tap one, or name them
directly with `72 transfer rohan`. **Nobody else is told** — not the other
associates, not the customer.

The one taking it receives the whole job card on their own phone, and the
delivery code then expects their input.

---

## 4. For restaurants

A kitchen messages from its own number and sees only what it needs to cook.
Never the customer's address or telephone number.

| Command | What it does |
|---|---|
| `orders` | Orders waiting on you |
| `7 confirm` | Accept it |
| `7 ready` | Food is up — an associate is sent |
| `7 uplifted` | Note that it left your counter |
| `7 cancel` | You cannot make it — you are asked why |
| `pause` / `open` | Stop and restart new orders |
| `sold out CHK-01` / `back CHK-01` | One dish off and on the menu |

**Ready is not offered until you have confirmed.** WhatsApp has no greyed-out
button, so the only way to stop a cook marking food ready for an order nobody
has accepted is to leave the button off until then.

---

## 5. What a customer sees

### Languages

English, Spanish, Portuguese and Chinese, chosen from how they write and kept
for the whole order — including the menu. **Staff, associates and kitchens
always work in English.**

### Ordering

The agent asks for a name, a location pin and a number to ring on arrival.

**A pin can be dropped anywhere** — the customer does not have to be at the
address. Every pin request says so:

> Not where you are now? Drag the map, or search for the place, before you send
> it.

**If they cannot send a pin at all**, the order still goes through on a written
address, and the associate's card leads with `⚠️ NO PIN — ring before you set
off`. The honest cost: a written address cannot be checked against the delivery
radius.

**If they paste a Google Maps link instead**, it is read. So is a plus code
(`865RXM2G+MC`, or a short `XM2G+MC` near the shop) and bare coordinates. This
matters most for parcels and for ordering on somebody else's behalf — a person
booking a delivery to a door they are not standing at cannot drop a pin on it,
but they can send a link to it.

The agent reads back the place it resolved to and asks whether that is where
the delivery goes. Nothing is saved until the customer says yes.

**A link to a town is not a doorstep.** Share a place like Timehri and the
coordinates look precise but describe a village, not a house. The agent is told
to name the area back and still ask for the exact spot. The same applies to a
link that only carries the map's viewport rather than the pin itself — the
difference is about 1.2 km, which is the wrong end of a runway.

**Ordering for somebody else** is normal. The agent takes the receiver's name
and number, and the associate's card names both people separately.

### Status messages

| | |
|---|---|
| Confirmed | "Order ORD-7 is confirmed. We'll let you know when it's on the way." |
| On the way | The total to pay, and the delivery code |
| Delivered | Thanks, whether the code was confirmed, and a meal sign-off for food |
| Cancelled | The reason, in plain words |

**Ready is deliberately not sent.** From the customer's side, food waiting on a
counter is indistinguishable from food still cooking.

---

## 6. Delivery codes

Every order gets four digits. The customer receives them with the "on its way"
message and reads them out at the door.

**No operator message ever contains the code** — not the job card, not `jobs`,
not the shop's alert, not the export. A code the associate can read off their
own screen proves nothing.

The associate's card carries no *Delivered* button when a code is expected.
Typing the four digits **is** the delivery.

| What happens | Result |
|---|---|
| Correct code | Delivered, and the customer is told "Delivery code: confirmed" |
| Wrong code | Refused, with the tries remaining |
| Three wrong | The code is spent — a food order delivers unverified; a parcel goes back |
| `No code` | Food delivers unverified, and the shop is told who and why |

**A code attempt tells you nothing about somebody else's order.** Type a code
against an order that is not yours and the only answer is *"That code is not
correct for ORD-00023"* — never whether it was delivered, cancelled or is still
out, and never against that order's try counter. An order number is four digits
and sequential, so anybody could type one.

**An order you finished yourself is different.** You carried it, and on a parcel
you collected the money, so typing its code tells you plainly what became of it:

```
associate ▸ "67 4417"

✅ ORD-00067 is already delivered.

The code was confirmed at the time. Nothing more is needed on it.
```

A parcel that went back says so, and why — the code would not match, or there
was nobody to receive it. Nothing is counted against a code that is already
settled, and a wrong code on a finished order reads the same way: the order is
over, so which digits you typed no longer decides anything.

**When the delivery is for somebody else**, the buyer is told to pass the code
on. WhatsApp will not let the shop message a number that has never written in,
so the buyer is the only route to the recipient.

Turn codes off with `DELIVERY_CODE=false`.

---

## 7. Parcels

A parcel is booked, not shopped for. It needs **six facts** — a name, a number
and an address at each end — and the job carries its own copy of all six.
**Nothing is reused from a past order**, because whoever is booking may be
neither the sender nor the receiver.

Each end can be a **location pin, an address in words, or both**. Where both
exist, both are printed: the words get somebody to the street, the pin to the
gate.

### The journey

| Step | Who |
|---|---|
| Booked | The agent, on the customer's yes |
| Accepted | **An associate**, tapping Accept — there is no kitchen to confirm it |
| Uplifted, cash taken | The associate, at the pickup |
| Delivered | The recipient's code closes it |
| Returned | Nobody there, or the code will not verify |

Booking offers the job to **every free associate on duty**; the first to accept
takes it, and the rest are told it has gone. That is the only broadcast in the
whole flow.

### What cannot be carried

- Weapons or explosives
- Drugs, and medicines that cannot be verified
- Cash, gold or jewellery — a bag of money on a motorbike is a robbery waiting
  to happen, and an argument afterwards about who lost it
- Live animals
- Fuel, gas, or anything corrosive or flammable
- Medical or human material
- Alcohol and tobacco — the same rule that keeps them off the menus, because
  moving them is still selling them over this channel

The contents are asked for once — the associate is entitled to know what is in
their hands — and **never repeated back to the customer**. It is "your parcel",
not what is in it.

The check reads the sender's own description. It cannot see inside a bag and is
not meant to: it catches the person who tells you honestly, which is most
people.

### When it comes back

Two different things, and the sender is told which:

- **Nobody there** — a missed appointment.
- **Wrong code** — the parcel may have been offered at the wrong door. The
  sender is asked to check with the recipient about the code they passed on.

**The fee is not refunded.** The trip was made.

---

## 8. Money

Everything is cash on delivery unless `PAYMENT_METHODS` says otherwise.

| | Paid | Counted against |
|---|---|---|
| Grocery, restaurant | at the door, by whoever receives it | whoever **delivered** it |
| Parcel | at the pickup, by the sender | whoever **uplifted** it |

That difference matters when a job is transferred: a parcel's fee stays with
the associate who collected it, because that is who has the notes.

`cash` from the shop shows the day's takings per associate, counted from
midnight on the shop's own clock. An order closed by the shop rather than by an
associate appears as its own row, named as such, so the figures reconcile to
the till.

An associate sees their own figure with `cash`, and is told it again when they
clock off — the one moment they are certain to read it. Nobody can hand over
money they were never told the amount of.

Clocking off gives **two** figures when they differ: this shift, and the whole
day. Somebody who also worked this morning may still be carrying that money —
the shift figure alone would understate what they owe, and the day's figure
would double-count anything already handed in. Both are shown, and the person
holding it says which applies.

Clocking off does not finish what is already in the bag. An associate still
carrying orders is told so, by order number.

---

## 9. Settings

All set in the **Render dashboard → your service → Environment**. The dashboard
overrides `render.yaml`, so a value in the file is ignored if it is also set
there. Render restarts the service when you save.

### Must be set

| Variable | What breaks without it |
|---|---|
| `STAFF_NUMBERS` | **The shop hears nothing.** No new-order alerts, no `cash`, no `backup`, no warnings. Comma-separated digits, no `+` |
| `ASSOCIATES` | No associate can be dispatched or reach the shop |
| `WHATSAPP_*`, `ANTHROPIC_API_KEY` | Nothing works at all |

A staff or associate number must be a **personal** WhatsApp number, different
from the business number the agent sends from. The agent cannot message itself.

### Worth setting

| Variable | Default | What it does |
|---|---|---|
| `GROCERY_NUMBER` | — | Where grocery orders go to be picked. See below |
| `STORE_NAME` | Our Delivery Service | Used in every customer message |
| `STORE_HOURS` | Mon-Sat 8am-8pm | `24 hours` for round the clock |
| `STORE_TIMEZONE` | America/Guyana | Decides when "today" starts |
| `DELIVERY_FEE` | 0 | Flat fee on shopping orders |
| `FREE_DELIVERY_OVER` | 0 | Waives it above this subtotal |
| `MIN_ORDER_TOTAL` | 0 | Smallest order accepted |
| `PARCEL_FEE_BASE` | **0** | Flat part of a parcel fee. **At 0 every parcel books unpriced** |
| `PARCEL_FEE_PER_KM` | **0** | Per-kilometre part |
| `PARCEL_MAX_KM` | 0 | Beyond this a parcel is refused. 0 = no limit |
| `SERVICE_RADIUS_KM` | 0 | Beyond this an order is refused. 0 = no limit |

### Picking groceries

A restaurant order reaches the kitchen that cooks it, at that kitchen's own
number. A grocery order had no equivalent — it went only to the staff
broadcast, which is a dispatch alert carrying an address, a telephone number
and a map pin. None of that helps somebody filling a bag off a shelf.

Set `GROCERY_NUMBER` and every grocery order arrives there as a picking list:

```
🛒 *Order ORD-00074* — please pick

2 x Rice, 5kg
1 x Cooking oil, 1.8L
3 x Channa

Goods total $8,450
Ordered 10:14

[ Confirm ]  [ Cancel ]
```

**Goods total, not the order total.** The delivery fee is not theirs to collect
and not theirs to be asked about. No address, no customer number, no map link —
a picking list with a doorstep in it is one somebody has to read twice.

*Ready* appears only after *Confirm*, the same rule kitchens follow.

Restaurant orders and parcels are left alone: one is cooked elsewhere, the
other has nothing to pick.

**It must be one of your `STAFF_NUMBERS`.** The setting decides where the
ticket goes; `STAFF_NUMBERS` decides what that person may do. A number on
neither list still receives the ticket, but its buttons do nothing — `npm run
check` warns you about exactly that.

If the picker has not messaged the shop in 24 hours, WhatsApp will not let a
message with buttons through. The shop is told so rather than the order sitting
unpicked, and the order is still in the staff broadcast, so nothing is lost.

### Associates

| Variable | Default | What it does |
|---|---|---|
| `MAX_JOBS_PER_ASSOCIATE` | 1 | How many orders one associate may carry. 0 = no limit |
| `ASSOCIATE_DUTY_HOURS` | 12 | A shift lapses this long after clocking on |
| `ASSOCIATE_MAX_HOURS_PER_DAY` | 12 | The rolling 24-hour cap. 0 = off |
| `ASSOCIATE_RADIUS_MILES` | 0 | Only offer jobs within this far. 0 = everybody |

### Codes, backups, alerts

| Variable | Default | What it does |
|---|---|---|
| `DELIVERY_CODE` | true | Four-digit code at the door |
| `BACKUP_EVERY_HOURS` | 24 | Local snapshot of the database |
| `BACKUP_SEND_HOURS` | 24 | Copy sent off the machine over WhatsApp |
| `BACKUP_TO` | first staff number | Who receives it |
| `BACKUP_KEEP` | 14 | Snapshots kept before the oldest is dropped |
| `BACKUP_TOKEN` | — | Enables the download links. No token, no routes |
| `STALL_ALERT_MINUTES` | 15 | How long an order may sit before the shop is warned |

---

## 10. Running it day to day

### Backups

A copy of everything is sent to your WhatsApp every `BACKUP_SEND_HOURS` — an
orders sheet, a JSON file that can rebuild the database, and the event trail.
You can pull one any time by sending `backup`.

**That file holds every customer's name, address and map pin.** It goes to one
number, not to all staff. Do not forward it.

The local snapshots live on the same disk as the database, so they survive a
mistake but not the loss of the disk. The WhatsApp copy is the one that is
somewhere else.

### When an associate changes their number

```
shop ▸ "change number Rider One 592 600 5555"

🔄 Rider One is now on +5926005555.
Moved: 1 shift, 2 deliveries, $425,000 in today's takings.
⚠️ Add +5926005555 to ASSOCIATES on Render and remove +5926001111.
```

His hours, takings, position and deliveries follow him. **You must still update
`ASSOCIATES`** — the command fixes the records, the variable controls which
numbers reach the shop at all.

### Clearing out old orders

Back up first, then in the Render shell:

```bash
cp /var/data/store.db /var/data/store-before-clear.db
```

```bash
sqlite3 /var/data/store.db "UPDATE orders SET status='cancelled', cancel_reason='Cleared - stale test order', cancelled_by='staff', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), stall_alerted_at=NULL WHERE status IN ('pending','confirmed','ready','on_the_way'); SELECT changes();"
```

This is silent — no customer is messaged. **Order numbers never come round
again**, so clearing out old orders cannot give a new one a number that has been
used before.

Starting again at `ORD-00001` is possible but deliberate: it takes clearing the
orders, their events **and** the sequence row together.

---

## 11. What is recorded

### Every order carries its own trail

```
shop ▸ "72 history"

📜 *ORD-00072* — 5 events

12 Nov, 15:40 — *booked* (parcel for Customer One)
12 Nov, 15:44 — *accepted* by Rider One
12 Nov, 16:02 — *uplifted* by Rider One
12 Nov, 16:31 — *transferred* by Rider One (to Rider Two +5926002222)
12 Nov, 16:58 — *delivered* by Rider Two (code verified)
```

Placing, booking, acceptance, uplift, transfer, delivery, return and
cancellation — each with who did it, when, and what mattered: the cancellation
reason, why a parcel came back, whether the code was verified.

It is **append-only**. Names are stored as they were at the time, so an
associate who leaves still delivered what they delivered.

### In the export

The orders sheet has a row per order, including **Uplifted by** and **Delivered
by** separately — they differ whenever a job changed hands. The events file has
a row per event. The JSON file is the one that can rebuild the database.

---

## Keeping this manual honest

This document is updated **with the change**, not afterwards. Every feature
added to or altered in the agent is written up here in the same commit, so the
manual and the code never travel separately. If you find something in the agent
that is not here, or something here the agent does not do, that is a defect in
this file.

It is written from the code rather than from memory, which is the only way it
stays true: the first pass over it caught commands described that did not exist
and a parcel refusal category that was missing.
