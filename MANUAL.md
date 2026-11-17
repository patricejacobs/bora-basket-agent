# Next Minute Delivery — Manual

How to run the service, written for the people who use it: the shop, the
delivery associates, the kitchens.

This is the **manual**. [README.md](README.md) is the engineering record — why
things were built the way they were. If the two ever disagree, the code is
right and both documents are wrong; tell us and we will fix them.

**Last updated:** 14 November 2026 — tracks `main`. This file ships in the same
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
| **Grocery** | Shopping from a grocery shop |
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

### Who counts as one

**The shop's own list of associates decides who gets offered work.** A number
in that list, marked active, is offered jobs and gets the associate commands.
A number that is not in it is a customer, and is answered by the shopping
agent.

Set `active = 0` and they stop being offered anything, keeping their name,
their history and their cash on file. That is how somebody comes off the road.

`DRIVER_NUMBERS` is a **seed, not the list**. Every number in it is written
into the directory on the first boot that sees it, and then it is finished:
later edits go to the directory. It is never applied twice, so a name or an
`active = 0` set through the shop survives the next restart.

Before this there were two lists that never met. Dispatch offered every job to
`DRIVER_NUMBERS` and nothing else, so a shop could import its associates, see
them listed, watch one clock on — and every job still went to whoever was
named in an environment variable. Somebody in the directory and not in the
variable was invisible: the log said *"nobody is clocked on"* while they stood
there clocked on, and if their number happened to be a shop's, the router fell
past them and answered with the kitchen commands.

### They have to say something first

**WhatsApp will not carry a job card to a number that has never messaged the
shop.** Meta only allows a free-form message within 24 hours of that number's
last message *in*, so an associate who has never opened the chat cannot be
sent anything at all. One message from them — `on` is enough — opens it.

The shop now says so at boot rather than leaving it to be discovered:

```
[associates] +8673464384 (Wayne Jacobs) has never messaged the shop —
             nothing can be sent to them until they do
```

and the same warning goes to `STAFF_NUMBERS`.

**`sent` on `/health` means Meta accepted the message, not that anybody got
it.** A valid-looking number that is not on WhatsApp is accepted with a
message id and then silently never delivered. `/health` now carries Meta's own
verdict alongside the send count:

```
"outbound": { "attempted": 11, "sent": 11, "failed": 0 },
"delivery": { "delivered": 9, "read": 7, "failed": 2,
              "lastFailure": "+8673464384 — (131026) Receiver is incapable of
                              receiving this message" }
```

`outbound.failed` is the Graph API refusing a message — a bad token, a shut
window. `delivery.failed` is Meta taking it and finding nobody to give it to.
The two have different fixes, so they are counted separately, and every
undelivered message is logged with the number it was addressed to.

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

**An address in words is an answer, not a concession.** Either a pin or a
written address places an order; only having neither refuses one. The
associate's card then leads with `⚠️ NO PIN — ring before you set off`, which
is what makes a written address workable — they ring rather than navigate.

It used to demand the pin. An address counted only once the customer had been
asked and said they could not send one, which the agent unlocked with a
`without_pin` flag. So somebody who simply typed where they lived was asked
for a pin again, and the order did not exist until they produced one — meaning
the kitchen had not heard of it either, and the customer was answering the
same question twice at the last step.

It also disagreed with the card that gets driven from, where a written address
**beats** a pin and the pin is not printed beside it. The shop cannot hold
both positions.

