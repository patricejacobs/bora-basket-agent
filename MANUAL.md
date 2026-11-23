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
8. [Taxis](#8-taxis)
9. [Money](#9-money)
10. [Settings](#10-settings)
11. [Running it day to day](#11-running-it-day-to-day)
12. [What is recorded](#12-what-is-recorded)

---

## 1. What the service does

Customers message one WhatsApp number. An agent answers, takes the order and
runs it through to the door. There are four services:

| | |
|---|---|
| **Grocery** | Shopping from a grocery shop |
| **Restaurant** | Food from a partner kitchen |
| **Taxi** | A car for people, driven by the delivery associates — no fare is quoted |
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

### Job numbers

**The three letters say what the job is. The number is the job.**

| | |
|---|---|
| `ORD-00041` | A restaurant order |
| `GRO-00042` | Groceries off the shop's own shelves |
| `PCL-00043` | A parcel |
| `TXI-00044` | A taxi |

**One counter runs under all four**, so `TXI-00044` and `GRO-00042` are two
different jobs and there is never a second number 42. That is what keeps
`7 delivered`, `7 confirm` and every reply button working: the bare number is
an answer because it means exactly one job in the whole shop.

**Only the digits are read.** `7`, `ORD-7`, `txi-00007` and `PCL-7` all find
the same job — somebody reading the wrong three letters off the card above is
still asking about a job that exists, so they get it rather than an error.

`TXI` and not `TAX`: beside a fare, on a receipt, that word is a levy.

**Orders placed before this change keep the numbers they were given.** They
all say `ORD`, whatever service they were — receipts, the audit trail and
customers' own chats refer to them, and history that changes underneath you is
worse than history that is inconsistent. `ERR` and `COL` are held back for the
errand and collection services, so nobody picks letters that clash later.

### People and money

| Command | What it does |
|---|---|
| `where` | Where the associates are, and when each was last seen |
| `where rohan` | Ask one of them to share a fresh pin |
| `zones` | Where the work is, against where the people are |
| `base rohan Diamond` | The place an associate works from |
| `ratings` | What customers thought of it, by associate and by outlet |
| `cash` | What each associate has collected today |
| `change number <name> <new number>` | An associate has a new SIM — see §11 |
| `7 history` | Everything that happened to order 7 |
| `backup` | The trading record, sent to you here |
| `wanted` | What customers asked for and you did not have |

### Reward points

**Five per cent of what a customer pays to be reached, given back as points.**

| | |
|---|---|
| $10 of **delivery charges** | 1 point |
| $10,000 of delivery charges | 1,000 points |
| **1,000 points** | **$500 off an order** |

**The delivery charge earns, not the shopping.** That has a consequence worth
knowing before a customer points it out: the tariff runs from $500 in
Georgetown to $5,000 at Parika, so somebody at Parika reaches a reward in two
deliveries and somebody in Kitty needs twenty. The scheme pays back the people
who pay the most to be reached — the dearest to serve and the easiest to lose
— which is a defensible thing to do, and a different thing from rewarding the
biggest shoppers.

A **parcel's fee** is a delivery charge and earns. A **taxi earns nothing**:
the fare is agreed in the car and the shop never learns it.

**Points are credited when the goods arrive**, never when the order is placed.
Cancelled, returned, never delivered — nothing earned. A reward *spent* on an
order that then comes back is **given straight back**.

```
⭐ *+500 points* on this delivery.
You have *1000 points* — that is *$500* off an order, whenever you want it.
Just say *use my points*.
```

**Short of a reward, the distance is counted in points, never in money still
to spend.** The base is the delivery charge, so "spend $8,200 more" would
read as *pay us more in fees* — and nobody can go and acquire points anyway.
What they can do is order again, so the second line says that instead,
priced from the delivery that has just concluded:

```
⭐ *+180 points* on this delivery.
You have *180 points* — *820 to go* for $500 off.
About 5 more deliveries to Diamond.
```

**The deliveries line names the delivery that just concluded, not the one on
the order.** ORD-00005 was booked to Uitvlugt and redirected to Stanleytown
while it was on the road — and the congratulation that followed it offered
*"about 2 more deliveries to Uitvlugt"*, naming the one village the customer
had just moved the delivery away from. The zone saved on a customer's record
is where they usually are. The zone on the **order** is where this one went,
at the fee it actually charged, and that is the delivery being congratulated.

When somebody simply asks about their points with no delivery in hand, the
same rule applies one step back: the last delivery they actually took, rather
than the zone on the record, which may be months old or an address they have
since moved away from. A taxi is not read as a delivery — a fare is a
different figure about a different thing.

**The deliveries line appears only when it is five or fewer.** Past that it
stops being encouragement: a Georgetown customer two deliveries in is
eighteen away, which is true and is not an advertisement. The points to go
are always shown, so nothing is hidden — the shop just does not volunteer the
harder number, and the line comes back as they get close:

```
You have *100 points* — *900 to go* for $500 off.

...later...

You have *800 points* — *200 to go* for $500 off.
About 4 more deliveries to Georgetown.
```

Where the shop has never learned where somebody lives, the second line is
left out rather than guessed at.

**It is spent only when asked for.** Somebody saving for something must be
able to buy a bag of rice without their $500 going on it. On the receipt it is
a deduction, so the customer can see the money:

```
2 x Karibee Parboiled Rice — $3,700

Reward −$500
*Total $3,200* — paid in cash
```

The total is stored **net**, so the cash the associate collects, the day's
takings and the backup are all right without knowing the scheme exists.

**It is a ledger, not a balance.** Every point says which order earned or
spent it and when, so a customer who says "I had more than that" can be
answered rather than contradicted.

### Ratings

After a delivery the customer gets **one tappable list of five stars**, as its
own message. The one above it closes the order and carries the receipt and the
goodbye; a question underneath all that is read as part of the signature.

```
How did we do with ORD-00042?
              [ Rate this order ▾ ]

   ⭐⭐⭐⭐⭐  Perfect — nothing to fix
   ⭐⭐⭐⭐   Good — small things
   ⭐⭐⭐    Alright
   ⭐⭐     Not good
   ⭐      Bad — please get in touch
```

**Four stars or five ends there.** Nobody is interviewed about a delivery that
went well. **Three or fewer** gets one question — *what went wrong?* — and
whatever they write is sent to `STAFF_NUMBERS` whole, with the order, the
outlet and who delivered it. The shop is told the moment the stars arrive, not
only when the words come: most people tap and never write, and two stars with
no explanation is still worth knowing today.

| Rule | Why |
|---|---|
| Asked once per order, ever | A second ask is nagging |
| At most once a fortnight **per service** | Somebody who orders weekly and is asked weekly mutes the shop — but their taxi is asked about on its own account |

`RATING_EVERY_DAYS` sets that fortnight. **`0` asks after every single
delivery and trip**, which is what you want while testing the thing and what
you would regret in trade.

**If a rating did not appear, it is one of four things**, and in this order:
the customer was asked about that service inside the quiet period; the job
ended as cancelled or returned rather than delivered; the customer had not
messaged the shop in 24 hours, so the closing notice went as a template and a
template cannot carry a list; or that order had already been asked about
once.
| Never on a cancelled or returned order | The shop already knows it went wrong |
| Taxis and parcels too | A taxi is the one service where nobody from the shop sees the customer |

**The fortnight is counted per service, not per customer.** Groceries on
Monday must not silence a ride on Thursday: the two have nothing to do with
one another, and a taxi is the only job where the shop never sees the person.
The cost is that somebody using all four services inside a fortnight could be
asked four times, which is the price of hearing about each of them.

**A parcel's question goes to whoever booked it**, not to the recipient — the
sender is the one the shop can message, and often the one who paid. You hear
from the person who arranged it, not from the person who met the associate at
the door.

**A typed number works as well as a tap, but not for as long.** A tap can only
have come from the list, so it counts for two hours. A bare `2` is the second
service on the menu, the second kitchen, the second aisle — so it means two
stars only for **fifteen minutes** after the question, and is a menu choice
again afterwards. Getting that wrong does not lose a rating, it eats somebody's
order. A message with anything else in it — *"4 bags of rice"* — is never a
rating.

If the customer answers with something else entirely, the question is let go
rather than left in the way.

### Who gets offered a job

**Nearest first, widening on a timer.** Nearest is not measured from a live
pin — no associate is asked to share their location. It is measured from
**where each of them last finished a delivery, and when**, which is a fact the
order already records.

| Ring | Who | Then |
|---|---|---|
| 1 | Finished in the **same band** within **5 minutes** | wait **20s** |
| 2 | Finished anywhere on the **same corridor** within **10 minutes**, plus ring 1 | wait **15s** |
| 3 | **Everybody** | — |

A band is "East Bank near"; a corridor is the whole East Bank road. Neither
needs a pin at either end, which matters because most addresses here arrive as
words.

**Nobody loses a card when the offer widens.** Each ring adds people; the
first to accept takes the job and the rest are told it has gone.

**An empty ring is not waited on.** If nobody finished in that band, there is
no response to wait for, so it falls straight through to the next — which is
also why a kitchen marking food ready is told *dispatched* or *waiting* based
on what has actually happened, not on what a timer will do later.

**A job whose pickup the tariff cannot place goes straight to everybody.**
Everyone is equally near an address nobody recognises. An associate who has
finished nothing is not penalised either: they are simply not in the narrow
rings, and ring 3 is everybody.

Set any wait to `0` to switch the staging off.

| Setting | Default | |
|---|---|---|
| `DISPATCH_BAND_MINUTES` | 5 | How fresh a drop-off must be to count as "there now" |
| `DISPATCH_BAND_WAIT_SECONDS` | 20 | Before the corridor is told |
| `DISPATCH_CORRIDOR_MINUTES` | 10 | How fresh it must be to count as "on that road" |
| `DISPATCH_CORRIDOR_WAIT_SECONDS` | 15 | Before everybody is told |

### Coverage

`zones` answers two questions in one place, because neither is any use alone:
**where the work is** and **where the people are**.

```
*Coverage* — last 30 days, 32 jobs

*Georgetown* $500 · 7 jobs
   — nobody based here
*East Bank* $1,600 · 7 jobs
   Shanta (1 on duty)
...
*Most driving with nobody based there:* East Bank near — 7 jobs at $800.

_Wayne has no base set, so they are counted in none of these bands._
```

**A delivery is counted by where it went; a parcel or a taxi by where it
started.** The shop is always one end of a delivery, so the other end is the
interesting one — but a parcel begins wherever the sender is, and that is
where an associate has to be standing.

**The gap it names is ranked by road, not by job count.** Seven runs into
Georgetown and seven up the East Bank are the same number and nothing like
the same argument: one is a city round somebody is already doing, the other
is seven trips up a highway. Jobs × the band's fee is the closest thing to
"how much driving" the shop can know.

**Nobody is assumed to be anywhere.** An associate with no base is counted in
no band, and the report says who they are — otherwise every line reads as a
gap that may not be one.

`base <name> <place>` sets where somebody works from: `base Shanta Diamond`,
or `base Shanta at Mon Repos` when either half is two words. The place is
checked against the delivery tariff before it is saved, because a base the
tariff does not recognise would simply never appear in the report and the
shop would be left believing a coast was covered.

**Nothing here changes a price or a dispatch.** It exists so the decision
about where the next associate belongs is made from figures rather than from
the map.

### Restaurants

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
| `7 confirm` | Take a parcel or a taxi — there is no kitchen to accept it |
| `7 uplifted` | You have it, or the passenger is in the car |
| `7 delivered` | Dropped off |
| `7 nobody there` | Nobody at the door, or no passenger at the pickup |
| `7 details` | Everything about it: who, the number, the door, the cash |
| `7 pin` | Ask the customer for the exact spot |
| `7 transfer` | Hand order 7 to another associate |
| `cash` | What you are holding this shift |

### The rules

**As many as you accept.** This shop runs with
`MAX_JOBS_PER_ASSOCIATE=0` — no cap. Nothing is ever held back for being
busy: a taxi booked while you are mid-delivery still reaches you, and two
orders from one kitchen are one trip rather than a refusal.

Set it to `1` for the strict rule — nothing new may be uplifted while an order
is still undelivered, so the shop knows each associate is holding exactly one
thing. The refusal repeats the whole job card, because the original is buried
up the chat by then. Any number above 1 is that many at once.

With a cap in force, **a busy associate is offered nothing at all**. The job
waits and is offered again when they finish or somebody clocks on.

`/health` reports `maxJobsPerAssociate` — the figure actually running, which
settles it when the blueprint and the Render dashboard disagree. They did:
`render.yaml` declared the key twice, as `0` and again as `1`, and until that
field existed nothing said which of them the shop was obeying.

**Twelve hours.** A shift ends twelve hours after you clock on, and you cannot
work more than twelve hours in any rolling twenty-four, however you split them.
An order already in your hands is always yours to finish — the cap stops new
work, it never strands a delivery.

**A busy few days can lift both, with an end date.** In Render:

```
ASSOCIATE_HOURS_OVERRIDE=24
ASSOCIATE_HOURS_OVERRIDE_UNTIL=2026-11-21
```

Round the clock through the end of the 21st, in Georgetown time, then twelve
again on its own. Both limits move together — a rolling cap of 24 with a
clock-in that still lapses at 12 just clocks somebody off at lunchtime and
lets them clock straight back on.

**The date is the point.** A cap lifted by hand is a cap somebody has to
remember to put back, and nobody remembers on the Saturday of a busy week.
This one expires whether anyone is watching or not, and says so at boot:

```
[duty] 24 hours a day until the end of 2026-11-21, then back to 12
```

`/health` reports `dutyHours` with the limits in force and the override if
there is one.

One thing to know before lifting it. The twelve-hour lapse is also what closes
a shift somebody forgot to end. At 24 there is no automatic clock-off for a
day, so an associate who forgets `off` stays on duty — and since the shop only
takes orders while somebody is on duty, it will keep taking them. Worth a
word with whoever is working those days.

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

English, Spanish, Portuguese and Chinese, kept for the whole order —
including the menu. **Staff, associates and kitchens always work in English.**

**The shop's words to a driver or a kitchen are always English. The
customer's own words are translated for them and kept.** A doorstep note and
a note to the kitchen are the two things on a staff card the customer wrote
themselves, and they used to arrive exactly as typed — which left a driver
holding *Ligue quando chegar* and a cook holding *sou alérgica a amendoim*:

```
📝 *Note:*
No onion, I'm allergic to peanuts.
_(sem cebola, sou alérgica a amendoim)_
```

Both lines, always. The English is what gets acted on; the customer's own
words underneath are what is certainly right, to show somebody or read down
the telephone when the English reads oddly. **The original is never replaced.**

Translated once, when the order is dispatched — a path that is already
talking to WhatsApp, so no customer waits on it — and written down, so a
re-sent card costs nothing. If there is no API key, no network, or the model
is slow, the card goes out with the customer's own words alone, exactly as
before.

**Never an address.** `Lot 8 BV` is not a sentence, and a place name
translated is a driver sent somewhere else.

A kitchen note is a separate field from a doorstep note because they are read
by different people in different buildings: a kitchen is shown no address and
no telephone number, so *"no onion"* never reached it and *"blue gate"* would
be noise if it did. Where the menu offers the choice properly — size, side,
how it is cooked — that is an item option and not a note.

**The first screen anybody sees is the language, asked in all three.** Before
the service menu and before the model, because a customer who cannot read the
question cannot answer it:

```
👋 *Welcome to Next Minute Delivery.*
Please select your language.

👋 *Bienvenido a Next Minute Delivery.*
Por favor, elija su idioma.

👋 *Bem-vindo a Next Minute Delivery.*
Escolha o seu idioma, por favor.

   [ English ]   [ Español ]   [ Português ]
```

The tap sets the language and the service menu follows in it immediately —
*Bem-vindo*, `1. Táxi`, *Responda com o número*.

**It keeps coming back until it is answered.** A customer who types past it
has chosen nothing, and everything the shop says after that is a guess at
what they read — so the screen is the answer to their second message too,
and their third. The choice is kept against the number, and unlike the
service menu it does not come back once it is made, however cold the
conversation goes.

**It never starts for a customer the shop already has.** Three things decide
it: nobody has answered it from this number, and either this is the first
message that number has ever sent or the screen has been put to them before,
and there is no job of theirs on the books. The question begins on a
stranger's first message and on nobody else's — otherwise every customer on
the books would be stopped for a language screen on their next message, some
of them midway through booking a car, and somebody whose number a dispatcher
wrote down would be greeted as a stranger while their parcel was on a van.

**The answer can be written as well as tapped.** `English`, `Español`,
`Português`, `中文` and the ordinary spellings of each — on their own, as the
whole message. Needed because the screen now repeats: somebody whose WhatsApp
will not draw buttons would otherwise meet it for ever. Read only while the
question is open, so `english` from a customer long past it is just a word.

**Typing `language`, `idioma`, `língua` or `语言` brings it back**, from
anywhere. That is the way out for somebody who taps the wrong button and
cannot read a word of what comes next.

**Chinese has no button on purpose.** WhatsApp allows three; the shop speaks
four. The fourth is the one whose speakers can declare it without help —
anybody who writes a single Chinese character is switched to Chinese by
detection, which is a surer signal than a tap. Detection still runs for all
four, and still only ever sets a language, never clears one: `ok` and a
thumbs up give nothing away. What it cannot do is override a CHOICE, which is
the difference between the two records the shop keeps.

### Taxi

First on the menu. There is no catalogue and no cart — two ends and a
passenger — and the delivery associates drive these themselves. The full
journey is [chapter 8](#8-taxis); this is what the customer sees.

```
1. Taxi
2. Grocery shopping
3. Restaurant ordering
4. Parcel delivery
5. Other
```

> A car it is. 🚕 Where are we collecting you from, where are you going, and
> when? Tell me how many of you as well, and I will find you a car.

Four things in as few messages as possible — **from, to, when, how many** —
read back, then booked with `book_taxi`. Either end can be a pin or an address
in words; the job goes out to the associates the moment it is booked.

**No fare is ever quoted, and no car or time is promised.** The driver agrees
the fare with the passenger, and a price nobody agreed to is an argument on a
kerb.

**"Car" is matched as a whole word.** This shop sells carrots, and without
that a shopping list would be answered with a taxi. "Pick up" and "drop off"
stay with parcels, where a customer saying *"pick up something from the shop"*
means one every time.

**This needs an associate on duty.** With nobody on the road the booking is
refused and the customer is told so plainly, rather than being told a car is
coming.

### What the agent can and cannot see

**The agent never sees a status update.** Everything after an order is placed
— confirmed, on the way, the receipt, the points, the rating — is sent to the
customer by the shop and does not pass through the conversation. The last
thing the agent knows about a job is its own sentence saying it was booked.

Left alone, that caused a real fault: asked for a second car, it said the
trip booked an hour earlier was still running. It was not being stubborn — it
was answering from the only account it had.

So every turn it is told, from the orders themselves, what is actually
running:

```
Still running for them: TXI-00035 (out with the delivery associate).
Anything else they have is finished.
```

and, when nothing is:

```
Nothing of theirs is still running — every job they have is finished,
cancelled or came back. Never tell them an old one is still live, and never
refuse a new one on account of it.
```

**The empty case is the one that matters.** Saying nothing would leave the
agent's own stale sentence as the most recent thing it knew.

### Who the customer is talking to

**The customer associate.** The delivery associates ride; this one takes the
order, works out where it is going and sees it placed. Groceries, restaurant
food and parcels — one chat, three services.

**It has no name and never invents one.** Asked what to call it, it says it is
the customer associate at the shop and asks what they need. It never borrows a
staff member's name and never signs off with one.

The manner is the whole of the personality: somebody competent behind a
counter who knows the shop and is pleased to help without making a performance
of it. No persona, no catchphrase, no emoji habit.

It says **your** customer associate, never *the* customer associate. The first
belongs to the customer; the second is a job title on a wall.

### "Are you a real person?"

It answers with what it is and goes back to the order:

> I'm your customer associate here at Next Minute Delivery. What are we
> getting for you today?

**It never claims to be a human being, and never denies what it is either.** It
does not volunteer it, it does not apologise for it, and it never says "I'm
just a bot". Asked again, it says the same thing in fewer words and offers the
manager.

**The manager comes with the answer, not after a fight.** Three things have to
be in that offer, in whatever words suit the customer and their language:

> If you'd rather speak to my manager, I can pass on your number so that
> direct contact can be made with you — or if you have an alternative you can
> state and share that too.

1. A manager can be reached — a person, offered rather than grudgingly allowed
2. Their own number can be passed on, so contact comes to them
3. Or they may name another number — put to them, not left for them to think of

And two things that must **not** be in it.

**No promise of when, and none of how.** The shop does not know either.
"Within the hour" that takes two is a second complaint — and a customer told
the manager will reply on this chat, who is then rung on the telephone, was
watching the wrong place. *"I've passed it on"* is the whole of it.

**No pronoun for the manager.** "He" or "she" guesses at somebody the customer
has never met; "they" reads as a department rather than the one person just
promised to them. The sentence works without either — *"so that direct contact
can be made with you"*.

```
✗ "...so they'll call you"        reads as a department, not one manager
✗ "...so he can call you"         guesses who the manager is
✗ "...within the hour"            promises a time nobody knows
✗ "...they'll reply right here"   promises a place; the manager may ring
✗ "You can ask for a manager"     permission, not an offer
```

On a yes, `request_staff_help` puts the customer's name, number and a `wa.me`
link in front of staff, who decide for themselves whether to write or ring. An
alternative number is read back before it is passed on.

Somebody who asks twice, or sounds annoyed, is not curious — they want a
person. It stops answering and hands over.

**And if there is nobody to pass it to, it says so.** With `STAFF_NUMBERS`
empty the agent does not claim the request has gone. It says it has been
written down and somebody will come back to them — which is true, because it
is written down:

```
"passed_on": false,  "written_down": true
```

Every request is recorded before anybody is told, and marked delivered only
when staff have actually received it. At the next boot, any that are still
waiting are sent — with their age attached, so a complaint from three days ago
is not answered as if it arrived this minute:

```
[notify] 2 customer(s) who asked for a person have been passed on
```

So setting `STAFF_NUMBERS` for the first time does not just fix the next
request; it delivers the ones already waiting. `/health` reports
`pendingHelp` — how many customers are still owed a person.

It used to report every request as passed on regardless, because the
notification was fired off without waiting for an answer. A shop with no staff
number told its customers their number had gone to the manager while the log
said nobody had been told.

### The same as last time

A weekly shop is the same rice and the same milk, so a regular is offered
theirs rather than walked through the aisles. Anything like *"the usual"*,
*"same as last week"*, *"same again"* fills the basket from their last order.

**It will not pretend.** Three things are reported before the customer agrees
to anything:

- what is **no longer available**, named rather than quietly dropped
- what **costs more than last time**, with the old price and the new
- the **basket and its total**, read back for them to change

A customer who said yes to "the usual" and was then charged more for it was
not told the truth, and a bag that arrives short of the milk they thought they
had ordered is worse than being told at the time.

**It will not double a half-shopped basket** either. Somebody who has already
started and then says "and the usual" is asked whether to keep what they have,
start again, or set it aside — mixing two shops into one basket silently is
how somebody is charged twice for rice.

Nothing is ordered by repeating; it fills the basket and stops.

The prompt had promised this for months — *"greet a regular by name and offer
their usual order rather than starting from scratch"* — with no tool that
could do it. The agent could read a past order out and then had to walk them
through the aisles anyway.

### Shopping by number

Somebody who says they want to shop, and has not named anything, gets the
aisles — not a question about what they are after. They came to see what is
there.

```
What are we getting today?          *Fresh Produce*

 1. Fresh Produce                   (a) Bananas — $420 (per kg)
 2. Meat, Fish & Poultry            (b) Bora — $320 (bundle)
 3. Dairy & Eggs            →       (c) Callaloo — $280 (bundle)
 ...                                 ...
11. Baby                            (l) Watermelon — $1,200 (each)

Reply with a number.                Put the quantity beside the letter,
                                    like *a x2, d x1* — or type
                                    *categories* for the aisles again.
```

**The shop writes the lines; the agent sends them.** It used to hand back a
letter, a name, a price and a unit with a sentence asking for
`(a) Name — price (unit)` — and a request is all that was, so the brackets
came and went. Formatting a list is the shop's job: the labels are what the
customer is about to type back, and a list that looks different every time it
is opened is one nobody learns to read.

**Aisles are numbered; items are lettered, in brackets.** Both were numbered to begin with,
and it went wrong in the obvious way: once an aisle was open, `1` meant the
first product — and `1` is also exactly what somebody types when they want the
first aisle. The shop could tell which list was last on the screen; the
customer could not. Letters make the two impossible to confuse.

Past `z` the letters double up — `aa`, `ab` — which no aisle here needs, the
largest being twelve, but a shop importing a catalogue of its own will.

Somebody who types `3 x2` at a lettered list is not corrected. It resolves to
the third item, because they have said exactly what they want.

**Every aisle says how to get out of it.** Somebody who opened the wrong one,
or has finished with the right one, needs the way back on the screen rather
than remembered — and it is said again after something is added, when they are
asked whether that is everything.

Then `a x2, d x1, k x3` puts two bananas, a kilo of carrots and three kilos of
tomatoes in the basket. An aisle can be opened by name as well — *"dairy"*
— and a reply can mix the two: *"3 x1 and 2 of number 1"*.

**A list goes stale after two hours.** Past that the aisle is sent again
before a letter means anything. It used to last for ever: somebody who opened
an aisle, wandered off and messaged three days later with "a" had an item put
in their basket against a list nobody could still see.

**The shop labels the list and the shop resolves the labels.** The agent is
never asked which product a letter meant. A list relettered while retelling it
puts the wrong thing in somebody's bag, and they find out when it arrives — so
the labelling is written down when the list is sent, replaced each time, and
read back when they answer.

**A letter that was never on the list is asked about, not guessed at:**

```
"and z"
→ the list only went up to e. Ask which one they meant.
```

**Nobody is trapped in it.** Numbers are the easy path, not the only one.
Somebody who types *"2 lb chicken and a bread"* gets that, without being sent
back to a list, and *"categories"* brings the aisles back.

Why a list rather than buttons: WhatsApp allows three reply buttons, and there
are eleven aisles and twelve things in Fresh Produce. A written list costs
nothing, fits any length, and lets somebody answer three lines of it in one
message — which is how a person writes a shopping list anyway.

### Choosing groceries opens the shop

**Picking 2 shows every aisle**, numbered, with how many things are in each
and how to move around them. It used to open with a sentence — *“tell me
what you need”* — which is an invitation to somebody who already knows what
they want and a blank wall to somebody who does not. A shop's answer to
*what do you sell?* is its aisles.

```
🛒 *The shop* — 11 aisles. Here is everything we carry:

1. Fresh Produce (12)
2. Meat, Fish & Poultry (8)
3. Dairy & Eggs (5)
   …
11. Baby (2)

Reply with an aisle number — *1* to *11* — to see what is in it.

Tap *Leave groceries* at any point to go back to the main menu; from inside
an aisle there is a *Categories* button to bring this page back.
   [ ⬅️ Leave groceries ]
```

**One button here, two everywhere else.** On the aisle list itself
*Categories* would go where they already are, so only the door is offered.
Inside an aisle, and on every other message while they are shopping, both
appear.

**The moment something goes in the basket, the buttons change:**

| Where they are | What is offered |
|---|---|
| Empty basket, aisle list | `[⬅️ Leave groceries]` |
| Empty basket, anywhere else | `[🛒 Categories]` `[⬅️ Leave groceries]` |
| **Full basket, aisle list** | `[🛒 Basket · $7,820]` `[✅ Check out]` `[⬅️ Leave groceries]` |
| **Full basket, anywhere else** | `[🛒 Basket · $7,820]` `[✅ Check out]` `[🛒 Categories]` |
| **On the basket** | `[✅ Check out]` `[🛒 Categories]` `[⬅️ Leave groceries]` |

Three is WhatsApp's limit and four things want the room, so what gives way
is whichever button goes where they already are — *Categories* on the aisle
list, *Basket* on the basket — and *Leave groceries*, which lives on the
basket page and has always answered to the word *menu* as well.

**The basket button carries the goods, not the total.** The total includes a
delivery fee nobody has agreed yet — the flat rate, standing in until a zone
is settled — and a button quoting it would be quoting a figure the customer
has never been shown and may never be charged.

```
🛒 *Your basket*

(a) 2 x Karibee Parboiled Rice — $3,700
(b) 1 x Sunflower Cooking Oil — $1,420
(c) 3 x Plantains — $2,700

*Goods $7,820* — delivery is worked out when you say where it goes.

To change something: *a x3* makes it three, *a x0* takes it out. Or just say it.
   [ ✅ Check out ]  [ 🛒 Categories ]  [ ⬅️ Leave groceries ]
```

**It is lettered like an aisle, and for the same reason.** `a x2` is how the
thing got in, so `a x3` is how it changes and `a x0` is how it goes —
nothing new to learn. The letters are written down as the page is sent, so
the letter they answer with is the line they were looking at.

**Check out** hands straight to the shop's own sequence — place, pin, price
— unless something stands in the way, in which case that is said here with
the figure:

```
🛒 Your basket is *$640*, and the smallest order we can send out is
*$1,000* — *$360* to go. Add anything and we are away.
   [ 🛒 Basket · $640 ]  [ ✅ Check out ]  [ 🛒 Categories ]
```

**The minimum is checked before the sequence, not at the end of it.** It
used to be enforced only by `place_order` — the very last tap — so a basket
under it was taken through the place, the pin, the name and a price with
*Book it* on it, and then refused. A customer reads that as the shop
breaking. A rule they can meet by adding a tin of milk belongs in front of
them while they are still shopping.

**How to answer is explained where the answers are**, at the foot of an
aisle rather than on the front page three screens before anybody sees a
letter:

```
(a) Bora — $320 (bundle)
(b) Plantains — $900 (bunch)
(c) Tomatoes — $420 (per kg)

_Reply with a letter and how many — *a x2* — or just type what you want.
A number is always an aisle and a letter is always a thing on a shelf._

   [ 🛒 Categories ]  [ ⬅️ Leave groceries ]
```

That last line is written by the shop and sent with the list, not left to
the model to remember.

**The way out is on every message the shop sends while they are shopping.** A customer three lists deep had no way back to the front of the
shop except by typing something and hoping. They ride on the last message of
each turn, because a button higher up a chat is a button nobody finds — and
they are left off any message that is already asking something, where two
extra answers would make the question ambiguous.

The numbering is written down as it is sent, so the number they reply with is
the number the shop resolves. A list renumbered in the retelling sends
somebody to the wrong aisle.

### The grocery aisles

Eleven, in the order somebody shops rather than by first letter:

| | Aisle | |
|---|---|---|
| 1 | Fresh Produce | 12 |
| 2 | Meat, Fish & Poultry | 8 |
| 3 | Dairy & Eggs | 5 |
| 4 | Bread & Bakery | 3 |
| 5 | Rice, Peas & Pasta | 8 |
| 6 | Cooking Basics | 9 |
| 7 | Flour, Sugar & Baking | 4 |
| 8 | Tinned Food | 4 |
| 9 | Drinks & Snacks | 9 |
| 10 | Household & Personal Care | 8 |
| 11 | Baby | 2 |

They came out of the import alphabetically before, which opened the list with
*Baby, Bakery, Baking* and buried fresh produce in the middle. Four aisles
held two or three items, and three of them overlapped — flour and sugar under
*Baking*, oil and salt under *Cooking Essentials*, rice and split peas under
*Rice & Grains*, all of it dry store, so a customer hunting flour could
reasonably try any of the three.

**Every aisle is named in English**, including Cooking Basics, which was
briefly Básico de Cocina after the shop's own Spanish name. One Spanish label
among ten English ones reads as an oversight rather than a choice — and the
agent translates what it says about an aisle anyway, so the name in the data
is the shop's working language while the customer still hears their own.

**A menu is not a set of aisles.** The rename touches products belonging to a
grocery and nothing else — the roti shop has a *Snacks* category of its own,
and a rename by name alone would have re-labelled its food as *Drinks &
Snacks*. Restaurant categories keep their own alphabetical order, after the
grocery ones.

A shop that invents a category of its own keeps it. Anything not in the list
sorts after the eleven, alphabetically among themselves, rather than being
hidden or forced into an order nobody gave it.

### When the customer wants it

**On a grocery order the shop asks**, once the basket is settled and before it
is placed:

> When would you like it? I can send it as soon as it's packed, or hold it for
> a time that suits you.

Most say now. Somebody at work until five, or wanting it before the children
are home, has no way to say so unless asked — and a bag left with a neighbour
because nobody was in is how a customer is lost for good.

**Both halves are kept: the time, and their own words.**

```
🕒 *Wanted after 5pm* (Wed 5:00 pm)
```

Their words lead, because *"before six"* is not a point in time and a card
showing `18:00` has lost the half that matters. The clock time follows in
brackets, since that is what a round is planned by. Somebody who only says
"after lunch" gets exactly that, with no invented clock time beside it.

It reaches **the picker**, so a bag is not packed five hours early and left to
warm, **the dispatch desk**, and **the associate's card** at the door.

**What is refused:** a time that has already passed — *"ask whether they meant
later today or tomorrow"* — anything more than a week out, and anything that
is not a readable time. That last one is not a refusal of the customer: "after
lunch" belongs in the note, where it is read rather than parsed.

**Nothing is promised.** The shop aims for the time; it does not know what the
road will do, and *"I'll make sure it's there at five"* is a promise nobody
authorised. It is said back once in the confirmation and then left alone — a
shop that keeps mentioning the time sounds like one that might miss it.

**Groceries only.** Restaurant food is cooked to order and goes when it is
ready; holding it means cold food. A parcel is uplifted when an associate
takes it.

**No scheduler runs this.** The time tells the people doing the work when it
is wanted; the grocery decides when to pack, which is the only way a bag of
milk arrives cold rather than warm.

### A cancelled order goes back on the shelf

Stock is taken at checkout and **put back when an order dies** — cancelled by
anyone, or returned because nobody was at the door. A delivered order's stock
stays sold.

It only ever went down before. Nothing anywhere added it back, so every
cancellation quietly removed stock the shop still had, compounding until an
item read as sold out while sitting on the shelf.

Done once per order, through a flag on the order rather than its status: an
order can reach cancelled twice — a retried webhook, a second tap of a button
that never greys out — and the second must not put the same four bottles of
milk back again.

Products that do not count stock are left alone, and a product deleted from
the catalogue since finds nothing to credit, which is right: there is no shelf
to put it back on.

### Nobody on the road

**With no delivery associate on duty, no order is taken.** The shop can be
wide open and still have no way to get anything to anybody, and an order taken
then is food packed for a counter: it sits at *ready* while the customer waits
and nobody can tell them why.

The associate is told every turn, before the customer starts shopping:

```
NO DELIVERY ASSOCIATE IS ON DUTY — nothing can be delivered right now,
and you must not place an order. Say so before they start shopping,
kindly and without blame... Do not say when, because you do not know.
```

Said early on purpose. Somebody who shops for ten minutes and is only then
told nothing can be delivered has wasted their evening.

And refused in the code as well, for groceries and parcels alike, so it cannot
be talked past:

```
Cannot place the order — no delivery associate is on duty...
Offer to hold their list with park_cart and invite them to message again.
```

**Three things it will not do:** blame anyone, promise when somebody will clock
on, or throw the list away. `park_cart` keeps the shopping so that one `on`
from an associate is all it takes to finish.

Duty means what it means everywhere else: clocked on with `on`, not
deactivated, and inside the twelve-hour cap. A shift that has run out is not
duty. `/health` reports `associatesOnDuty` — zero means orders are being
refused.

An order already placed is unaffected. Dispatch still offers a cooked order to
everyone when nobody is clocked on, which is a safety net for work already
taken, not a contradiction: duty decides whether to accept an order, that
decides how hard to try for one already accepted.

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

### Booking a parcel, one end at a time

A parcel needs six facts — two names, two addresses, two telephone numbers —
and nobody gives six facts in one message. So it is collected in halves, with
a button to start each, and each half is written down the moment the customer
agrees it.

```
+----------------------------------------------+
| Parcel delivery it is. 📦                    |
|                                              |
| I need two sets of details — who it comes    |
| from, and who it goes to.                    |
|                                              |
| Start with the sender?                       |
|----------------------------------------------|
| [ Sender details ]  [ Recipient details ]    |
+----------------------------------------------+
```

Whichever they tap, that half is asked for in one numbered message — name,
address, telephone number — and read straight back:

```
| Got it:                                      |
|                                              |
| *From:* Patrice Jacobs                       |
| 26 Brickdam, Georgetown                      |
| 📞 +5926129920                               |
|                                              |
| Is that right?                               |
|----------------------------------------------|
| [ Yes, correct ]  [ Change it ]              |
```

**A button cannot collect text.** WhatsApp reply buttons send back a label and
nothing else, so the customer still types the three lines. What the buttons
buy is that nobody wonders whose details are being asked for, and a mistake
costs a tap instead of a paragraph.

**The recipient's read-back settles the price too.** Their address is where the
parcel is going, so naming the area in it — *"that's Diamond on the East Bank,
is that right?"* — confirms the person and the delivery zone with one yes.

**A parcel is priced from the same tariff as everything else**, by the
recipient's zone. It used to be costed only by the distance between two pins —
which needs two pins, and since an address alone became enough to book one,
most parcels have fewer than two. Those went out unpriced, the customer told
only that the associate would confirm the cost at the uplift. ORD-00007 was
one of them.

The zone needs no pins and is already agreed in the read-back above. Where
both pins happen to exist, the distance limit still refuses a trip that is too
far — a tariff naming a village thirty kilometres away does not make the
journey possible.

**The parcel's zone is kept on the parcel, not on the customer.** A parcel
goes where the customer is not, so a zone confirmed while sending something to
Diamond must not price their own shopping next week as if they lived there.

With no agreed zone and no `PARCEL_FEE_BASE`, a parcel is still taken and
still unpriced — the associate agrees the cost at the pickup, which is the
behaviour that was there before.

**Nothing is asked for twice.** Each half is stored as it arrives, and a
partial answer keeps what was already given: correcting a telephone number
does not lose an address that was right. `parcel_status` reads both halves
back at any point, which is what makes a gap in the conversation survivable:

```
sender    : Patrice Jacobs, 26 Brickdam, Georgetown, +5926129920
recipient : Marcia Persaud, Lot 9, Diamond, East Bank, +5926100077
contents  : not said yet
```

**And the booking repeats none of it.** `create_parcel_job` reads what was
agreed, so the six facts are never retyped — a name typed a second time from
memory is exactly how a parcel reaches the wrong door.

A half cannot be confirmed before it is complete; the tool says which of the
three is missing and refuses.

### Nobody is charged a fee they were not told

**The shop never charges a delivery fee higher than the one the customer
agreed.** Enforced in `place_order` and `create_parcel_job`, not asked of the
model — a prompt is a request.

| | |
|---|---|
| Nothing quoted | Checkout is **refused**, and says to call `delivery_zone` |
| Charged **more** than agreed | **Refused**, naming both figures |
| Charged **less** | Allowed — the promise is a ceiling, not a price list |
| Charged nothing | No agreement needed |

The figure becomes agreed at the **two-step read-back**: the shop matches the
place, the agent reads it back, the customer says yes. That is also where a
free-delivery basket or a reward is allowed to come in under the quote without
anybody re-confirming.

**No pin is needed to price anything.** The tariff matches the words a
customer types — "Lot 9, Diamond, East Bank" — against 185 place names, on
sound as well as spelling. Coordinates play no part in a delivery charge. A
pin is still worth asking for, because it is the only thing the delivery
radius can be measured against and the only thing that becomes a map link on
the associate's card, but it is not what sets the price.

**A village the tariff has never heard of still gets a figure.** The shop has
185 places and the country has more. When nothing matches, the agent tells
them the standard charge their basket carries and confirms that instead —
`delivery_zone` with `confirmed` true and no place. No zone is written to
their record, because a place is a price and nobody agreed to a place.

**A parcel quotes the whole journey, not the destination.** Pricing from both
ends made the fee fairer and made the old read-back wrong: a sender in Parika
heard *"Diamond, $1,800"* and would have been billed $6,300. The read-back now
says:

> Delivery from Parika to Diamond is $6,300.

**A taxi has no fare to quote, so it says so before anything is booked.** The
line is fixed text from the shop, sent the moment the customer chooses Taxi —
not left to the model:

```
A car it is. 🚕 Where are we collecting you from, where are you going, and
when? Tell me how many of you as well, and I will find you a car.

The fare is agreed between you and the driver — we do not set it.
```

### What a delivery costs

Delivery is priced by the village or area it goes to, from a tariff the shop
keeps in `data/delivery-zones.csv` — place, zone, fee, one row each. Edit it
and restart; nothing else to set. No tariff, and every delivery stays at the
flat `DELIVERY_FEE`.

```
Diamond,East Bank,1800
Vreed-en-Hoop,West Bank near,2500
Meten-Meer-Zorg,West Coast,4000
```

**Measured by road, once, with `npm run roads`.** The coordinates in
`data/zone-coordinates-review.csv` were geocoded from OpenStreetMap and the
distances beside them are straight lines from town — which is why every
inversion the tariff audit reports carries a caveat. This asks Google's
Routes API how far each place really is by road, and looks up the places OSM
had never heard of. It changes **nothing**: it writes
`data/road-distances.csv` and `data/places-found.csv` and prints where the
straight line lies most, for a person to price.

It needs `GOOGLE_MAPS_KEY` in the environment, with the **Routes API** and
**Geocoding API** enabled on that key. Without one it says so and stops. It
is run by hand and never by the shop: a delivery that cannot be priced
because somebody else's API is slow is worse than a price that is a little
rough, and a road in Guyana does not move between Tuesday and Wednesday.

The whole job is about 230 calls against a free allowance of 10,000 a month
per API, so it costs nothing — but set a daily quota cap in the Cloud
console anyway, because a key that can only spend a dollar is a key you can
stop thinking about.

**Zones, not kilometres.** Vreed-en-Hoop is 2.8 km from the shop across the
water and **16.4 km by road**. Straight-line distance under-prices exactly
the trips that cost most, and the west side is priced from the bridge.

**The West Bank was repriced from the road on 22 November 2026.** Measured,
it is the shop's *dearest* corridor per kilometre — $178 against the East
Coast's $89 — which is the bridge, and is right. What was wrong was inside
the corridor: Vreed-en-Hoop was further by road than Schoonord, La Grange,
Goed Fortuin and Bagotville, and charged less than all four, because it is
the first stop off the bridge and *feels* near.

| | road | was | now |
|---|---|---|---|
| Vreed-en-Hoop | 16.4 km | $2,500 | **$2,900** |
| Pouderoyen | 17.6 km | $2,500 | **$3,000** |
| Malgre Tout | 14.7 km | $2,500 | **$2,800** |
| La Grange | 12.7 km | $3,000 | **$2,800** |
| Bagotville | 14.9 km | $3,000 | **$2,800** |
| Toevlugt | 16.2 km | $3,200 | **$2,900** |
| Wales | 20.7 km | $3,500 | **$3,100** |

Revenue-neutral across those fourteen deliveries — $41,000 before, $41,200
after. It moves money between villages to match the road rather than taking
more from the west side. `npm run tariff:check` now reports **no West Bank
inversions at all**, because it reads the road distances where they exist.

**The place is confirmed before the price is said.** The agent looks up what
the customer wrote, reads the matched name back — *"that's Diamond on the East
Bank, is that right?"* — and only then is the figure quotable. The tool will
not hand over a fee until that has happened, and will not accept a place name
the shop never offered.

### Checkout is the shop's, not the agent's

Once the basket is right, the agent calls `start_delivery` and stops talking.
Everything after that is a fixed sequence run in code — six questions, each
with a right answer and no judgement in it, which makes it the wrong job for
a language model: slower, priced per message, and different every time.

| | |
|---|---|
| **1. the place** | The list, as the taxi's — or type the name |
| **2. the exact spot** | `[📍 Send location]` `[Skip]` — **or type anything the associate should know** |
| **3. the price** | The whole amount, with `[Book it]` `[Change destination]` `[Cancel]` |

**The area comes before the pin, and that order is enforced.** The area is
what fixes the charge; the exact spot is worth asking only once the customer
knows what the trip costs. The agent used to be told to ask for a pin *“as
soon as it is clear they intend to order”*, so it asked while somebody was
still reading a menu — and the figure that depends on where they live
arrived afterwards as a surprise. `request_location` now refuses a grocery
or restaurant order outright: the shop asks, at checkout, in that order. A
**parcel** may still be asked, having two ends and neither on a list.

**And “that's all” is read by the shop, not the model.** Told to hand over
when the basket was right, the agent answered *“thanks, that's your order
ready to go”* and waited — a dead end with a full basket in it, which is the
most expensive turn there is. The ordinary ways of saying it, in all four
languages, now start checkout themselves. It has to be the whole message:
*“that is all I need from the fresh produce”* is a sentence about an aisle.

Two questions before the figure, and that is the point. A street is asked
only when they skip the pin and the shop holds no address; a name only when
the shop does not know it. Both are exceptions rather than steps — walking
it showed that four messages between choosing a village and seeing a price
is three too many.

**The doorstep note rides on the pin message.** That message has three
answers, not two: send the spot, skip it, or just type *“blue gate, ring
twice”* — which is written down as the note and goes straight on to the
price. It used to be a question of its own.

### Changing where a delivery is going

**A customer may move a delivery as often as they like, and the associate
carrying it settles every one.** The mirror of a taxi's destination change,
and settled from the opposite side for the opposite reason: a passenger
cannot be driven somewhere the driver has not agreed to, and a bag cannot be
taken somewhere the person holding it has not agreed to either — they may be
two streets from the old door, or on a run of five drops this would break,
and they are the only one who knows.

```
Customer ▸ "can you send it to Buxton instead"
Shop     ▸ "Taking it to Buxton instead makes the delivery $1,800
            rather than $1,200."
Customer ▸ "yes"
Shop     ▸ "Asked your associate about *Buxton* — nothing changes until
            they say they can take it there. I will tell you either way."

Associate ▸ ⚠️ *GRO-00002 — the customer wants it taken somewhere else.*
            Now: *Buxton*
            Was: Diamond
            Delivery $1,200 → *$1,800*
            Nothing has changed yet. Tap *Acknowledged* only if you can
            take it there.
            [Acknowledged]  [No, as booked]
```

**Acknowledged** moves the order, re-prices the delivery, carries the total
with it, and sends the associate the whole card again — it is what they will
work from at the door. **No, as booked** leaves everything where it was. The
customer is told either way, in their own language, without the agent being
involved.

### The associate can ask where exactly

`7 pin` — and the shop asks the customer for that job's door. `7 location`
does the same, and so does a bare `pin` when they are carrying only one job.

```
rider ▸ 1 pin
      ◂ GRO-00001 — asked them for the exact spot.
        You will get the card again with the link on it as soon as they
        send it. Carry on; if nothing comes, ring +5926106060.

them  ◂ Your delivery associate is on the way with GRO-00001 and cannot
        find the door. Send your exact spot on the map and they will come
        straight to it — or tap Skip and they will ring you.
        [📍 Send location]  [Skip]
```

Until this, `⚠️ NO PIN — ring before you set off` left ringing as the only
move: a telephone call from a bike, to somebody who may be cooking, for a
landmark the associate then has to remember — when the customer is holding
the one device that can answer it properly in two taps.

The answer lands on **that job** and nowhere else, and the associate is sent
the whole card again with the link on it. It goes to whoever is at the door,
which on a parcel or a gift is not the person who ordered it.

**It says when it cannot help.** Outside WhatsApp's 24-hour window the shop
cannot write to them at all, so instead of sending nothing it hands back the
number and says to ring. A delivered or cancelled job refuses: there is
nothing left to find.

**`pin` on its own, when they are carrying one job.** The number is a
safeguard, not a ceremony: somebody holding three deliveries who types `pin`
has not said which door they are standing at, and guessing would send the
question to the wrong customer, who would then be out at the gate for
nothing. Somebody holding one job has already said which one by holding it,
so the shortcut is theirs:

```
rider ▸ pin
      ◂ GRO-00001 — asked them for the exact spot.

rider ▸ pin                            (now carrying two)
      ◂ Which one? You are carrying 2:

        `1 pin` — GRO-00001, Ann, Diamond
        `2 pin` — GRO-00002, Pin Two, Lot 9 Buxton

rider ▸ pin                            (carrying nothing)
      ◂ You are not carrying anything, so there is nobody to ask.
        Send `jobs` to see what is waiting.
```

“Carrying” here means everything assigned to them and not yet finished with
— wider than the one-job-at-a-time limit, which counts only what is out on
the road. A job they have accepted and are walking to collect is the job
they are about to be standing outside the door of, so it counts.

**A parcel's new pin is marked as the recipient's.** A parcel addressed to
somebody else shows a map link only when the pin is known to be for *that*
door — every order copies the buyer's saved pin at checkout, and on a
delivery to somebody else that pin is the buyer's own house, so a link built
from it would send an associate confidently to the wrong place. But a pin
that arrives **after** the order was placed, in answer to *"send the exact
spot for the new address"*, is a pin for the new door by definition. Left
unmarked it was stored and then hidden: the associate was told ⚠️ *NO PIN —
ring before you set off* while the exact door sat on the record.

**A pin owed outranks the service menu.** The block that catches it used to
sit below the menu, so a customer whose service had been cleared — they
tapped *Leave groceries*, asked for the menu, or came back after the
conversation went cold — sent the exact spot they had just been asked for and
was answered with *"Pick a number first and then send that again."* A request
for a map, put to somebody holding a map, and their answer thrown away while
an associate stood in the road. `7 pin` made it easy to reach: the shop now
raises that question whenever an associate cannot find a door, which is not
necessarily while the customer is in the middle of anything at all.

**The pin is collected BEFORE the associate is asked.** The customer says
where, agrees the new charge, and is then asked for the exact spot — and
only then does the question go to the associate, with the door on it:

```
⚠️ *GRO-00001 — the customer wants it taken somewhere else.*

Now: *Buxton*
Was: Diamond
Click the link below for the new address:
https://www.google.com/maps?q=6.756000,-57.983000

Nothing has changed yet. Tap *Acknowledged* only if you can take it there.
   [Acknowledged]  [No, as booked]
```

Asked the other way round, as it was at first, the associate agreed to
*“Buxton”* and found out where in Buxton afterwards. Somebody deciding
whether they can carry a bag somewhere should be looking at the place, not
at a village name.

The pin waits on the **proposal**, not on the order: nothing has changed
yet, and a job whose pin moved before anybody agreed would send the
associate to a door nobody had chosen. On **Acknowledged** the address, the
charge and the pin move together. On **No, as booked** all three stay where
they were.

Skipping the pin does not block it — the question goes to the associate
with *⚠️ No pin for the new address* on it instead, which is the honest
version and lets them decide knowing what they do not know.

**The old pin goes with the old door, and a new one is asked for at once.**
The old pin was dropped on an address nobody is going to any more, and a map
link is the one thing on a card an associate would trust over the words
beside it. But a village with no link is the other failure: the words were
confirmed by the customer and the map was not, on exactly the delivery that
just became harder to find. So the moment the associate acknowledges:

```
Now send your exact spot at *Buxton* on the map and your associate will
come straight to the door — or tap Skip and they will ring when they are
close.
   [ 📍 Send location ]  [ Skip ]
```

The pin lands on **that order** and never on the customer — an address that
changed for one delivery is not where they live, and saving it as theirs
would send next week's shopping to a friend's house. The associate gets the
card again with the link on it; `⚠️ NO PIN — ring before you set off`
stands until it arrives, and stays if they skip.

**The fee and the total move together.** A bag going twice as far costs what
twice as far costs, and an order whose address changed while its money did
not is a figure somebody has to argue about at a gate.

**Words while the price is on the screen put the price up again.** They used
to go to the agent, which has no idea an order is sitting one tap from being
placed.

```
1 x Chicken Curry with Roti — $1,400
Delivery to Beterverwagting — $1,200
*Total $2,600*, cash to the associate at your door.

For *Marcia Younge*, at Beterverwagting (BV).

Shall I place it?
   [ Book it ]  [ Change destination ]  [ Cancel ]
```

**What they are shown is what they will hand over.** Food and delivery added
up, because that is the number an argument at a gate is ever about — the
same reason a taxi is quoted its fare and not its mileage.

**The tap is the read-back answered.** The name and the address are on that
message, which is what `place_order` demands before it will accept an order,
and it is right to: an order placed against a name nobody checked is a bag
at the wrong door with only the shop's word for it.

**Change destination reopens the list and nothing else.** The basket is not
touched — somebody who balks at a total usually wants a different address,
not no dinner. **Cancel** leaves the basket where it is, to come back to.

**It books through `place_order`**, the same tool the agent uses, so the
stock, the reward points, the quote gate and the dispatch are one set of
rules rather than two. The only difference is who calls it: a tap on the
price rather than a model judging that the moment has come.

**A parcel goes through the same six steps**, with three differences that
matter. The agent still collects the two halves and the contents first — a
name and a telephone number are given in conversation and nowhere else — and
`start_delivery` refuses until it has them. The place, the pin and the street
belong to the **recipient**, so they are written to the parcel draft and
never to the customer, who is somewhere else entirely; a pin saved the wrong
way would quietly move where next week's groceries go. And the fee is
collected from the **sender** at the pickup, so the gate says so:

```
📦 A box of documents, about 2 kg
To *Ravi Persaud* at Lot 12 Second Street, the yellow house
*Delivery $1,800*, collected from you when it is picked up.

Shall I book it?
   [ Book it ]  [ Change destination ]  [ Cancel ]
```

It books through `create_parcel_job`, as a basket books through
`place_order`: one set of rules per kind of job, one sequence in front of
both. A parcel has no kitchen to confirm it either, so what the customer is
told is that it is booked and that an associate taking it is the next thing
that happens.

**A tap that arrives at the wrong step is never written down as an answer.**
A button from a message further back — `Nothing to add`, tapped while the
street was being asked for — used to become somebody's address, and the
associate was sent to a button id.

**When the shop cannot place what they typed, it shows them the list.** This
is the taxi's place picker, asked by another service: the same rows, the same
corridors, the same ways out — and priced from the delivery tariff, which is
the figure those rows have always carried. It is sent by the shop itself, not
by the agent, so it cannot be replaced by a third round of *"which area is
that?"*

```
them ▸ by the big mango tree

   Where are we delivering?
     ▸ Georgetown
     ▸ East Coast Demerara
     ▸ East Bank Demerara
     ▸ West Bank Demerara
     ▸ West Coast Demerara
     ▸ ✏️ Type the name      Quicker than scrolling — any spelling will do
     ▸ ⬅️ Main menu

   Which part of East Coast Demerara?
     ▸ Better Hope          $1,000
     ▸ La Bonne Intention   $1,000
     ▸ Plaisance            $1,000
     ▸ More places          45 more places, nearest first
```

**A tap is the agreement.** The charge is printed on the row they chose,
which is a plainer yes than any read-back in words — so the place and the fee
are settled together, and the gate that refuses to charge more than was
quoted is satisfied by the tap itself.

**Then the pin, straight away**, while they are still thinking about where
they are:

```
*Beterverwagting* — got it, delivery is $1,200. Send your exact spot on the
map and the associate will come straight to your door.
   [ 📍 Send location ]   [ Skip ]
```

Asked here rather than at checkout, which is where it was missed often enough
that `⚠️ NO PIN — ring before you set off` is on a great many associate cards.
Skip is an answer: the place and the charge stay settled and the street
address is taken in words.

**Two places of one name come as a list, not buttons.** A button title is cut
at twenty characters, and *Golden Grove East Coast* and *Golden Grove East
Bank* are the same word by then. A row gets twenty-four and a line under it,
so the price that tells them apart is on the screen beside the names that do
not:

```
There is more than one *golden grove*, and they are not the same price.
Which one?
   ▸ Golden Grove East Coast   $2,800 — East Coast far
   ▸ Golden Grove East Bank    $2,000 — East Bank
```

**One function settles a delivery place, whichever way it was chosen** —
`settleDeliveryPlace` in `delivery-place.ts`. A tapped row and a typed
address that was read back arrive at the same code, so they cannot drift
apart on price. It carries the rule that is easiest to get wrong twice: a
**parcel** is priced from both ends, and its zone belongs to the parcel
rather than to the customer, because a parcel goes where the customer is
not.

**Spelling is not what the customer is being asked about.** Names are matched
on how they sound, so all of these reach the same village:

```
Diamon · Dimond · Daimond          → Diamond
Pouderoyan · Powderoyen            → Pouderoyen
Freed en Hoop · Vreedenhoop        → Vreed-en-Hoop
Monrepos · Mon Repose              → Mon Repos
Hazlington · Haslinton             → Haslington
Fergenoegen · Vergenugen           → Vergenoegen
```

`v`, `w` and `f` are one sound; `oe`, `ou` and `oo` are all `u`; `ij`, `ei`
and `y` are `i`; doubled letters collapse and a trailing `e` is silent. So
*Vreed-en-Hoop* and *Freed en Hoop* are the same word — `fred en hup`.

**Three things it refuses to guess at.**

*A longer word is not a village.* `Diamondback Street` is not Diamond, because
matching is on whole words. Written as one word, though — `Vreedenhoop` — it
still lands, but only for names that have a space in them.

*The more specific village wins.* `Metin Meer Zorg` is spelled one letter off
Meten-Meer-Zorg and contains Meer Zorg perfectly — a different village $1,400
cheaper. A name accounting for more of what the customer wrote beats a
better-spelled shorter one, because a quietly cheap quote is the worst
outcome: nobody questions it.

*Two villages share a name.* Golden Grove is on the East Bank and the East
Coast, $800 apart, and Friendship likewise. The agent is given both with their
prices and has to ask.

**What the customer agreed is what the order is charged.** The zone is saved
against them by name, never as a figure, so a price changed in the tariff
reprices the next order rather than leaving one nobody charges. The order keeps
the zone it was charged under, so a month-old receipt still says where it
went:

```
Goods $3,200
Delivery Diamond $1,800
*Total $5,000* — paid in cash
```

**Free delivery is for groceries only, over $100,000.**

`FREE_DELIVERY_OVER` waives the charge on a basket off the shop's own
shelves, and on nothing else. A restaurant order is somebody else's food —
the kitchen keeps the margin and the delivery is the only thing the shop
earns on it, so giving that away on the biggest trips of the day is working
for nothing. A parcel and a taxi have no goods at all: their fee *is* the
job.

It is tested before the zone, so a basket over the threshold is free wherever
it is going. That is deliberate — at $100,000 the basket pays for the
distance.

**It also decides who earns reward points.** Points come off the delivery
charge, so a free delivery earns nothing. At $100,000 that is a rare enough
order not to matter; at the $10,000 this was set to before, every large
grocery order would have earned a customer nothing at all.

`/health` reports `deliveryZones` — how many places are priced. Zero means the
flat fee.


### The whole job on demand

`7 details` — everything about one delivery, from the record as it stands now.
A bare `details` does the same when they are carrying only one job, and the
listing-and-refusing is the same as `pin` above.

```
rider ▸ 1 details
      ◂ 📋 *GRO-00001* — on the way, booked about 20 minutes ago

        *Pick up:* A Taste of Guyana, Sheriff Street
        Click the link below for the pickup:
        https://www.google.com/maps?q=6.804200,-58.140900

        *Deliver to:* Ann Persaud
        Lot 8 Beterverwagting, blue gate
        Ring when you reach the corner
        📞 +5926105959
        Click the link below for the delivery address:
        https://www.google.com/maps?q=6.804200,-58.040900

        *Collect $6,100 cash* from the customer
        $4,900 goods + $1,200 delivery

        *What it is:*
        2 x Rice
        1 x Cooking oil
```

The job card is sent once, at the moment the job becomes theirs, and WhatsApp
then buries it. An associate three drops later who needs the customer's
telephone number has to scroll back past everything since — and the card they
find that way may be the one from **before** the address changed. This answers
at the bottom of the chat, where they are typing, from the record as it is now.

**Fuller than the card, because it was asked for.** The job card is read
one-handed at a gate and earns its brevity: it gives the split, not the item
prices, because the question at a door is *what is the delivery costing me*.
Somebody who stops and types `details` wants the lot, so this adds what is in
the bag — the line that answers "is the roti in there?" without ringing the
shop.

**A taxi's details are its trip**, and the two existing cards already say that
in the right words for each end of the journey: before the pickup, who to
collect, from where, and the safety code; once the passenger is aboard, where
they are going now and the fare — and *not* the code, which is spent. Asking
for details does not reprint it.

**A parcel's money is at the other end.** The sender pays at the uplift, so the
figure is printed in the uplift block rather than at the door, and once the
parcel is in the associate's hands it says it was paid rather than asking for
it again.

**Theirs, or nobody's.** A job somebody else is carrying is somebody else's
customer — their name, their number, their door — so it is refused by name:

```
rider ▸ 3 details
      ◂ GRO-00003 is out with Rider Two, so its details are not yours to read.

        Send `jobs` to see what you have and what is waiting.
```

A job on the waiting list that nobody has taken is fair to read: anybody on the
list may take it, and `jobs` already shows what is on it.
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

### Who thanks whom

**The shop thanks the customer, never the kitchen.** A restaurant order used
to close with *"Thank you for ordering from A Taste of Guyana Roti Shop &
Bakery!"* — the shop thanking somebody on a kitchen's behalf, for a
transaction the kitchen was not party to. The food is the kitchen's; the
order, the delivery and the whole conversation are the shop's.

| Kind | Thanks | Wish |
|---|---|---|
| Restaurant | Thank you for choosing Next Minute Delivery! | *Enjoy your meal! 🍽️* |
| Grocery | Thank you for shopping with us! | *Hope it's all just right! 😊* |
| Parcel | Thank you for choosing Next Minute Delivery! | *Thanks for trusting us with it. 📦* |
| Taxi | Thank you for choosing Next Minute Delivery! | *See you next time! 👋* |

**The wish is unchanged** and still belongs to what was actually delivered —
a meal is still wished over as a meal, and a grocery line never names the
shop it was packed in.

## 6. Delivery codes

Every order gets four digits. The customer receives them with the "on its way"
message and reads them out at the door.

**No operator message ever contains the code** — not the job card, not `jobs`,
not the shop's alert, not the export. A code the associate can read off their
own screen proves nothing.

A **taxi's safety code is a different thing in a different column**, and the
driver is meant to read that one out: it proves the car, not the passenger.
See [chapter 8](#8-taxis).

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

### Changing where it is going

A passenger can send a booked taxi somewhere else, whether the car is still
on its way to them or they are already in it. Ask in words — *"actually can we go to Zeelugt instead"* — and the
shop re-prices the trip from the same pickup and reads both figures back:

> Going to Zeelugt instead makes the fare $5,500 rather than $700.

Nothing changes until they agree the new figure, and the gate is the same
one booking has: the shop checks the fare against what it actually sent, not
against the agent's belief that it came up. Once agreed, the record changes,
the old destination and the old fare go into the trail rather than being
overwritten quietly, and **the driver is sent the card again** — they are on
the road holding one for the old destination, and a job that changed quietly
is a car that still goes to the wrong place.

| | |
|---|---|
| Before pickup | Changed here |
| **Onboard** | Changed here too, through the same gate. It used to be refused and sent to the help queue for somebody to ring back — which at a shop with no staff number set is a queue nobody reads, while the driver sitting beside them could do it in two taps. A passenger asking the shop is the same event as the driver asking on their behalf |
| The **pickup** | Not changed here either. Moving where a car collects from may mean a different driver, which is a different job |

A change the passenger makes themselves also spends any question the driver
has out: leaving it open would put the old place back in front of them with
two buttons, for a trip that has already changed.

### When the driver is the one who hears it

A passenger usually asks the person next to them, so the driver's card
carries `Change destination` once they are onboard. **The driver raises it;
the passenger settles it.**

```
Driver  ▸ [Change destination]
Shop    ▸ TXI-00001 — where are they going now?
Driver  ▸ Buxton
Shop    ▸ Asked them about *Buxton* — $3,100.
          Carry on to where you were going until they answer.

Passenger ▸ "Your driver says you are now going to *Buxton*. That makes
             the fare *$3,100* rather than *$700*."
             [Acknowledged]  [No, as booked]
```

Nothing on the trip moves while that sits unanswered: the place and the
figure are written down as a *proposal*, and only the passenger's tap applies
it. The driver is told either way, because they asked on the passenger's
behalf and are owed an answer — and a driver who thinks a change went
through drives somewhere else.

**Why not let the driver simply change it?** Because a driver who can change
the destination can change the fare, and the figure the passenger agreed is
the whole of what the shop can show if one is ever disputed. It is a cash
business with no card trail; that record is the dispute resolution. It would
also create an incentive that does not exist today — a destination the
driver can edit is a fare the driver can inflate, and points are earned on
the fare as well.

It cannot be raised before pickup: there is nobody in the car to have asked.

**The safety code is said once.** A destination that changed mid-trip
re-sent the whole pickup card, which repeats three things that have stopped
being true: that the job *is yours*, who to *collect* and from where, and the
safety code with instructions to say it before the passenger gets in. That
code is the one thing on the card checked against the passenger's own screen,
and a gate offered twice is a decoration. A driver carrying somebody gets
only what is still ahead of them:

```
⚠️ *TXI-00001 — the destination has changed.*

*Now taking Marcia to:* Buxton

*Fare $3,100* — the passenger has agreed this. Collect it from them.
⏱ *Waiting:* $30 a minute, from the first minute.
[Waiting]  [Change destination]  [Passenger arrived]
```

A driver still on the way to the pickup gets the card in full, code included
— they have not met the passenger yet, which is exactly when it is needed.

**The card stays under the driver's thumb the whole trip.** A WhatsApp reply
button is spent the moment it is tapped — the message keeps its words and
loses its buttons — so a driver who tapped `Change destination` and was then
answered in plain text had nothing left on screen to tap, and no way to ask
for a *second* change. Every message sent to a driver carrying somebody now
ends in the card for that moment:

| While the car is | At the bottom of their chat |
|---|---|
| Moving | `[Waiting]` `[Change destination]` `[Passenger arrived]` |
| Stopped, clock running | `[Moving]` — on its own, because everything else there is a way to end a trip without closing the clock, at $30 a minute of the driver's money |

Which also means the question *"where are they going now?"* can be answered
by tapping rather than typing: a tap on `Passenger arrived` stands the
question down and finishes the trip, instead of being written down as a
destination called `1 delivered`. A place that begins with a number is still
a place — `14 Delph Street` is an address, and only the card's own commands
are read as taps.

**While a trip is on the road, naming a place changes it.** It does not
start another. `book_taxi` clears the picker the moment it books, so
*"actually, Buxton"* looked identical to somebody beginning a fresh
booking — Buxton was taken as the PICKUP of a trip that did not exist, asked
for its exact spot in the pickup's own words, and then asked where they were
going. They had already said; they were changing it. So the picker stands
down while a taxi is live, and the agent is told which trip is running and
which tool changes it.

Until this existed, nothing could amend a booked order for any service. The
only route was `cancel_my_order`, which works while a job is still
`pending` — for a taxi that is the seconds before a driver accepts.

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

### What a parcel costs

**Priced from both ends, once the destination has been agreed.**

The tariff prices one journey — out of Georgetown — which is the right answer
for a delivery, because the shop is always at one end of it. A parcel is a
two-ended job the same table can only half-describe. Priced by its
destination alone, a parcel collected in Parika and dropped in Diamond cost
what a Diamond delivery costs, and nobody was paid for the seventy kilometres
between.

| | Same road | Different roads |
|---|---|---|
| **Fare** | the difference between the two bands | the sum — in to town and back out |

The bridge is charged **once**: two places already across the river are
priced from the crossing, not through it.

| Parcel | Destination only | Both ends |
|---|---|---|
| Georgetown → Diamond | $1,800 | **$1,800** — identical |
| Parika → Vergenoegen | $4,500 | **$1,000** — same coast, ten minutes |
| Parika → Diamond | $1,800 | **$6,300** — 70 km |
| Vreed-en-Hoop → Parika | $5,000 | **$3,000** — the bridge, once |
| Parika → Georgetown | $500 | **$5,000** — a long trip for a town fare |

**It reduces to the old figure whenever the pickup is in town**, which is most
parcels. This is the same tariff asked a better question, not a second set of
prices.

**The destination must still be agreed first.** A zone is a price, and the
only thing that may set one is the customer saying yes to the place read back
to them — "Golden Grove" is two villages $800 apart. The pickup end is added
on top of that agreed destination, never instead of it. Where the tariff does
not recognise the pickup, the destination's own fee stands, exactly as before.

**Deliveries and taxis are untouched.** A delivery has the shop at one end, so
one number describes it. A taxi is quoted no fare at all: the driver agrees it
with the passenger.

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

## 8. Taxis

A car for a person, booked and dispatched exactly like a parcel — **the
delivery associates drive these**. There is no catalogue, no cart and no
kitchen, so the associate who takes the job is the one who confirms it.

It needs **two ends and a passenger**. Each end can be a **location pin, an
address in words, or both**: somebody standing on a road waiting for a car can
usually drop a pin on where they are, and nobody can drop one on where they
are going until they get there.

### Picking the two ends

Each end is asked with a **place picker** — a tappable list built from the
delivery tariff. **No pin is offered on a taxi**; see below for why.

```
Where are we collecting you from?          [ Choose a place ]
Just type it — Diamond, Beterverwagting, BV. Or tap below to browse.

  Diamond                  Your saved address
  Providence               You have used this before
  Georgetown
  East Bank Demerara
  East Coast Demerara
  West Bank Demerara
  West Coast Demerara
  ✏️ Type the address      If your place is not on this list
  ⬅️ Main menu
```

Tapping a corridor opens the places on it. On the **destination** list each
row carries its own fare, worked out from the pickup already chosen, cheapest
first:

```
Which part of East Bank Demerara?          [ Choose a place ]

  Farm                     $500
  Great Diamond            $500
  Little Diamond           $500
  Barnwell                 $700
  Covent Garden            $700
  Golden Grove East Bank   $700
  Grove                    $700
  More…
  ✏️ Type the address
  ⬅️ Main menu
```

Four rows end **every** screen of the picker and are never paged away: the
pin, `More places` where there is more, `Type the address`, and a way back.
That is why a page holds six places — ten rows, less those four.

The pin costs a page on the longer corridors: the East Coast runs to nine
rather than eight. That is the trade, and it is the right way round —
somebody whose destination has no name in the tariff can now say where it is
from any screen, instead of having to find their way back to the areas
first.

**Which way back depends on where you are.** On the first screen of each end
there is nowhere back to go, so the row is `Main menu`: it drops the trip and
returns to the services, because a pickup left on file would have the next
taxi start wherever this one was going to. Inside a corridor the useful move
is one step rather than all the way out, so the row is `Back to the areas` —
picking the wrong road then costs a tap to undo instead of the whole booking,
the end being chosen starts again, the other end stays exactly where it was,
and the front door is still one tap further on.

**Each of those rows says what it is for**, because a row nobody understands
is a row nobody taps:

```
  More places              45 more places, nearest first
  ✏️ Type the address      If your place is not on this list
  ⬅️ Main menu
```

The count on `More places` matters most. The East Coast runs to **eight
pages**, and `More…` on its own told a passenger nothing — somebody heading
for Belfield tapped it five times without ever learning that was what they
were in for. The number falls page by page (45, then 38, then 10) and is
deliberately honest about the length: seeing "45 more places" is what tells
somebody going far out to type the address instead.

A page that has more behind it also carries one line under the question, and
that line is the most valuable thing on the screen — it shows in the chat
**before** anybody opens the list. What it says depends on which end is being
asked about:

| Page | The line |
|---|---|
| Destination | *Nearest first. Tap More places, or just type the name — that is quicker.* |
| Pickup | *Do not scroll for it — just type the name of the place and I will find it.* |

The difference is honesty. On a destination page the fare does the sorting
and nearest-first is true. On a pickup page nothing is priced, so the sort
ties and falls through to the alphabet — page one of Georgetown is
Alberttown, Albouystown and four Bel Airs, which is neither nearest nor
useful. Claiming an order the list does not have sends somebody scrolling for
a page that will never come.

**And the line that says so is OUTSIDE the list.** `✏️ Type the name` had
always been on this screen — as a row, inside the list, which is exactly
where somebody deciding whether to open the list cannot read it. All a
customer saw was a question and a green button, so the only visible way to
answer a question they could answer in one word was to open a list and scroll
it. The line under the question shows in the chat itself:

> Where are we delivering?
> *Just type it — Diamond, Beterverwagting, BV. Or tap below to browse.*

The examples are doing work too. They say what counts as a place here, and
one of them is `BV` — which the tariff has understood since the aliases went
in, and which nobody would have guessed.

**Typing is the search box.** `✏️ Type the name` reads *"Quicker than
scrolling — any spelling will do"*, because it is: the matcher forgives a
misspelling and a swapped pair of letters, so *medow bank* and *zeelught*
both land. Meadow Bank is four taps down the Georgetown list and one short
message away. It was labelled "if your place is not on this list", which made
it sound like a fallback for when the shop fails, so nobody used it.

The last page has neither the More row nor the line, there being nothing left
to explain.




**A list the shop queues is the message.** `assembleReply` had branches for
buttons, photos, location requests and prose — and none for a list. So when
the agent handed checkout over with `start_delivery`, the *"Where are we
delivering?"* screen it queued was dropped on the floor, every time, and the
customer was left with whatever courtesy line the model had added:

> Checkout is open for you.

and nothing to tap. Worse when the model obeyed its instruction to say
nothing at all — the turn then had no content, and fell through to *"Sorry, I
lost my train of thought there"*: the shop apologising for a screen it had
just thrown away. Tapping **✅ Check out** in groceries never showed it,
because that path goes straight through the shop and never through the agent.



### The tariff decides where the shop delivers

Two rules used to answer that question and they disagreed. The **tariff**
prices 185 villages; the **delivery radius** refuses anything past its circle.
**45 of those 185 sit beyond 15 km** — Foulis at 16.7 km for $2,000, Hope at
17 km for $2,800, Mahaicony at 45 km for $5,000. So a customer in Hope was
quoted a figure, filled a basket, and was refused at the last tap for living
in a village the shop had deliberately priced.

**A place in the tariff is a place somebody decided to serve, at a figure
they worked out. That outranks a circle drawn round the shop.** So:

| The pin is | What decides |
|---|---|
| In or near a priced village | **The tariff.** Accepted, however far out |
| In no priced village | **The radius.** Refused if it is outside, as before |

"Near" uses the same tolerance as the pin check, and for the same reason: a
village's coordinate is a single point, not a boundary.

**The warning follows the same rule.** `⚠️ OUTSIDE the 15 km delivery area`
used to print on the associate's card, the staff alert and the open-orders
queue for a third of the shop's own orders, which is how a warning stops
being read. It now appears only where the tariff has nothing to say, and says
so: *"and in no village we price"*.

**The associate is asked before riding to a job that does not add up.** Two
things earn the question, and the second is the one that actually happens:

*Outside the area*, which needs a radius to be configured at all. Most shops
never set one and this shop has not, so that branch is silent here.

*Not where the order says* — the pin disagrees with the village the delivery
was priced for. That one needs no radius, and it is how a job 16 km from its
own village reaches somebody with Accept on it:

```
⚠️ *GRO-00042* is priced for *Mocha*, but the pin is 16.6 km away,
nearer *Uitvlugt*.

Ring them before you set off, or leave it and the shop will sort it out.

   [ Take it anyway ]  [ Leave it ]
```

Taking a job whose door is in no priced village puts the other question:

```
⚠️ *GRO-00042* is 94 km from the shop, past the 15 km area, and in no
village we price (nearest is Timehri, 31 km off).

Nobody has to take this one. Say so and the shop will sort it out.

   [ Take it anyway ]  [ Leave it ]
```

*Leave it* leaves the job where it is. *Take it anyway* records that they were
told, and nobody is asked twice about the same job.

`/health` reports `serviceArea` beside `placesLocated`, because the first
question when two rules disagree is what each of them actually says.

### Is the pin where they said it was

A pin is specific, confident, and opens a maps app — which is what makes a
wrong one worse than none: the associate drives to it. Shawn's order was
priced for **Mocha** and carried a pin 22 km away in **Uitvlugt**, and nothing
between the tap and the door had anything to say about it.

Two ways of noticing, in order of certainty.

**The label.** WhatsApp attaches a place name to a location searched for in
its own picker, and Shawn's said it in as many words:

> VMGW+PR7, Estate Rd, **Uitvlugt**, Guyana

Where that names a priced place which is not the one chosen, that is the
answer — no geometry, no tolerance, no argument.

**The distance**, where the chosen place has a confident coordinate.
`data/zone-coordinates-review.csv` and `data/places-found.csv` between them
place **151 of the 185** priced places; `/health` reports the figure as
`placesLocated`. The other 34 are not checkable and the shop says nothing
about them, because a false accusation about somebody's own address is worse
than no check.

**The tolerance is deliberately wide — 8 km.** These villages sit 600 metres
apart at the median and 1.7 km at the ninetieth percentile; Beterverwagting
to Triumph is 1.3 km, and a house on that boundary pins whichever side it
likes. Anything tighter accuses the honest constantly, and a warning that
cries wolf is a warning nobody reads. At 8 km it catches the wrong corridor
and the wrong side of the river, which is the mistake that actually happens.
`PIN_TOLERANCE_KM` changes it; `0` switches the whole check off.

**It has one answer, and the answer is a better pin.**

```
That spot is 22.4 km from *Mocha* — it is in *Uitvlugt*.
The delivery is priced for Mocha.

Tap below and send the spot at *Mocha*. No map? Reply *skip*
and tell me the street instead.

   [ 📍 Send location ]
```

There used to be a second button saying the spot was right. It was the wrong
thing to offer: the shop is not asking for a preference, it is saying the map
does not agree with the village — and the tap that waves that away costs
somebody else a ride across the country. A customer who really does live past
the village line still has a way through, and it is not a claim about a pin:
the street, in words.

The request is WhatsApp's own, so the one answer is one tap to the map.

**Twice, on a job already out.** Nothing is committed during checkout, so a
customer who keeps sending the same spot costs only their own patience and
the way out is printed in the message. Once an associate is carrying it,
somebody is waiting on the answer: the question is put twice, and the third
pin is taken as it stands, with the card telling them to ring.

**And the associate is told, since they are the one who drives there:**

```
⚠️ pin is 22 km from Mocha, nearer Uitvlugt — check before you set off
```

**The customer is asked too, whenever the pin arrives late.** The question at
checkout only covers a pin sent during checkout. A pin that arrives
afterwards — from `7 pin`, or for an address changed on the road — used to go
onto the job with nobody asked anything, and the only mention of it was a
warning on the associate's card:

```
⚠️ pin is 9.3 km from Plaisance, nearer Meadow Bank — check before you set off
```

Now the same fact goes to the person who can actually fix it:

```
them ◂ Got it — your associate has the new spot on their map.

     ◂ That spot looks 9.3 km from *Plaisance* — it is nearer *Meadow Bank*.
       The delivery is priced for Plaisance. Is it right?
       [ Yes, that is right ]  [ Send it again ]
```

**The associate gets it either way, first.** They asked for it and are
standing at a door; holding a pin back to ask its sender whether they meant
it helps nobody. The question follows in the same breath, and a better pin
replaces the first one on their card.

**Before the associate is troubled at all, where there is time.** A pin for an
address being *proposed* is checked before the proposal goes out — nobody is
standing anywhere yet, so the cheapest moment to catch it is then.

**And if they skip the question, the query travels with the pin.** Answering
`skip` sends the proposal anyway, refused pin and all, so the person about to
agree to carry a bag there sees what the shop already asked about — *before*
they tap, not after:

```
⚠️ *GRO-00001 — the customer wants it taken somewhere else.*

Now: *Buxton*
Was: Lot 4 Diamond
Click the link below for the new address:
https://www.google.com/maps?q=6.874660,-58.307050
⚠️ That pin is 32.3 km from Buxton, in Uitvlugt — we asked them about it.

Nothing has changed yet. Tap *Acknowledged* only if you can take it there.
   [ Acknowledged ]  [ No, as booked ]
```

A pin that agrees says nothing extra. A warning on every proposal is a
warning nobody reads.

**"Send it again" clears nothing.** The next pin overwrites it; deleting the
one on file would leave somebody already driving with less than they had.


**What it cannot do.** It compares the pin to the **village**, never to the
street. *Lot 12 Mocha Scheme* with a pin three hundred metres away in Mocha is
indistinguishable from a perfect pin, and it does not pretend otherwise. It is
also a different question from the one `place_order` asks, which measures the
pin against the **shop's** delivery radius.

### One tap to the map

The exact spot used to be asked for with two reply buttons — `📍 Send
location` and `Skip` — and tapping the first did not open anything. A reply
button cannot: all it can do is send its id back. So the shop answered with
WhatsApp's **real** location request, and that button opened the map. Two
taps for one answer, the second looking like the same question asked twice.

A delivery now asks for the map directly:

```
*Mocha* — got it, delivery is $1,600. Tap below to send your exact spot and
the associate will come straight to your door. No map? Reply *skip* — or
type anything they should know (a gate, a floor, a landmark).

   [ 📍 Send location ]   ← opens the map picker itself
```

**The price of the native request is that it carries exactly one button** —
its own, with a label Meta chooses — so `Skip` cannot sit beside it. Skip is
a word now, in all four languages, and the checkout reads it as the tap it
stands for. Only the bare word: *"skip the rice"* is a sentence about
shopping and *"no onions please"* is a doorstep note.

**A taxi keeps its two buttons.** Its pickup and destination asks are not
inside the checkout sequence, so nothing there reads a typed `skip` yet — and
a passenger who cannot pin a street corner must not be left holding a map
request with no way past it.

### What a note is not

Typing at the pin question is a doorstep note, and a note is **not a door**.
It used to go straight to the price:

```
Mocha — got it, delivery is $1,600. Tap below…
▸ a gate on the left
1 x Rice — $1,850 … Total $3,450          ← the price, with no address at all
▸ (taps Book it)
Something went wrong placing that, and nothing has been ordered.
```

`place_order` refused it, correctly — *neither a pin nor a written address* —
but at the last tap, after the whole sequence had been answered. The note is
still kept; the street is now asked for as well, while they are still
answering questions.

And **`skip` is never saved as an address.** Typed where the street was
asked for, it used to be written down verbatim and kept on the customer's
record afterwards. The question is simply put again.

### A saved door is only a door for the place it is in

A customer's saved address and pin are **home**. They answer *"where does
this go?"* only when the order is going home — and the moment it is not, they
are worse than nothing, because they are specific, confident and wrong.

Shawn had a street saved at `4 Water St, Georgetown` and a pin dropped months
earlier in Uitvlugt. He ordered to **Mocha** and tapped Skip. The shop decided
it already had his door and put all three places on one card:

```
5 x Cheese Roll — $1,500
Delivery to Mocha — $1,600
*Total $3,100*, cash to the associate at your door.

For *Shawn. Harry*, at 4 Water St, Georgetown
(VMGW+PR7, Estate Rd, Uitvlugt, Guyana).
```

A Georgetown address, a Uitvlugt plus-code, a Mocha price. Had he tapped
*Book it*, the associate's card would have carried the Georgetown street with
a map link to Uitvlugt — and the radius check would have measured the trip at
46 km and refused the order outright, for a delivery to a village 12 km away.

**Skip means "I have nothing to add", not "use whatever you have, from
wherever".** So each saved door now records the place it belongs to, and is
only offered for that place:

```
rider ▸ (taps Skip)
      ◂ What is the street address at Mocha? Lot number and road,
        so they come to the right door.
```

and the gate says what it does not have, rather than filling the silence:

```
For *Shawn. Harry*, at Lot 12 Mocha Scheme, the yellow house.
No exact spot sent — your associate will ring when they are close.
```

**The pin and the address are recorded separately**, because they travel
apart: Shawn's street became a Mocha street the moment he answered, while his
pin was still in Uitvlugt. One column covering both would have promoted that
pin to a Mocha door on the strength of an answer about something else.

**Ordering home costs nothing extra.** Anyone whose saved street names the
village they just chose goes straight to the price, exactly as before — which
is what that shortcut was always for.

**An unrecorded pin is not trusted for a place the written address cannot
vouch for.** Pins saved before this was recorded have no village attached, and
a pin carries no address of its own, so there is nothing to read it against.
One extra question beats one delivery to the wrong village.

### The exact spot

Once an end is settled **by name**, the shop asks for the pin — and only
then:

```
*Diamond* — got it. If you are there now, send your exact location
and the driver will come straight to you.

[📍 Send location]  [Skip]
```

**A typed place answers exactly as a tapped one does** — it settles the end,
gets the same offer of the exact spot, and is passed to the agent the same
way. For a while only a tap did that, so anybody who typed their destination
was never asked for its pin, and nor was anybody who typed their pickup.

**And an address the tariff has never heard of still answers.** Tapping
`✏️ Type the name` arms a one-shot marker, so the next thing sent is taken
as that end whatever it says: *"Lot 5 Public Road, behind the market"* is a
perfectly good pickup. A name the tariff does know is stored as the tariff
spells it, so the trip prices; anything else is stored as written and the
driver agrees the fare in the car. Either way the exact spot is offered
next — which is the whole point of taking an address the shop cannot place.

A destination list shown against an unpriceable pickup quotes nothing, since
a column of "fare agreed with the driver" down every row says less than no
column at all.

Without the marker, typed text is only read as a place while an end is still
missing, when the message is short enough to be an answer, and when the
tariff is sure which place it means. Once both ends are known, *"2 of us"* is
an answer to a different question and goes to the agent untouched.

**The name prices the trip; the pin finds the door.** Asked in this order the
two never collide: the fare is already known when the pin arrives, so a pin
can neither price a trip nor fail to. It refines the end that was just
settled and nothing else — it does not change the place, the fare, or the
customer's saved address, since where somebody is standing today is not where
they live.

Both ends are asked. The pickup, because a passenger standing in a road can
give the driver a gate instead of a village and Diamond is a large place. The
destination, because somebody who knows the exact spot can save the driver
hunting for it at the far end.

**Declining is a real answer**, and it is there for a reason: somebody
booking a car for later this afternoon has nothing useful to send and should
not be made to pretend otherwise. `Skip` carries the booking straight on to
the next question.

The label says `Skip` and not a reason. *"I'm not there yet"* and *"Not now"*
were both tried on paper and both fail the same test: a button should name
the ACTION, not guess the motive. A passenger standing right at the kerb who
simply does not want to share a pin cannot honestly tap "I'm not there yet",
and a button some customers cannot truthfully press is a button that stops
the booking. `Skip` is true whatever the reason, and reads the same at both
ends.

This was tried the other way round first — a pin offered INSTEAD of a place.
It could not work: the tariff is place names with no coordinates in it, so a
pin that happened to name somewhere priced itself and a live position, which
WhatsApp sends nameless, had to be followed by "which area is it in?". Half
the pins a passenger could send settled an end and half did not, which is a
shop behaving two ways for one gesture.

**The picker prices the trip; it does not find the door.** A village name
sets the fare and says nothing about which gate, so the pin and the typed
address are still how a driver is told where to stop — the picker replaces the
*pricing* question only. `Type the address` and, for a pickup, `Where I am
now` are on **every** screen and are never paged away: somebody going
somewhere the tariff has never heard of must still be able to book a car.

**`Type the address` voids the choice for that end.** Tapping it means *none
of these*, so whatever was picked there is cleared and the agent is told in
as many words that any place named earlier for that end is now wrong.
Without that, a passenger who picked Timehri, thought better of it and tapped
to type was asked *"whereabouts in Timehri are you going?"* — the choice was
still on file and still in the history the model reads, and `book_taxi` falls
back to the stored place, so the trip could have been booked to the village
they had just rejected. The other end is left alone.

**A pickup list quotes nothing.** Half the journey is unknown at that point,
so there is no fare to show. It used to show the tariff's own figure — what
a DELIVERY to that place costs — and a passenger choosing where to be
collected from read "Diamond $1,800" as the cost of their trip. The figure is
still used, but only to order the list by distance from town.

A typed place is matched on sound, not spelling, and forgiven **one letter
per seven of each word** — counted so that a swapped pair of letters costs one,
not two, because that is the commonest slip anybody makes. A name mistyped
further than that goes unmatched and the agent asks, which is the right way
round for a fare: a question costs a message, a wrong village costs the
difference and nobody notices until the car arrives. *Mahdia* is not *Mahaica*.

**The names people actually use are in the tariff.** Nobody asks for a car to
Beterverwagting; they ask for **BV**. Nobody says Georgetown; they say **GT**.
The tariff had never heard of either, so the lookup came back empty and the
passenger was asked again for a place they had already named correctly — the
gazetteer those places were geocoded against lists what is on a map, not what
is in a mouth.

| What they type | What happens |
|---|---|
| `BV`, `bv`, `B.V.` | Beterverwagting. On its own the short form **is** the place, so the trip is written down under the name |
| `GT` | Georgetown, the same way |
| `Lot 8 BV` | Priced as Beterverwagting, **written down as `Lot 8 BV`** — that is where the driver goes; the village is only how it is priced |

The list lives in `ALIASES` in `zones.ts` and grows only on the word of
somebody who lives there. A wrong alias is a car sent to the wrong village,
and nothing downstream would question it.

**What is matched is also what gets written down.** The matcher could always
*price* a misspelling — `Bagotvile` is Bagotville and costs what Bagotville
costs — but the typing was what went into the record, onto the driver's card
and into the question put to the passenger, who was then asked to agree to a
place that does not exist at a figure they could not check against anything.
A trip is now booked, repriced and read back under the tariff's own spelling,
and whoever typed it is told what it was read as, so a wrong guess is caught
by the person who knows the answer.

Only a **spelling** match is rewritten. The other way a lookup succeeds is by
containing the place — `14 Delph Street, Campbellville` finds Campbellville —
and rewriting that would throw away the street and leave a driver with a
village to search. The zone is how a trip is *priced*; the address is where
the driver goes.

Ordering is by fare from the chosen pickup, which is nearest-first in the only
sense a passenger cares about and needs no trading history to be right. From
Diamond that puts Farm and Great Diamond on page one; ordering by distance
from town would have given Agricola and McDoom.

The last page has no `More…` and so may show eight; the offsets still step by
seven, which is why a short final page never repeats the one before it.

The picker is read in `place-picker.ts` **before the agent runs**, for the
same reason the service menu is fixed text: a tapped row is already structured
data, and passing it through a language model only adds a chance of a
different village coming back. Only a finished choice reaches the agent, as a
note naming both places and the fare.

It appears only where there is a tariff to pick from. A shop on the flat fee
has no places to list, and gets the old typed question instead.

### What the agent is told it already has

The picker answers its own taps. A passenger choosing Meadow Bank off a list
and then being asked for the exact spot has had three or four exchanges with
the **shop** and none with the agent — those turns never reach the agent, so
they are not in its history.

So the moment anything hands over — a typed address, a question, an "ok" —
the agent would pick up a conversation whose first half it had no record of,
and ask where they were going when they had said so two taps earlier. From
its own account, the booking had just begun.

**The greeting is a guard, not an instruction.** Once a conversation has
turns in it, the agent is no longer told to greet — it is told plainly not
to — and if it greets anyway the opening sentence is taken off the reply
before it is sent. The whole sentence, not just the hello: stopping at the
comma in *"Good evening, Shawn."* would leave the customer reading *"Shawn.
I can get a car to you"*, which is worse than the greeting was. The capital
goes back on what is left. A reply that is nothing but a greeting survives
untouched, since an empty message is worse than a stray hello.

**The turns the shop answered are written into the agent's account.** A tap
is recorded as the words the passenger saw — `Zeelugt`, not
`pick:to:place:Zeelugt` — with the shop's reply beside it, in the same shape
the agent's own turns are stored in. Without that, six taps into a booking
with the destination already chosen, the agent said *"Good evening, Shawn"*
and offered to settle the pickup: it was opening an empty conversation,
because as far as its history went the conversation was empty.

And every turn carries a line saying what the shop actually holds:

> This taxi already has its pickup *Meadow Bank*, destination *Zeelugt*,
> chosen off the place picker — treat that as said and do not ask for it
> again. The tariff prices the trip at $4,200; book_taxi quotes it properly.

The same correction `openJobsLine` makes for finished orders, and for the
same reason: an agent answering from a stale account is not being stubborn,
it is answering from the only account it has.

The standing taxi brief was corrected to match the shop it describes. It
said **"never quote a fare: the driver agrees it with the passenger"** —
true when a taxi had no tariff, and flatly contradicting `book_taxi`, which
had been quoting one beside it ever since.

### The fare, and the three answers to it

Once both ends are known the fare goes out as **three buttons**, which is
exactly WhatsApp's limit:

```
Your fare is *$700*, payable to the driver. Waiting after pickup is
charged separately.

[Book it]  [Change destination]  [Cancel]
```

**The passenger is not asked whether the fare is all right.** That question
has two answers and the commonest one is neither of them: somebody who balks
at a figure usually wants a different destination, not no taxi. Asked as a
yes/no, they have to type their way back to a list they have already used.

| Tap | What happens |
|---|---|
| **Book it** | The car is dispatched. The agent is told the fare is settled, so it neither quotes it again nor asks |
| **Change destination** | The destination list reopens, priced from the same pickup. **The pickup is kept** — they have not moved |
| **Cancel** | Both ends and both pins are let go, the service is cleared, and the next message starts fresh |

The buttons are sent **by `book_taxi` itself**, not written by the agent, so a
fare cannot be quoted without its answers attached and cannot be skipped by a
turn that forgets to ask. What each button means travels in its **id**, never
its title: the titles are words in whatever language the passenger writes, and
matching on those would be matching on a translation.

**The gate is the shop's record, not the model's word for it.** `book_taxi`
takes a `fare_confirmed` flag, and a flag is a field the model fills in — after
a long exchange about where somebody is going, it will set it believing the
figure came up somewhere. So the shop writes down the fare it actually sent
(`customers.taxi_fare_shown`) and checks the claim against it:

| Quoted now | Shown earlier | What happens |
|---|---|---|
| $700 | $700 | Booked. The confirmation repeats the figure |
| $700 | nothing | The fare goes out again. Nothing is dispatched |
| $700 | $900 — the trip changed | The new fare goes out again |

This is why it matters: the booking confirmation used to report the fare as
*"to be agreed with the driver"* and tell the agent not to mention one — true
when a taxi had no tariff, wrong since it got one. Combined with a skippable
quote, a priced trip could reach the road **without any figure ever reaching
the passenger**. Both halves are closed: the quote cannot be skipped, and the
confirmation repeats the agreed fare.

Where the tariff genuinely cannot price a trip there is still no figure, and
the shop says so plainly rather than inventing one — the driver agrees it.

### The journey

| Step | Who | What the passenger is told |
|---|---|---|
| Booked | The agent, once the fare is agreed | The job number, and that a car is being found |
| Accepted | **An associate**, tapping Accept | *A driver is on the way to collect you*, with the safety code |
| **Passenger onboard** | The associate, when they are in the car | *You are on your way*, with the fare |
| **Passenger arrived** | The associate, at the destination | *Trip complete — you have arrived* |
| Nobody there | The associate, at the pickup | *The driver could not find you* |

### From accepting to boarding

**Accepting puts the driver on the road, not at the kerb**, so the card
offers only what can happen while driving there:

```
[Arrived at pickup]  [Passenger cancelled]
```

Tapping *Arrived at pickup* records the minute, tells the passenger their car
is outside, and changes the card to the three things that can happen now:

```
🚕 *TXI-00019* — at the pickup, 20:05.
Say the safety code to Marcia before they get in.

[Passenger onboard]  [Passenger not found]  [Passenger cancelled]
```

The passenger gets:

```
Your driver is outside 🚕 They will say your safety code *6938* before you get in.
```

A car at a kerb that nobody has mentioned is a car the passenger does not know
is theirs — and this is the minute before they get in, which is the minute the
code is for.

**"Arrived" means two different things on a taxi, and the status tells them
apart.** At the kerb it means *I am here*; with somebody in the car it ends
the trip. The driver types the same word for the same thing they just did,
and tapping the arrival twice does not move the time it was recorded.

| Tap | What it records | What the passenger is told |
|---|---|---|
| **Passenger onboard** | the trip is under way | *You are on your way*, with the fare |
| **Passenger not found** | **returned**, nobody there | *The driver could not find you at the pickup* |
| **Passenger cancelled** | **cancelled**, their decision | *Trip X has been cancelled: you asked us to* |

**Not found and cancelled are different events and stay that way.** One is
somebody who did not come; the other is somebody who changed their mind. Told
apart, the shop can see which passengers waste trips; rolled together, it
cannot.

**A driver cannot cancel anything else, anywhere.** That rule is right — an
associate at a door with food in their hand must not be able to void an
order. A taxi before pickup is the one case with nothing in anybody's hands,
and once the passenger is in the car it is refused again:

> TXI-00019 is under way with the passenger in the car. Finish the trip, or
> ring the shop.

**Once the passenger is aboard, the card drops the pin warning and the
telephone number.** Both exist to find somebody who is not with you, and the
passenger is sitting in the car — "⚠️ No pin — ring +592…" would be telling a
driver to telephone the person beside them. What it says instead is the one
thing still unknown:

```
🚕 *TXI-00019* — passenger onboard
*Take to:* 14 Delph Street, Campbellville
```

A delivery keeps both, because its customer is at the far end.

**A taxi uses its own words.** The buttons read **Passenger onboard** and
**Passenger arrived**, never *Uplifted* and *Delivered* — one is what you do
to a parcel and the other is what happens to one. Typed, `onboard`, `aboard`
and `arrived` all work, and the status underneath is the same `on_the_way`
and `delivered` every other job uses, so nothing downstream has to know.

**`arrived` is a taxi word only.** A delivery associate typing it means they
have reached the kitchen, and reading that as a completed delivery would
close an order whose food is still on the counter.

### The receipt

A trip the shop priced ends with a receipt, like any other order — and the
points for it are printed on the receipt rather than sent separately, because
a passenger standing on a pavement should get one thing to read:

```
Trip TXI-00019 complete — you have arrived. 🚕

🧾 *Receipt* — 19 Nov, 18:51
🚕 Trip: Stabroek Market → 14 Delph Street, Campbellville

Fare $500
Waiting 20 min $800
*Total $1,300* — paid in cash

You earned *50 points* on this trip.

Thank you for choosing Next Minute Delivery!
See you next time! 👋
```

Then the rating list, as every delivery gets:

```
How was the trip, Marcia?
              [ Rate this trip ▾ ]
```

**Points come off the whole trip** — the fare and the waiting together, at
the same rate as a delivery charge: $10 is a point. A $500 fare with $800 of
waiting is a $1,300 trip and earns 130, which is the total printed on the
receipt the passenger is holding.

**A trip the tariff could not price gets no receipt.** There is no fare to
print, the driver settled it in the car, and `*Total $0* — paid in cash`
after a journey somebody has just paid for is worse than silence.

### The safety code

**Four digits, and they run the opposite way to a delivery code.**

A delivery code travels customer → associate and proves the person at the door
is the one who ordered. A taxi's travels **driver → passenger** and proves the
car at the kerb is the one the shop sent.

| | |
|---|---|
| Issued | When the trip is booked |
| On the driver's card | When they accept it — with the passenger's name and number |
| In the passenger's chat | The same moment, with the news that a car is coming |
| Checked | **At the kerb. The driver says it; the passenger checks it before getting in** |

The passenger is told plainly: if the driver says anything else, do not get
into the car, message us. Nothing is typed back and nothing is verified by the
shop — the check happens between two people standing in a road, which is the
only place it can happen.

A job **handed to another associate carries the code with it**, or the new
driver pulls up knowing nothing and the passenger rightly refuses to get in.

The digits live in their own column, not the delivery code's. Sharing one
would have put a number the driver must read out into every branch written to
keep numbers away from them.

**A taxi has no delivery code.** A passenger is not handed over against four
digits; they get out of the car. The Delivered button closes the job.

**Nobody there is reported from the pickup**, before anyone is in the car —
which is the one place it differs from a parcel, where nothing can come back
until it has been collected.

### Waiting

**$30 a minute, from the first, once the passenger is in the car.**

Waiting is the car stopped at the passenger's request — the pharmacy, a gate,
somebody running in for five minutes — not the time before pickup. Whole
minutes only, **rounded down**: the part-minute goes to the passenger, who is
not the one doing the tapping.

| Waited in total | Charge |
|---|---|
| 1 min | $30 |
| 12 min | $360 |
| 20 min | $600 |
| 45 min | $1,350 |

It was half-hour blocks to begin with, which is easy to apply at a kerb and
wrong at both ends of the scale: a two-minute stop cost the same $800 as a
thirty-minute one, and the thirty-first minute doubled the bill.

**Two taps, no numbers.** The driver taps *Waiting* when the car stops and
*Moving* when it goes again; the shop times it. While a stop is open, *Moving*
is the only button on the card — anything else would be a way to end the trip
with the clock still running.

```
Wayne ▸ 19 waiting
Wayne ◂ ⏱ Waiting from 18:26. Tap when you move off.
        ⏱ *Waiting:* $30 a minute, from the first minute.

Wayne ▸ 19 moving
Wayne ◂ ⏱ 12 min waited, 12 in total — *$360* so far.
```

**Totalled across the trip.** Twelve minutes at the pharmacy and eight at a
gate is twenty minutes — $600, however it was split.

```
Wayne ◂ TXI-00019 → *passenger arrived*.
        ⏱ Waited 20 min in total — *$600* to add to the fare.
```

**A forgotten clock is closed at the drop.** A trip cannot end with one still
running: the drop is when the car stopped being theirs to wait in.

**Rounded down**, each stop. The figure decides money, so a driver tapping a
few seconds late should not cost the passenger a minute.

**The passenger is told none of this.** The shop sets no fare, so it must not
publish half of one — the driver states the waiting rate when the fare is
agreed. Nothing is charged before pickup, and waiting is refused on a trip
that has not started.

### The fare

**Priced from the same tariff as everything else**, both ends, so a taxi from
Georgetown to Farm costs the $1,800 a delivery to Farm costs, and Diamond to
Mon Repos costs the $2,500 that going into town and back out costs.

| Trip | Fare |
|---|---|
| Stabroek → Kitty | $500 |
| Georgetown → Farm | $1,800 |
| Diamond → Mon Repos | $2,500 |
| Georgetown → Parika | $5,000 |

**Quoted and agreed before the car is booked**, exactly like a delivery
charge. `book_taxi` called the first time returns the figure and the words to
read back; called again with `fare_confirmed` it books. Nothing is booked on
a fare the passenger has not heard.

```
The fare Stabroek to Campbellville is $500, payable to the driver.
Waiting after pickup is charged separately.
```

The driver's card carries the same figure, so there is one number in the
conversation:

```
*Fare $500* — the passenger has been told this. Collect it from them.
⏱ *Waiting:* $800 per 30 min — part of a block counts as a whole one.
```

**A trip the tariff cannot place has no fare**, and falls back to the driver
agreeing it with the passenger — which is what every taxi did before this.
Better that than inventing a figure for a place the shop cannot name.

**The fare is not counted as cash the shop is owed.** It lives in its own
column, not in the order's total, because `cash` sums totals to tell an
associate what to hand in — and whether any part of a taxi fare is handed in
is a question nobody has answered yet. Waiting is extra and is settled the
same way.

### What it shares with everything else

- **Nobody on duty, no booking.** The customer is told plainly, and no car or
  time is promised.
- **Offered to every free associate**; the first to accept takes it.
- A taxi **nobody was free for waits** and is offered again the moment an
  associate clocks on or finishes a job — the same queue a parcel waits in.
- The whole trail is recorded: booked, accepted, uplifted, closed, by number.

---

## 9. Money

Everything is cash on delivery unless `PAYMENT_METHODS` says otherwise.

| | Paid | Counted against |
|---|---|---|
| Grocery, restaurant | at the door, by whoever receives it | whoever **delivered** it |
| Parcel | at the pickup, by the sender | whoever **uplifted** it |
| Taxi | in the car, at a fare the driver agreed | **nothing** — the shop never priced it |

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

## 10. Settings

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
| `FREE_DELIVERY_OVER` | 0 | Waives it above this subtotal, **groceries only** |
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

### Photographs

**The aisle marks what can be seen.** An item with a picture carries a camera,
so a customer knows what to ask for:

```
(a) Bananas — $420 (per kg) 📷
(b) Bora — $320 (bundle) 📷
(c) Callaloo — $280 (bundle) 📷
(d) Carrots — $580 (per kg)

Put the quantity beside the letter, like *a x2, d x1*.
Say the word for a photo of any of the 📷 ones.
```

> **customer:** "show me the bora"

```
[ photo ]  Bora — $320 / bundle
```

**It offers rather than waiting to be asked**, and sends one unprompted where
it would settle something — two items easily confused, a size hard to picture,
anything a customer hesitates over. A picture answers *"is that the big bag?"*
better than a sentence about grams.

**It never offers one that does not exist.** Only the marked items have a
picture; promising one and then taking it back makes a shop look like it is
losing things. Where there is none it describes the item in a few words and
moves on. Search results carry the same flag.

One photo to a message, so two or three in a row at most — a screen filling
with pictures is a screen nobody can shop from.



`show_product_photo` works and the catalogue has none, which is the single
cheapest thing that would make the shop feel finished.

**Photograph the shelf and send it to the shop.** From a staff number, send
the picture with the SKU as its caption:

```
[photo of the bora]  "photo VEG-006"

  📸 Saved the photo for *Bora* (VEG-006).
  1 of 72 products now have one.
```

Take it again and it replaces the first — a shopkeeper who photographs the
tomatoes twice means the second one. A SKU that does not exist is refused
rather than written to a file nothing will ever read:

```
"photo VEG-999"

  No product with SKU *VEG-999*.
  Check it against the list from `npm run photos:wanted`…
```

**A photo with no caption is still a menu being onboarded.** The caption is
the whole disambiguation and has to be: a laminated menu and a bag of rice
are both just a photo from the shop's own number.

**Photos live on disk**, on the host's persistent disk where deploys cannot
reach and git cannot write — which is why sending them in matters. Dropping
`RIC-001.jpg` into the folder works too if you have one. A URL in the
catalogue CSV wins where there is one; the folder is the fallback.

**`PUBLIC_BASE_URL` has to be set** or nothing is ever shown: without it the
photo has no address to give WhatsApp, and the picture is silently skipped.
On Render it falls back to `RENDER_EXTERNAL_URL`, which the host sets itself.
Saving a photo while it is unset says so.

```
npm run photos:wanted
```

prints what is still missing, aisle by aisle in the order somebody walks the
shop, with the filename to save each one under — and writes the same list to
`data/photos-wanted.csv` for carrying on a phone.

```
npm run photos:find
```

looks for matches on Open Food Facts, which is an open database of **branded
packaged goods**. That is the catch: this shop sells bora, callaloo, plantain,
snapper and tennis rolls, and a database of packaged brands does not hold a
photograph of them. A whole-catalogue run found nothing it would apply.

It does hold some — a Tennis Roll, a callaloo — that the scorer rated too low
to propose. Every candidate is now written to `data/photo-candidates.csv`
whatever it scored, so a person can see the near-misses and accept the right
ones. The bar for applying a photo automatically is unchanged: a wrong photo
is worse than none, and a customer shown a ketchup bottle for tomatoes trusts
nothing else on the screen.

To see every card for all three kinds of business side by side, run
`node cards-gallery.ts`. It drives the real notify and dispatch functions and
prints what they hand to WhatsApp, so it is the message rather than a
description of one.

And for the other side of it — what the customer sees, from hello to the
receipt — run `node customer-view.ts`. One grocery order: shopping by number,
a delivery asked for after five, and every status message as it arrives. Both
scripts work on a throwaway database and cannot touch real trading data.

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

### The pin is always on the card

**If a pin was sent for a delivery, the card carries it** — beside the
written address, not instead of it.

| What the order has | What the card shows |
|---|---|
| An address | the address |
| A pin only | the pin's label and the link |
| An address and a pin | **both** |
| Neither | ⚠️ *NO PIN — ring before you set off* |

It used to be one or the other, and the address won. The reasoning was that
two ways to one door leave an associate deciding which to believe: the
address is what the customer *meant*, the pin is where they happened to be
standing.

That reasoning is spent. Checkout now asks for the pin **as the door**, in
those words — *“send your exact spot so the associate comes straight to your
door”* — so a pin on an order is a deliberate answer rather than an accident
of geography. Suppressing it threw away the better of the two directions and
left somebody reading a lot number for a house they could have been driven
to.

The pin does its other work regardless: it silences the NO PIN warning, and
it is what the out-of-area check measures, so an associate is still told
when a drop is beyond the delivery area.

This applies to a parcel's destination and to an order going to somebody
else, including one where the buyer deliberately shared a pin for the
recipient's door.

### The dispatch map

Every open job on one page, at **`/dispatch?key=…`**, behind the same token
the backup downloads use. Red is pending, amber confirmed, blue ready, green
on the way; a job waiting three quarters of an hour draws bigger and
heavier. Tapping a pin gives the order number, the customer, the address,
their number as a dialable link, the figure to collect, how long it has
waited and who has it.

Under the map, the same jobs as a list — which is where **`no pin — ring
before setting off`** shows up, because a job with no pin cannot be on a map
and is exactly the one somebody needs to see.

It refreshes itself every twenty seconds and fits the view to the work on
its first load, so a morning with three drops on the East Coast looks like
three drops on the East Coast.

**Delivered work is on it too.** A dropdown in the header — *off, today, 7
days, 30 days* — draws every finished delivery as a small grey dot, with the
count and what they came to beside it: *5 delivered · $21,000*. Tapping one
gives the order, the customer, the address, the figure and when it landed.

That is the same map asked a different question. The coloured pins are what
is left to do; the grey ones are where the business actually is — which
streets carry it, which village is worth an associate based nearby, and
whether a corridor of the tariff is earning anything at all.

They are drawn under the live pins, never over them, and the view still fits
itself to the open work. The query is bounded twice, by days and by count,
because this is the one thing on the page that grows for ever: a shop two
years in has tens of thousands of these, and a page that tries to draw all
of them is a page that stops opening on the phone it is needed on. Only
deliveries with a pin appear — inventing one from a written address would
put a dot on a village centre and call it a doorstep.

**It does not track anybody, and will not pretend to.** WhatsApp never sends
a business number a moving location — only the single pin a customer chose
to share — so what the map honestly knows is where each job is going, where
it is coming from, and how long it has been waiting.

**Treat the link as the password.** The page prints customer names,
addresses and telephone numbers, which is what makes it useful and what
makes it dangerous: it shares `BACKUP_TOKEN` rather than inventing a second
secret, returns **404** without it, and is marked no-store and noindex. If
the link goes anywhere it should not, rotate that token.

**`npm run map:check`** proves it without eyeballs: twenty-four checks
against a throwaway shop on a spare port — that no key, a wrong key and a
wrong key of the right length are all 404, that the data endpoint is shut
too, that the page is no-store and noindex, that an unpinned job is counted
rather than drawn, that the history window is off unless asked and capped at
ninety days. `/health` reports `dispatchMap: true` when the map is mounted,
because from outside a missing token and one too short to be a password look
identical.

Tiles come from OpenStreetMap. Their public tile service is fine for a
dispatcher opening a page a few times a day and is not for heavy traffic; a
shop that leaves this open on a screen all day should put a free MapTiler or
Stadia key behind it.

### The cash, and what it is made of

The associate's card ends with the figure to collect and the figure broken
down, because the associate is the one asked to justify it at a gate:

```
*Collect $3,700 cash* from the customer
$3,200 food + $500 delivery
```

It said `(2 items + delivery)` before — a description of a receipt rather than
a receipt. Somebody asked *"why is it three thousand seven hundred?"* got an
answer that did not add up to anything.

It says **food** for a restaurant order and **goods** for a grocery one, and
where there is no delivery charge it says so rather than printing a zero:

```
*Collect $1,900 cash* from the customer
$1,900 goods, delivery free
```

The split, not the item prices. The customer's own receipt itemises it
afterwards, and a card held in one hand at a gate should answer the question
actually asked — what is the delivery costing me — in one line. The item list
higher up the card stays a list of things to check in the bag.

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
Order ORD-00042 delivered.          ← it arrived
Delivery code: confirmed.

🧾 *Receipt* — 17 Nov, 16:47        ← the receipt, dated at the doorstep

1 x Goat Curry — $2,700
1 x Plain Rice _Large_ — $500

Goods $3,200
Delivery $500
*Total $3,700* — paid in cash

Thank you for choosing Next Minute Delivery!     ← the shop's thanks
Enjoy your meal, see you next time! 👋           ← one of seven wishes
```

**The time on it is the time of delivery**, not the time the order was placed.
A receipt is dated when the money changed hands, which on a delivery is the
doorstep: an order placed at ten to eight and delivered at half past nine used
to carry a receipt saying 7:50, which is neither when they paid nor when they
got it.

It is read from the order's own trail rather than kept on the order, because
the trail cannot be overwritten — `updated_at` moves on every status change,
so an order touched afterwards would be dated the last time anybody typed
about it. A parcel that came back and went out again is dated the second time.

**The delivery line first, then the receipt.** The line a customer is waiting
for is the one saying it arrived; a receipt is what you are handed afterwards,
not something to scroll past to find out whether your delivery is done.

**No delivery charge, no delivery line.** Where the fee is zero the split is
dropped and only the total is printed: `Goods $3,200` above `Total $3,200` is
the same figure twice, and `Delivery $0` reads like a question rather than an
answer.

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

**The manners go last**, so the useful part is not something to scroll past
the thanks to reach. The receipt carries no order number of its own — the line
directly above it already says `Order ORD-00042 delivered`, and the same
reference twice in one message is a line read, checked against the other, and
trusted less.

**No padded columns.** WhatsApp renders a plain message in a proportional
font, so figures lined up with spaces arrive ragged on a phone. The label goes
in front of each figure instead, which reads the same in any font.

All of it exists in English, Spanish, Portuguese and Chinese.

| Kind | Thanked for | Wishes |
|---|---|---|
| Grocery | shopping with us | 5, about the day |
| Restaurant | choosing the shop | 7, about the meal |
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
| `MAX_JOBS_PER_ASSOCIATE` | 1 | How many jobs one associate may hold. 0 = no limit, which is what this shop runs |
| `ASSOCIATE_DUTY_HOURS` | 12 | A shift lapses this long after clocking on |
| `ASSOCIATE_MAX_HOURS_PER_DAY` | 12 | The rolling 24-hour cap. 0 = off |
| `ASSOCIATE_RADIUS_MILES` | 0 | Only offer jobs within this far of a shared pin. 0 = everybody |
| `DISPATCH_BAND_MINUTES` | 5 | A drop-off this recent means they are in that band now |
| `DISPATCH_BAND_WAIT_SECONDS` | 20 | Before the offer widens to the corridor |
| `DISPATCH_CORRIDOR_MINUTES` | 10 | A drop-off this recent means they are on that road |
| `DISPATCH_CORRIDOR_WAIT_SECONDS` | 15 | Before the offer widens to everybody |

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

## 11. Running it day to day


### The type check is part of the suite

```powershell
npm run smoke
```

runs `tsc --noEmit` first and stops if it fails. Ten seconds, and it closes a
hole the 2,955 checks could not: **a property that does not exist reads as
`undefined`**, and `undefined` is a perfectly good value for the code around
it to carry on with.

Two faults in one day came from exactly that, and both were live before a
test caught them:

- `customer.deliveryZone` on the identity record, which has no such field.
  The `undefined` read as *"this shop does not price by zone"*, and every
  stale pin went straight through the check written to stop them.
- `e.kind` and `e.by` on an order event, which carries `e.event` and
  `e.actor`. The "have they been told already?" test was always false, so the
  question came back every time.

Neither is a logic error. Both are a name that is not there, and `tsc` finds
them in a second each.

`npm run smoke:only` skips the type check, for when you are mid-edit and want
the suite anyway.

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

## 12. What is recorded

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
