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
priced from the zone already on their record:

```
⭐ *+180 points* on this delivery.
You have *180 points* — *820 to go* for $500 off.
About 5 more deliveries to Diamond.
```

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

English, Spanish, Portuguese and Chinese, chosen from how they write and kept
for the whole order — including the menu. **Staff, associates and kitchens
always work in English.**

### Taxi

First on the menu. There is no catalogue and no cart — two ends and a
passenger — and the delivery associates drive these themselves. The full
journey is [chapter 8](#8-taxis); this is what the customer sees.

```
*1.* Taxi
*2.* Grocery shopping
*3.* Restaurant ordering
*4.* Parcel delivery
*5.* Other
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

**Zones, not kilometres.** Vreed-en-Hoop is five kilometres from Stabroek
across the water and twenty-five by road. Straight-line distance under-prices
exactly the trips that cost most, and the west side is priced from the bridge.

**The place is confirmed before the price is said.** The agent looks up what
the customer wrote, reads the matched name back — *"that's Diamond on the East
Bank, is that right?"* — and only then is the figure quotable. The tool will
not hand over a fee until that has happened, and will not accept a place name
the shop never offered.

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

### The journey

| Step | Who | What the passenger is told |
|---|---|---|
| Booked | The agent, on the customer's yes | The job number, and that a car is being found |
| Accepted | **An associate**, tapping Accept | *A driver is on the way to collect you*, with the safety code |
| Uplifted | The associate, when the passenger is in the car | *You are on your way* |
| Dropped off | The associate, tapping Delivered | *Trip complete — you have arrived* |
| Nobody there | The associate, at the pickup | *The driver could not find you* |

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

**$800 per 30 minutes, and it starts once the passenger is in the car.**

Waiting is the car stopped at the passenger's request — the pharmacy, a gate,
somebody running in for five minutes — not the time before pickup. There is no
free period, and **part of a block counts as a whole one**: a driver who has
stopped is a driver not earning.

| Waited in total | Charge |
|---|---|
| 2 min | $800 |
| 30 min | $800 |
| 31 min | $1,600 |
| 61 min | $2,400 |

**Two taps, no numbers.** The driver taps *Waiting* when the car stops and
*Moving* when it goes again; the shop times it. While a stop is open, *Moving*
is the only button on the card — anything else would be a way to end the trip
with the clock still running.

```
Wayne ▸ 19 waiting
Wayne ◂ ⏱ Waiting from 18:26. Tap when you move off.
        ⏱ *Waiting:* $800 per 30 min — part of a block counts as a whole one.

Wayne ▸ 19 moving
Wayne ◂ ⏱ 12 min waited, 12 in total — *$800* so far.
```

**Totalled across the trip, not per stop.** Twelve minutes at the pharmacy and
eight at a gate is twenty minutes — one block, $800. Charging each stop its own
block would make the same twenty minutes $1,600 and give a driver a reason to
tap twice instead of once.

```
Wayne ◂ TXI-00019 → *delivered*.
        Customer notified.
        ⏱ Waited 20 min in total — *$800* to add to the fare.
```

**A forgotten clock is closed at the drop.** A trip cannot end with one still
running: the drop is when the car stopped being theirs to wait in.

**Rounded down**, each stop. The figure decides money, so a driver tapping a
few seconds late should not push a passenger into the next block.

**The passenger is told none of this.** The shop sets no fare, so it must not
publish half of one — the driver states the waiting rate when the fare is
agreed. Nothing is charged before pickup, and waiting is refused on a trip
that has not started.

### No fare, anywhere

The shop does not meter rides. **The driver agrees the fare with the
passenger**, and no figure is printed on any message, card or receipt:

- The passenger's messages name no amount at all; the one in the car says the
  fare is agreed with the driver.
- The associate's card says *Fare not set — agree it with the passenger*.
- The dispatch desk's card says the same.
- **There is no receipt at the end.** A ride the shop never priced has nothing
  to put on one, and `Total $0 — paid in cash` is a lie with a figure in it.

A taxi is counted in no cash total for the same reason: nothing passed through
the shop.

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

Thank you for ordering from A Taste of Guyana!   ← thanks, by kind
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