A pin is still asked for, and still worth having: it is the only thing the
delivery radius can be measured against, and two taps from the customer. It is
a question now, not a gate. The honest cost of an address-only order is that
nobody can tell whether it is inside the delivery area until an associate is
reading the card.

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
| Five wrong | The code is spent — a food order delivers unverified; a parcel goes back |
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
| `STORE_NAME` | Our Delivery Service | Used in every customer message |
| `STORE_HOURS` | Mon-Sat 8am-8pm | `24 hours` for round the clock |
| `STORE_TIMEZONE` | America/Guyana | Decides when "today" starts |
| `DELIVERY_FEE` | 0 | Flat fee on shopping orders |
| `FREE_DELIVERY_OVER` | 0 | Waives it above this subtotal |
| `MIN_ORDER_TOTAL` | 0 | Smallest order accepted |
| `PARCEL_FEE_BASE` | **0** | Flat part of a parcel fee. **At 0 every parcel books unpriced** — see below |
| `PARCEL_FEE_PER_KM` | **0** | Per-kilometre part |
| `PARCEL_MAX_KM` | 0 | Beyond this a parcel is refused. 0 = no limit |
| `SERVICE_RADIUS_KM` | 0 | Beyond this an order is refused. 0 = no limit |

### The grocery shop

Your grocery is a **shop**, with its own record, exactly like a restaurant. It
has its own name, its own hours, its own pickup address and its own WhatsApp
number, and it accepts an order before anybody packs it.

It is created for you. The first time the agent starts it makes one, named
after `STORE_NAME`, open **24 hours**, with **no minimum order**, and every
product you have already imported is filed into it. Its code is `GROCERY`.

It has no number of its own at that moment, and takes one from the first of
these that can supply it: the `GROCERY_NUMBER` setting, if you had one; then
its row in `data/outlets.csv`. After that the number is the shop's own and
nothing overwrites it.

| What | Where it lives | How to change it |
|---|---|---|
| Its name | the shop's own record | `name GROCERY Centro de Gangas` |
| Its number | the shop's own record | `number GROCERY 5927410186` |
| Its hours | the shop's own record | `hours GROCERY 24 hours` |
| Its minimum | the shop's own record | `minimum GROCERY 1500` |
| Its delivery fee | the shop's own record | `fee GROCERY 700` |
| Where it is collected from | the shop's own record | share a location pin |

`npm run check` tells you if it has no number, because a grocery nobody can
reach is a grocery with nobody packing.

Renaming it is a command rather than an edit to the file, because the file is
not re-read on a hosted deployment. The name is copied onto each order when it
is placed, so orders from before a rename keep the old name — that is their
history, and the command says so when you rename.

### The picking list

Every grocery order arrives at that number the moment it is placed:

```
🛒 *Order ORD-00074* — please pick

2 x Rice, 5kg
1 x Cooking oil, 1.8L
3 x Channa

Goods total $8,450
Ordered 10:14

Tap *Confirm* to accept, then *ORD-00074 ready* when the bag is packed
and a delivery associate will come.

[ Confirm ]  [ Cancel ]
```

**Goods total, not the order total.** The delivery fee is not theirs to collect
and not theirs to be asked about. No address, no customer number, no map link —
a picking list with a doorstep in it is one somebody has to read twice.

*Ready* appears only after *Confirm*, the same rule kitchens follow. And
*Ready* is what sends the delivery associate: before it, there is nothing in a
bag for them to collect.

A kitchen gets the same message with different words — *please prepare*, and a
food total. One ticket, two shapes, picked by what kind of shop it is.

The dispatch desk's own alert follows the same rule: 🛒 and "Picking takes
about 20 minutes" for a grocery, 🍽️ and "Kitchen reckons about 20 minutes" for
a kitchen. It used to say the kitchen line over a bag of shopping, because
having a shop and being cooked were once the same fact.

To see every card for all three kinds of business side by side, run
`node cards-gallery.ts`. It drives the real notify and dispatch functions and
prints what they hand to WhatsApp, so it is the message rather than a
description of one.

**The number does not need to be staff.** This is the part worth knowing if you
set this up before: a grocery is reached through its own record, so whoever
holds that number can Confirm and Cancel without being on `STAFF_NUMBERS` — and
without the promotion to staff that would have outranked their job as a
delivery associate.

If the shop has not messaged the business number in 24 hours, WhatsApp will not
let a message with buttons through. It is held and handed over the moment they
next write, which is the same protection the kitchens have.

### What the customer is told when they place an order

Received, and nothing more. These are the words, not a description of them:

> Got it — ORD-00083 received, but not yet confirmed. The moment A Taste of
> Guyana confirms it, we'll let you know.

For a grocery order the shop is not named, because with a single grocery the
customer is never shown which one they are in:

> Got it — ORD-00083 received, but not yet confirmed. The moment the shop
> confirms it, we'll let you know.

The agent is handed that sentence and told to send it word for word. It may
change one thing: the language, if the customer has been writing in another.
Everything the agent used to add to this message was something it did not
know — that a kitchen had the order, that it would be twenty minutes, what was
owed and where to pay it.

It used to say more than it knew. The agent was handed the customer's name,
address, map pin and telephone number along with the order number, and did the
natural thing with them: read them back. It also quoted the shop's own
`prep_minutes` setting as though the kitchen had spoken — *"the kitchen says
about 20 minutes"* — when the kitchen had said nothing and may not have seen
the order at all.

So that reply now carries the order number and what was ordered, and nothing
else.

| Left out | Why |
|---|---|
| Name, address, pin, telephone | typed a moment ago; nobody wants their address recited on a shared phone |
| The total and the delivery fee | nothing is owed on an order nobody has accepted |
| How and where to pay | a sum beside a payment method reads as a bill |
| Preparation time | what they are waiting for is acceptance, not cooking |

The money arrives with the acceptance, which is the first moment anything is
actually owed — the shop may refuse the order and the kitchen may be shut. The
prices were in the question the customer answered to get here, one message
earlier, so nothing is hidden by leaving them out.

The acceptance is a separate message, sent when it actually happens.

### When nobody is at the door

Any order can come back. The associate gets a *Nobody there* button beside the
code prompt, and `7 nobody there` works typed:

```
ORD-00083 → *returned*.
Customer notified.
```

The order is recorded as **returned**, with the reason *nobody there*. It is
not recorded as delivered — which matters for three separate people:

- the **customer** is not told their order arrived when it did not
- the **associate** is not charged for cash nobody ever handed them
- the **shop** sees it in the queue as returned, and can act on it

This used to be parcels only, on the reasoning that food never comes back
because food is eaten. True of the curry and untrue of everything around it: a
bag of rice goes back on the shelf, and even a meal nobody can save still has
to be written down as not delivered. The only options were *Delivered* and
*No code*, and both closed the order.

Where the goods end up differs by kind — a parcel to its sender, a grocery
onto the shelf, a restaurant meal almost certainly written off — but that is
the shop's business, not the order status's.

**What the customer is told** differs too. A parcel sender really is getting it
back, so they are told so. Everybody else is the person who was not at the
door:

> Order ORD-00083 has come back — there was nobody at the door to take it.
> Message us when you are ready and we will arrange another delivery.

**Stock is not put back.** Nothing in the shop restocks a returned or cancelled
order today, so a tracked item stays counted as sold until somebody corrects
it.

### A parcel with no price on it

With `PARCEL_FEE_BASE` and `PARCEL_FEE_PER_KM` both at 0, a parcel is still
booked — the agent never invents a figure, because a quoted price is a promise
and a wrong one is an argument on a doorstep.

**The delivery associate agrees the price at the pickup.** They are the one who
turns up and sees the parcel, so they are the only person who can. The
customer is told so:

> The delivery associate will confirm the cost with you before it is uplifted.

This used to say *the shop* would confirm it, and the associate's own card said
the same — so the customer waited for a message nobody was going to send, and
the associate waited for a price the shop was not setting. Their card now says:

```
*Fee not set* — agree it with the sender at the pickup
```

Set a base, and optionally a rate per kilometre, and none of this applies: the
fee is quoted at booking like any other.

### A code answers about one order

Four digits typed by an associate are tested against **the order they picked
up last**, because that is the door they are standing at. Every message about
it names that order and no other.

It used to ask which, when they were carrying more than one, and list each
order with the customer's name beside it. That answers a question nobody
asked — they are at one door, not choosing between doors — and it puts other
people's undelivered orders on a screen the customer at that door can read
over.

Naming an order explicitly still wins: `86 1234` is about order 86 whatever
else they are carrying.

### A wrong code at the door

Five attempts, whatever the order is. What the associate is told differs.

Five rather than three because three was tight at a real door: a customer
reading digits off a phone in the dark, a neighbour taking the bag, an older
message read out by mistake. Each costs a try, and running out closes an
honest delivery as unverified. Four digits is 9,000 possibilities, so five
guesses is nowhere near enough to find one — the limit is there to stop an
associate verifying a delivery without the customer, and it still does.

**A restaurant order** says the fact and nothing else:

```
That code is incorrect for ORD-00083.

[ No code ]
```

**A grocery or a parcel** also names who to ask, which matters when the person
at the door is not the person who ordered:

```
❌ That code is not correct for ORD-91001.

Ask Anita for the code Ramesh passed on. 4 tries left.

[ Wrong code ]  [ Nobody there ]
```

**On the fifth wrong attempt the code is spent.** It stops being required and
the order closes, recorded permanently as delivered with the code never
confirmed. A code cannot hold a delivery open for ever, and an associate who
cannot close a job will close it some other way.

### One way to the door

A delivery card gives the associate **either** a written address **or** a map
link, never both. If the customer wrote an address down, that is what is
printed; the pin is kept on the order but stays off the card.

| What the order has | What the card shows |
|---|---|
| An address | the address |
| A pin only | the pin's label and the link |
| An address and a pin | **the address** |
| Neither | ⚠️ *NO PIN — ring before you set off* |

The pin still does work when it is not printed. It silences that warning —
there *is* a pin, it simply is not the answer being given — and it is still
what the out-of-area check measures, so an associate is told when a drop is
beyond the delivery area whether or not a link appears.

This applies to a parcel's destination and to an order going to somebody else,
including one where the buyer deliberately shared a pin for the recipient's
door. If an address was written, the address is what the card gives.

### And the doorstep line says something new

Under the address the card prints the customer's own words about finding the
door — *blue gate, upstairs flat*. It is printed **only when it is not the
address again**:

| Address | Note | The card prints |
|---|---|---|
| 26 Brickdam, Georgetown | Blue gate, upstairs flat | both lines |
| 26 Brickdam, Georgetown | 26 Brickdam, Georgetown | the address, once |
| 26 Brickdam, Georgetown | 26 Brickdam | the address, once |
| *(none)* | 26 Brickdam | the note — it is all there is |

A note that only repeats the address is now dropped when the order is written,
so it is not in the record either.

Order 93's card read `26 Brickdam, Georgetown` and then, on the next line,
`26 Brickdam, Georgetown`. The tool the agent calls has always told it not to
repeat the address in the note — but a prompt is a request, not a guard, and
when the one line a customer types is both their address and their only
landmark, there is no reason for the agent to put it in one field rather than
both. The same place twice is not extra information: it is a line read at a
gate, checked against the one above it, and trusted a little less.

Matching is on whole words, either way round, ignoring case and punctuation, so
*26 Brickdam* under *26 Brickdam, Georgetown* is caught — while *Diamond*
under *Diamondback Street* is not, because that is somewhere else entirely.
It is the same test that keeps a pin's label from repeating the address.

### Starting the count again

A shop that has been testing in public ends up with a database full of
rehearsals. `RESET_SHOP` clears the trading record on the next boot and starts
the order numbers at `ORD-00001`.

```
RESET_SHOP=erase-2026-11-17
```

**Gone:** every order, its items and its event trail; baskets, parked baskets
and parcel drafts; customers, saved addresses and pins; conversations; the
message log; the unmet-demand record.

**Kept:** the catalogue, the outlets and the delivery associates. Those are how
the shop works, not what it has done — wiping them leaves a service that
cannot trade.

**It takes a snapshot before it deletes anything**, written to the backup
directory under its own name, and names it in the log and in the message it
sends to `STAFF_NUMBERS`.

Three things make it safe to leave in the environment:

**It needs a token, not a flag.** The value must begin with `erase-`.
`RESET_SHOP=true` is refused and logged — that is a value somebody sets while
debugging something else.

**It runs once.** The token is written into the database once applied, and a
boot that finds it already recorded does nothing. A variable left in place is
harmless: a deploy, a crash or a plan change will not erase the day's trading.
To wipe again, change the token — which is why dating it is the convention.

**It cannot happen from a test.** The reset runs from the server's boot, never
from the database module, so opening the database to run the suite, a
walkthrough or the card gallery can never wipe a shop.

One caveat with clearing the message log: WhatsApp's 24-hour window is measured
from each number's last message *in*, so wiping it shuts the window for
everyone. Staff, kitchens and associates are all unreachable until each sends
the shop a message. The boot warning about unreachable associates will say so
by name.

### Who moved an order

Every status change is now recorded three ways, so "the restaurant never
confirmed that" has an answer.

**In the order's own history**, always:

```
14 Nov, 02:24 — *placed* (A Taste of Guyana, 1 line(s))
14 Nov, 02:24 — *confirmed* by +5926767471 (sent "1 confirm")
```

Send `81 history` from a staff number. Before this it said only *by outlet* —
a role, not a telephone — because the number was never passed through for
anyone but a delivery associate.

**In the server log**, always, readable in the Render dashboard:

```
[status] ORD-00081 pending → confirmed by +5926767471 — sent "1 confirm"
```

**In the customer's own chat**, only while `DIAGNOSE_SOURCE=true`:

```
Thanks Patrice — order ORD-00081 is confirmed.

_[moved by +5926767471]_
```

Leave that one off except while you are watching. It puts a kitchen's
telephone number into a customer's chat, which is not yours to give away — it
exists because the fastest way to settle an argument is a line in the chat you
are already looking at.

### When a kitchen cannot be reached

A ticket is a message with buttons, and WhatsApp refuses those to anybody who
has not written to you in 24 hours. The order is held and handed over the
moment that kitchen next sends anything — a question, a thumbs up, a tapped
template button.

A held ticket is recorded by leaving its "notified" time empty. That same
emptiness is what rows written before the column existed look like, and a
boot-time mend filled them all in — so **every restart wrote down that a ticket
had been delivered when it had not**, and the hand-over then had nothing left
to give. On a host that sleeps when idle, that is several times a day, and the
result is a queue of orders the kitchen has never seen and never will, with
nothing anywhere saying so.

The mend now skips orders that are still pending, since a settled order cannot
be owed a ticket. If you have a pile of pending restaurant orders and a kitchen
saying it never saw them, this is why.

### Who accepts a restaurant order

**Only the kitchen.** The desk's own alert no longer carries a *Confirm*
button for an order belonging to a restaurant, and confirming one from a staff
number is refused:

```
ORD-00082 is A Taste of Guyana's to accept.

They have the order and their own Confirm button. Confirming here would
tell the customer the kitchen has taken it, which only the kitchen knows.

If you have rung them and they have said yes, send `82 confirm anyway`.
```

Refused rather than merely hidden, because a WhatsApp reply button never
expires — a tap on this morning's alert still arrives this evening.

`82 confirm anyway` is the way through when a kitchen that will not answer
WhatsApp answers the telephone. It is deliberate, and it is recorded in the
order's history with the number that sent it.

A **grocery** order is your own shop's, so the desk confirms it as before.

### How an order says goodbye

The closing message is built in four parts: the receipt, the line saying it
arrived, the thanks, and a wish. The thanks is decided by what the customer
actually did, and the wish is drawn from a pool for that kind of order.

```
🧾 *Receipt* — 16 Nov, 17:59        ← the receipt

2 x Karibee Parboiled Rice — $3,700
1 x Fresh Milk — $780
3 x Bath Soap — $1,770

Goods $6,250
Delivery $500
*Total $6,750* — paid in cash

Order ORD-00042 delivered.          ← it arrived

Thank you for shopping with us!     ← thanks, by kind
Message any time for your next order. 💬   ← one of five wishes
```

**Everything ordered, line by line, plus the delivery charge.** Before this
the last priced thing a customer saw was the cart, before the order existed:
they were told their order arrived and never told what arrived or what the
money was for. Nothing on the receipt is recalculated — every figure is read
off the order as it was written, so the receipt and the amount the associate
collects cannot drift apart.

The goods total and the delivery charge have been stored on every order since
the first one. They were simply never read back, because until the receipt
nothing shown to a customer had to say what the total was made of.

**A parcel bought nothing**, so it gets its contents and its fee, marked as
settled where it actually was:

```
🧾 *Receipt* — 16 Nov, 17:59

📦 6 flattened cardboard boxes

*Delivery fee $1,500* — paid at pickup
```

A parcel the associate priced at the counter prints no figure at all. The shop
never learned what was agreed, and a zero would be a claim about it.

**The receipt goes first and the manners last**, so the useful part is not
something to scroll past the thanks to reach. It carries no order number of
its own — the line directly below it already says `Order ORD-00042 delivered`,
and the same reference twice in one message is a line read, checked against
the other, and trusted less.

**No padded columns.** WhatsApp renders a plain message in a proportional
font, so figures lined up with spaces arrive ragged on a phone. The label goes
in front of each figure instead, which reads the same in any font.

All of it exists in English, Spanish, Portuguese and Chinese.

| Kind | Thanked for | Wishes |
|---|---|---|
| Grocery | shopping with us | 5, about the day |
| Restaurant | ordering from the named kitchen | 7, about the meal |
| Parcel | choosing the service | 5, about the trust |

A grocery and a parcel used to get no wish at all — the only pool was about
eating, so it was skipped for anything that was not a meal, and both ended on
"Thank you for choosing" and nothing else.

The grocery thanks deliberately does **not** name the shop. With one grocery
the customer is never shown which shop they are in, so naming it here would
introduce a shop they have never heard of in the last message of the
conversation. The restaurant line does name the kitchen, because they chose it
by name.

**Which wish a customer gets is decided by the order number**, not at random.
So a message re-sent for any reason says the same thing twice, and a regular
customer cycles through the pool. All of it exists in English, Spanish,
Portuguese and Chinese.

### More than one grocery

The model holds as many as you like. Add one the way you add a restaurant — a
row in `data/outlets.csv` with `kind` set to `grocery` — and give its stock an
`outlet` column in your products CSV naming its code.

With **one** grocery, nobody is ever asked to choose: a customer saying
"groceries" is already in the shop. With **two or more**, the agent asks which,
the same way it asks which restaurant. Choosing the nearest shop to the
customer automatically is not built yet; it needs their location before they
start shopping rather than at checkout, and across the Demerara a straight line
is the wrong way to measure.

**One order comes from one shop.** Two groceries is two deliveries, and
shopping never shares an order with cooked food.

### Editing a shop through the CSV

`data/outlets.csv` can hold any shop, the grocery included, and re-importing it
is how you change several at once.

**A column you leave out is a field you are not changing.** Import a file with
only `code,name,hours` and only the hours move — the number, the minimum, the
fee, the pickup pin and whether it is a grocery all stay as they were. This
matters because numbers are usually set by `number KFH 5926123456` rather than
in the file, so they are often not in it; before this rule, importing such a
file blanked them and the shop simply stopped receiving tickets.

To clear a field on purpose, include its column and leave the cell empty.

**A shop missing its number, its address or its pin gets them from the file on
startup.** Only those three, and only when they are blank — a shop that cannot
be reached or cannot be found is broken rather than configured, so there is no
decision to overrule. Anything you have set, from the file or from your phone,
is left exactly as it is. This is how the grocery gets its number without any
Render setting at all.

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
